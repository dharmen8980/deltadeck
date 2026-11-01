"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRoute } from "@/hooks/use-route";
import { api, ApiError, errorMessage } from "@/lib/api";
import { HIGHLIGHT_MAX_BYTES, parseLineHash } from "@/lib/code-lines";
import { cn } from "@/lib/utils";
import { useFileChange } from "@/components/changes/changes-context";
import { useLineMarks } from "@/components/changes/use-line-marks";
import { useFindId, useFindSource } from "@/components/find/use-find-source";
import { CodeLines } from "./code-viewer";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { TextViewer } from "./text-viewer";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const PAGE = 100;
const ExpandCtx = createContext<{ mode: "default" | "all" | "none" }>({ mode: "default" });

function Primitive({ value }: { value: Json }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof value === "boolean") return <span className="text-violet-600 dark:text-violet-400">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>;
  return (
    <span className="break-all whitespace-pre-wrap text-emerald-700 dark:text-emerald-400">
      &quot;{value as string}&quot;
    </span>
  );
}

const JsonNode = memo(function JsonNode({
  name,
  value,
  depth,
  last,
}: {
  name: string | number | null;
  value: Json;
  depth: number;
  last: boolean;
}) {
  const { mode } = useContext(ExpandCtx);
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(mode === "all" ? true : mode === "none" ? depth === 0 : depth < 2);
  const [shown, setShown] = useState(PAGE);

  const label =
    name === null ? null : (
      <span className="text-rose-700 dark:text-rose-300">
        {typeof name === "number" ? name : `"${name}"`}
        <span className="text-muted-foreground">: </span>
      </span>
    );

  if (!isObj) {
    return (
      <div className="pl-5">
        {label}
        <Primitive value={value} />
        {last ? null : <span className="text-muted-foreground">,</span>}
      </div>
    );
  }

  const isArr = Array.isArray(value);
  const entries: [string | number, Json][] = isArr
    ? (value as Json[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, Json>);
  const [openB, closeB] = isArr ? ["[", "]"] : ["{", "}"];

  return (
    <div className={depth === 0 ? "" : "pl-5"}>
      <div className="-ml-5 flex items-start">
        <button
          type="button"
          className="mt-0.5 mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse" : "Expand"}
          disabled={entries.length === 0}
        >
          {entries.length ? <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} /> : null}
        </button>
        <span>
          {label}
          <span className="text-muted-foreground">{openB}</span>
          {!open || entries.length === 0 ? (
            <>
              {entries.length ? (
                <button
                  type="button"
                  className="mx-1 rounded bg-muted px-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setOpen(true)}
                >
                  {entries.length} {isArr ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}
                </button>
              ) : null}
              <span className="text-muted-foreground">
                {closeB}
                {last ? "" : ","}
              </span>
            </>
          ) : null}
        </span>
      </div>
      {open && entries.length ? (
        <>
          {entries.slice(0, shown).map(([k, v], i) => (
            <JsonNode key={k} name={isArr ? (k as number) : k} value={v} depth={depth + 1} last={i === entries.length - 1} />
          ))}
          {entries.length > shown ? (
            <div className="pl-5">
              <Button size="xs" variant="outline" className="my-1" onClick={() => setShown((s) => s + PAGE)}>
                Show {Math.min(PAGE, entries.length - shown)} more ({entries.length - shown} hidden)
              </Button>
            </div>
          ) : null}
          <div className="text-muted-foreground">
            {closeB}
            {last ? "" : ","}
          </div>
        </>
      ) : null}
    </div>
  );
});

