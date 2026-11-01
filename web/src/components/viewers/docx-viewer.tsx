"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Components } from "react-markdown";
import { toJsxRuntime, type Components as JsxComponents } from "hast-util-to-jsx-runtime";
import { DownloadIcon, ImageOffIcon } from "lucide-react";
import { useFileChange } from "@/components/changes/changes-context";
import { useFindSource } from "@/components/find/use-find-source";
import { TocInline, TocPanel, type TocHeading } from "@/components/toc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHighlight } from "@/hooks/use-highlight";
import { useRoute } from "@/hooks/use-route";
import { api, errorMessage, rawUrl, type DocxResponse } from "@/lib/api";
import { parseLineHash } from "@/lib/code-lines";
import { blockMarks, normalizeText, type ChangeMarks } from "@/lib/diff";
import { DOC_SKIP } from "@/lib/find/skip";
import { docxTree } from "@/lib/docx-hast";
import { rehypeChangeMarks } from "@/lib/rehype-change-marks";
import { stickyScroll } from "@/lib/sticky-scroll";
import { useAsync, ViewerError, ViewerLoading, type ViewerProps } from "./common";
import { ARTICLE_CLASS, markdownComponents, type MarkdownComponentOptions } from "./markdown-viewer";

/**
 * The markdown viewer's components, with images of a converted .docx: embedded ones arrive as
 * data URLs (checked in lib/docx-hast.ts); any image without one was left out by the server.
 */
export function docxComponents(docPath: string, opts: MarkdownComponentOptions = {}): Components {
  return {
    ...markdownComponents(docPath, opts),
    img({ src, alt }) {
      if (typeof src === "string" && src.startsWith("data:image/")) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={src} alt={alt ?? ""} decoding={opts.print ? "sync" : "async"} className="md-image mx-auto max-w-full rounded" />;
      }
      return (
        <span
          className="docx-image-omitted not-prose inline-flex max-w-full items-center gap-1.5 rounded border border-dashed px-2 py-1 align-middle text-xs text-muted-foreground"
          title="Linked, oversized and non-web image formats are not shown"
        >
          <ImageOffIcon className="size-3.5 shrink-0" />
          <span className="truncate">image not shown{alt ? `: ${alt}` : ""}</span>
        </span>
      );
    },
  };
}

/** The converted document as React elements (view-only); `marks` as in MarkdownMarkup. */
export function DocxMarkup({
  data,
  components,
  marks,
}: {
  data: DocxResponse;
  components: Components;
  marks?: ChangeMarks | null;
}) {
  return useMemo(() => {
    const tree = docxTree(data.html ?? "", data.blocks);
    if (marks) rehypeChangeMarks(marks)()(tree);
    return toJsxRuntime(tree, {
      Fragment,
      jsx,
      jsxs,
      components: components as JsxComponents,
      ignoreInvalidStyle: true,
      passKeys: true,
      passNode: true,
    });
  }, [data, components, marks]);
}

function Notes({ data, file }: { data: DocxResponse; file: ViewerProps["file"] }) {
  const notes = [
    data.truncated ? "Long document: only the beginning is shown." : null,
    data.images_dropped
      ? `${data.images_dropped} image${data.images_dropped === 1 ? "" : "s"} not shown (linked, too large or not a web format).`
      : null,
    ...data.warnings,
  ].filter((n): n is string => Boolean(n));
  return (
    <div className="no-print mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span title="Converted for reading: page layout, fonts, colours, headers, footers, comments and tracked changes are not shown. View-only.">
        Word document, view-only
      </span>
      {data.truncated ? <Badge variant="secondary">truncated</Badge> : null}
      {notes.length ? (
        <Badge variant="outline" title={notes.join("\n")}>
          {notes.length} conversion note{notes.length === 1 ? "" : "s"}
        </Badge>
      ) : null}
      <Button asChild size="sm" variant="ghost" className="ml-auto h-7 text-xs">
        <a href={rawUrl(file.path)} download={file.name}>
          <DownloadIcon /> Download .docx
        </a>
      </Button>
    </div>
  );
}

export function DocxViewer({ file, reloadKey }: ViewerProps) {
  const { data, error, loading } = useAsync(file.path, reloadKey, (signal) => api.docx(file.path, signal));
  const { hash, hl, hll, navigate, setHash } = useRoute();
  const articleRef = useRef<HTMLElement>(null);
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [words, setWords] = useState(0);
  const docPath = file.path;
  const fc = useFileChange();
  const changed = fc?.changed ?? false;
  const markdownDiff = fc?.markdownDiff ?? null;
  const comparedText = fc?.currentText ?? null;
  // Highlights only when the controller compared the very markdown shown here (both fetch it).
  const marks = useMemo(
    () =>
      changed && markdownDiff && comparedText !== null && data && normalizeText(data.markdown) === normalizeText(comparedText)
        ? blockMarks(markdownDiff)
        : null,
    [changed, markdownDiff, comparedText, data],
  );

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id) ?? document.getElementById(`user-content-${id}`);
    if (el) el.scrollIntoView({ block: "start" });
  }, []);

  const selectHeading = useCallback(
    (id: string) => {
      setHash(id);
      scrollToId(id);
    },
    [setHash, scrollToId],
  );

  const components = useMemo<Components>(
    () => docxComponents(docPath, { selectHeading, navigate, scrollToId }),
    [docPath, navigate, selectHeading, scrollToId],
  );

  // Headings (ids from rehype-slug) for the table of contents, and the word count.
  useEffect(() => {
    const root = articleRef.current;
    if (!root || !data) return;
    const hs = Array.from(root.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id]")).map((el) => ({
      id: el.id,
      text: (el.textContent ?? "").trim(),
      level: Number(el.tagName.slice(1)),
    }));
    setHeadings(hs);
    setWords((root.textContent ?? "").split(/\s+/).filter(Boolean).length);
  }, [data]);

  // Scroll to the heading named in the URL hash (initial load and back/forward).
  const scrolledFor = useRef<string>("");
  useEffect(() => {
    if (!data || !hash || parseLineHash(hash) !== null) return;
    const key = `${file.path}#${hash}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const root = articleRef.current;
    if (!root) return;
    const find = () => document.getElementById(hash) ?? document.getElementById(`user-content-${hash}`);
    let done = false;
    const stop = stickyScroll(root, () => find()?.getBoundingClientRect() ?? null, {
      onDone: () => {
        done = true;
      },
    });
    return () => {
      if (!done) scrolledFor.current = "";
      stop();
    };
  }, [data, hash, file.path]);

  useHighlight(articleRef, hl, data, hll);
  // Find in the file (components/find/): the rendered text, code blocks, tables and diagrams.
  useFindSource(() => ({ kind: "dom", root: () => articleRef.current, skip: DOC_SKIP }), []);

  if (!data) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return loading ? <ViewerLoading lines={14} /> : null;
  }

  return (
    <div className="flex justify-center gap-8 px-4 py-6 md:px-8">
      <div className="print-area min-w-0 max-w-[var(--reading-width,56rem)] flex-1">
        <Notes data={data} file={file} />
        <TocInline headings={headings} words={words} onSelect={selectHeading} />
        <article ref={articleRef} className={ARTICLE_CLASS}>
          <DocxMarkup data={data} components={components} marks={marks} />
        </article>
      </div>
      <TocPanel headings={headings} words={words} onSelect={selectHeading} />
    </div>
  );
}
