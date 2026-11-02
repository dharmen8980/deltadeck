// Completion sources added to every editor language, next to the language's own (scope names,
// keywords, CSS properties, HTML tags): words of the document, names from the project's search
// index (/api/complete) and, in markdown, link targets and heading anchors. Name-based only.

import { completeAnyWord, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { EditorState, type Extension } from "@codemirror/state";
import { api, type TreeResponse } from "@/lib/api";
import { linkPathOptions, linkTargetAt, markdownHeadings, NAME_LIMIT, NameCache, resolveLinkFile, type Heading } from "@/lib/complete";
import type { EditorLang } from "@/lib/editor-lang";

/** What the sources need from the editor pane (read when a completion runs). */
export interface CompleteEnv {
  /** the open file, root-relative */
  path: () => string;
  tree: () => TreeResponse | null;
}

/** words pop up while typing only in code; in prose Enter would take a word instead of a new line */
const PROSE = new Set<EditorLang>(["markdown", "plain"]);

function wordBefore(ctx: CompletionContext) {
  const chars = ctx.state.languageDataAt<string>("wordChars", ctx.pos)[0] ?? "";
  return ctx.matchBefore(new RegExp(`[\\p{L}\\p{N}_${chars.replace(/[\\\]^-]/g, "\\$&")}]+$`, "u"));
}

function inCommentOrString(ctx: CompletionContext): boolean {
  return /comment|string/i.test(syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name);
}

function wordsAndNames(lang: EditorLang, env: CompleteEnv, cache: NameCache): CompletionSource {
  const prose = PROSE.has(lang);
  return async (ctx) => {
    const word = wordBefore(ctx);
    if (!ctx.explicit && (prose || !word || word.to - word.from < 2 || inCommentOrString(ctx))) return null;
    const typed = word?.text ?? "";
    const seen = new Set([typed]);
    const options: Completion[] = [];
    const local = completeAnyWord(ctx) as CompletionResult | null;
    for (const o of local?.options ?? []) {
      if (o.label.length < 3 || seen.has(o.label) || /^\d/.test(o.label)) continue;
      seen.add(o.label);
      // no type: the list then merges it with the same name from the language's scope source
      options.push({ label: o.label });
    }
    let complete = true;
    if (typed.length >= 2 && typed.length <= 64) {
      let hit = cache.get(typed);
      if (!hit) {
        // CodeMirror already waits for a typing pause before asking; typing on (a newer prefix)
        // or closing the list cancels this request
        const ctrl = new AbortController();
        ctx.addEventListener("abort", () => ctrl.abort(), { onDocChange: true });
        try {
          const r = await api.complete({ prefix: typed, path: env.path(), limit: NAME_LIMIT }, ctrl.signal);
          cache.set(typed, r.names, NAME_LIMIT, r.capped);
          hit = cache.get(typed);
        } catch {
          if (ctx.aborted) return null;
          cache.set(typed, []); // no index or no server: don't ask again for a minute
        }
      }
      complete = hit?.complete ?? true;
      (hit?.names ?? []).forEach((n, i, all) => {
        if (seen.has(n.name)) return;
        seen.add(n.name);
        // below the document's words; the server's order among equal matches
        options.push({ label: n.name, detail: n.def ? "def" : undefined, boost: (n.def ? -1 : -2) + (all.length - i) / all.length / 2 });
      });
    }
    if (!options.length) return null;
    return { from: word ? word.from : ctx.pos, options, validFor: complete ? /^[\p{L}\p{N}_$-]*$/u : undefined };
  };
}

/** keeps the list in the order given (document order, nearest first) among equal matches */
const rank = (i: number, n: number) => (n - i) / n;

function markdownLinks(env: CompleteEnv): CompletionSource {
  const headings = new Map<string, Heading[]>(); // other documents, by path, mtime and size
  return async (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const target = linkTargetAt(line.text.slice(0, ctx.pos - line.from));
    // not in code, and not over a URL being typed ("](https:")
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target.typed)) return null;
    for (let n: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent)
      if (/^(FencedCode|CodeBlock|InlineCode)$/.test(n.name)) return null;
    const from = ctx.pos - target.typed.length;
    const self = env.path();
    const tree = env.tree();
    if (target.kind === "path") {
      if (!tree) return null;
      const { options, capped } = linkPathOptions(tree.files, self, target.typed);
      return {
        from,
        options: options.map((o, i) => ({ label: o.label, type: o.markdown ? "text" : undefined, boost: rank(i, options.length) })),
        validFor: capped ? undefined : /^[^\s()<>"'#]*$/,
      };
    }
    let list: Heading[];
    const file = target.file ? resolveLinkFile(self, target.file) : self;
    if (file === null) return null;
    if (file === self) list = markdownHeadings(ctx.state.sliceDoc());
    else {
      const f = tree?.files.find((x) => x.path === file);
      if (!f || f.kind !== "markdown") return null;
      const key = `${f.path}\n${f.mtime}\n${f.size}`;
      const cached = headings.get(key);
      if (cached) list = cached;
      else {
        const ctrl = new AbortController();
        ctx.addEventListener("abort", () => ctrl.abort());
        try {
          list = markdownHeadings((await api.content(f.path, ctrl.signal)).text);
        } catch {
          return null;
        }
        if (headings.size >= 20) headings.delete(headings.keys().next().value as string);
        headings.set(key, list);
      }
    }
    return {
      from,
      options: list.map((h, i) => ({ label: h.slug, detail: h.text, type: "property", boost: rank(i, list.length) })),
      validFor: /^[^\s()<>"'#]*$/,
    };
  };
}

/** The extra sources for `lang` (goes in the editor's language compartment). */
export function completionSources(lang: EditorLang, env: CompleteEnv): Extension {
  const sources = [wordsAndNames(lang, env, new NameCache())];
  if (lang === "markdown") sources.unshift(markdownLinks(env));
  return EditorState.languageData.of(() => sources.map((autocomplete) => ({ autocomplete })));
}
