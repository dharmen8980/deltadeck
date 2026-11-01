"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "@/hooks/use-route";
import { api, ApiError, errorMessage } from "@/lib/api";
import { highlight, langForFile, type ShikiLang } from "@/lib/shiki";
import { cn } from "@/lib/utils";
import { CodeWithOutline } from "@/components/code-outline";
import { useLineMarks } from "@/components/changes/use-line-marks";
import { useFindId, useFindSource } from "@/components/find/use-find-source";
import { HIGHLIGHT_MAX_BYTES, parseLineHash, plainHtml } from "@/lib/code-lines";
import { applyCodeMarks, copyWithoutMarks, toggleRemoved } from "@/lib/code-marks-dom";
import { lineAtViewportTop } from "@/lib/find/skip";
import type { LineMarks } from "@/lib/line-marks";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { TextViewer } from "./text-viewer";

/**
 * Line-numbered, optionally highlighted code with `#L<n>` anchors.
 * Clicking a line number sets the hash. `marks`: the lines changed since the
 * last view (bars, tints and changed words; gutter bars only above
 * HIGHLIGHT_MAX_BYTES), applied to the rendered lines (lib/code-marks-dom.ts).
 */
export function CodeLines({
  code,
  lang,
  wrap = false,
  marks = null,
}: {
  code: string;
  lang: ShikiLang | null;
  wrap?: boolean;
  marks?: LineMarks | null;
}) {
  const { hash, setHash } = useRoute();
  const ref = useRef<HTMLDivElement>(null);
  const plain = useMemo(() => plainHtml(code), [code]);
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null);
  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) n++;
    return n;
  }, [code]);

  useEffect(() => {
    if (!lang || code.length > HIGHLIGHT_MAX_BYTES) return;
    let cancelled = false;
    highlight(code, lang, { lineNumbers: true })
      .then((html) => {
        if (!cancelled) setHighlighted({ code, html });
      })
      .catch(() => {
        /* keep plain rendering */
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  // Find in the file (components/find/): the whole text, matched line by line on the rendered lines.
  const findId = useFindId();
  const findText = useRef({ code, version: 0 });
  const findChanged = useFindSource(
    () => ({
      kind: "lines",
      root: () => ref.current,
      key: () => `${findId}:${findText.current.version}`,
      text: () => ({ text: findText.current.code }),
      lines: (root) => {
        const ls = root.querySelectorAll<HTMLElement>(".line[data-line]");
        return (n) => ls[n - 1] ?? null;
      },
      lineAtTop: (root) => {
        const el = lineAtViewportTop(root, ".line[data-line]") as HTMLElement | null;
        return el ? Number(el.dataset.line) : null;
      },
    }),
    [findId],
  );
  useEffect(() => {
    if (findText.current.code === code) return;
    findText.current = { code, version: findText.current.version + 1 };
    findChanged();
  }, [code, findChanged]);

  const html = highlighted && highlighted.code === code ? highlighted.html : plain;
  const target = parseLineHash(hash);
  const full = code.length <= HIGHLIGHT_MAX_BYTES;

  // Before paint, so the highlighted HTML replacing the plain one never shows without its marks.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !marks) return;
    return applyCodeMarks(root, marks, full);
  }, [html, marks, full]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll(".line.is-target").forEach((el) => el.classList.remove("is-target"));
    if (target === null) return;
    const el = root.querySelector<HTMLElement>(`[data-line="${target}"]`);
    if (el) {
      el.classList.add("is-target");
      el.scrollIntoView({ block: "center" });
    }
  }, [html, target]);

  const onClick = (e: React.MouseEvent) => {
    const toggle = (e.target as HTMLElement).closest<HTMLElement>(".code-removed-toggle");
    if (toggle) {
      const run = marks?.removed[Number(toggle.closest<HTMLElement>(".code-removed")?.dataset.run)];
      if (run) toggleRemoved(toggle, run);
      return;
    }
    const line = (e.target as HTMLElement).closest<HTMLElement>(".line");
    if (!line) return;
    const gutter = parseFloat(getComputedStyle(line, "::before").width || "0") || 40;
    const x = e.clientX - line.getBoundingClientRect().left;
    if (x <= gutter + 4) {
      const n = line.dataset.line;
      if (n) setHash(`L${n}`, true);
    }
  };

  // Copying never takes the marks' labels or the removed lines along.
  const onCopy = (e: React.ClipboardEvent) => {
    const root = ref.current;
    const text = root && marks ? copyWithoutMarks(root, window.getSelection()) : null;
    if (text === null) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      onCopy={onCopy}
      className={cn(
        "code-block code-lines overflow-x-auto font-mono text-[13px]",
        wrap && "[&_.line]:whitespace-pre-wrap [&_.line]:break-all",
        marks && !full && "code-marks-bars",
      )}
      style={{ ["--gutter" as string]: `${String(lineCount).length + 1}ch` }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function CodeViewer({ file, reloadKey }: ViewerProps) {
  const tooBig = file.size > HIGHLIGHT_MAX_BYTES;
  const { data, error, loading } = useAsync(
    tooBig ? "" : file.path,
    reloadKey,
    (signal) => (tooBig ? Promise.resolve(null) : api.content(file.path, signal)),
  );
  const large = tooBig || (error instanceof ApiError && error.status === 413);
  // Changes since the last view: on the code, and as dots in the outline.
  const marks = useLineMarks(large ? undefined : (data?.text ?? ""), { words: !large });
  if (large)
    return (
      <CodeWithOutline file={file} text={null} changes={marks}>
        <TextViewer file={file} reloadKey={reloadKey} marks={marks} />
      </CodeWithOutline>
    );
  if (data)
    return (
      <CodeWithOutline file={file} text={data.text} changes={marks}>
        <CodeLines code={data.text} lang={langForFile(file.name, file.ext)} marks={marks} />
      </CodeWithOutline>
    );
  if (error) return <ViewerError message={errorMessage(error)} file={file} />;
  return loading ? <ViewerLoading /> : null;
}