export function JsonViewer({ file, reloadKey }: ViewerProps) {
  const { hash } = useRoute();
  const lineTarget = parseLineHash(hash) !== null;
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.content(file.path, signal));
  const [tab, setTab] = useState<string | null>(null);
  const [expand, setExpand] = useState<{ mode: "default" | "all" | "none"; gen: number }>({ mode: "default", gen: 0 });
  const [pretty, setPretty] = useState<boolean | null>(null);
  // Find in the tree: its rendered text (the Source tab searches the whole text). With nodes
  // collapsed, the note says how many matches the source text has beyond the ones shown.
  const treeRef = useRef<HTMLDivElement>(null);
  const findId = useFindId();
  const findText = useRef({ text: "", version: 0 });
  useFindSource(
    () => ({
      kind: "dom",
      root: () => treeRef.current,
      note: async (q, total) => {
        if (!treeRef.current?.querySelector('button[aria-label="Expand"]')) return undefined;
        const { runFind } = await import("@/lib/find/run");
        const t = findText.current;
        const r = await runFind(`json:${findId}:${t.version}`, t.text, q.query, q.options);
        const n = r.starts.length;
        if (r.error || n <= total) return undefined;
        return `${n.toLocaleString()}${r.capped ? "+" : ""} in the source; collapsed nodes are not searched: Expand all, or use Source`;
      },
    }),
    [findId],
  );

  const parsed = useMemo(() => {
    if (!data) return null;
    try {
      return { ok: true as const, value: JSON.parse(data.text) as Json };
    } catch (e) {
      return { ok: false as const, error: errorMessage(e) };
    }
  }, [data]);

  const original = data?.text ?? "";
  useEffect(() => {
    if (findText.current.text !== original) findText.current = { text: original, version: findText.current.version + 1 };
  }, [original]);
  const multiLine = original.trimEnd().includes("\n");
  const usePretty = pretty ?? (!multiLine && !lineTarget);
  const source = useMemo(() => {
    if (!parsed?.ok || !usePretty) return original;
    return JSON.stringify(parsed.value, null, 2);
  }, [parsed, usePretty, original]);

  // Changes since the last view, on the source: the banner's diff for the original text; the
  // pretty-printed view compares both versions pretty-printed (an earlier copy that does not
  // parse gets no marks there).
  const fc = useFileChange();
  const changedBase = fc?.changed ? (fc.baseText ?? null) : null;
  const prettyBase = useMemo<string | null | undefined>(() => {
    if (!parsed?.ok || !usePretty) return undefined;
    if (changedBase === null) return null;
    try {
      return JSON.stringify(JSON.parse(changedBase), null, 2);
    } catch {
      return null;
    }
  }, [parsed, usePretty, changedBase]);
  const marks = useLineMarks(source, {
    base: prettyBase,
    words: source.length <= HIGHLIGHT_MAX_BYTES,
    skip: !parsed?.ok,
  });

  // A changed file opens on the source, where the changes are marked (the tree has no marks). Decided
  // once per open: neither Mark as seen nor a live change while reading switches the tab.
  const [first, setFirst] = useState<{ path: string; text: string; source: boolean } | null>(null);
  if (data && (!first || first.path !== file.path)) setFirst({ path: file.path, text: data.text, source: false });
  else if (first && !first.source && tab === null && data?.text === first.text && fc?.changed) setFirst({ ...first, source: true });
  const autoSource = Boolean(first && first.path === file.path && first.source);

  if (error instanceof ApiError && error.status === 413) return <TextViewer file={file} reloadKey={reloadKey} />;
  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading /> : null;
  }
  if (parsed && !parsed.ok) {
    return (
      <div>
        <div className="no-print border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          Not valid JSON ({parsed.error}); showing as text.
        </div>
        <TextViewer file={file} reloadKey={reloadKey} />
      </div>
    );
  }

  const activeTab = tab ?? (lineTarget || autoSource ? "source" : "tree");

  return (
    <Tabs value={activeTab} onValueChange={setTab} className="gap-0">
      <div className="no-print sticky top-[var(--header-h,3.5rem)] z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-1.5 backdrop-blur">
        <TabsList>
          <TabsTrigger value="tree">Tree</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
        </TabsList>
        {activeTab === "tree" ? (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setExpand((e) => ({ mode: "all", gen: e.gen + 1 }))}>
              <ChevronsUpDownIcon /> Expand all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setExpand((e) => ({ mode: "none", gen: e.gen + 1 }))}>
              <ChevronsDownUpIcon /> Collapse all
            </Button>
          </div>
        ) : parsed?.ok ? (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant={usePretty ? "ghost" : "secondary"} onClick={() => setPretty(false)}>
              Original
            </Button>
            <Button size="sm" variant={usePretty ? "secondary" : "ghost"} onClick={() => setPretty(true)}>
              Pretty-printed
            </Button>
          </div>
        ) : null}
      </div>
      <TabsContent value="tree" className="overflow-x-auto px-6 py-4 font-mono text-[13px] leading-relaxed">
        {parsed?.ok ? (
          <ExpandCtx.Provider value={{ mode: expand.mode }}>
            <div ref={treeRef} className="pl-5">
              <JsonNode key={expand.gen} name={null} value={parsed.value} depth={0} last />
            </div>
          </ExpandCtx.Provider>
        ) : null}
      </TabsContent>
      <TabsContent value="source">
        <CodeLines code={source} lang={source.length <= HIGHLIGHT_MAX_BYTES ? "json" : null} marks={marks} />
      </TabsContent>
    </Tabs>
  );
}
