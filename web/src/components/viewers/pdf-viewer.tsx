"use client";

import { useRef } from "react";
import { useFindSource } from "@/components/find/use-find-source";
import { rawUrl } from "@/lib/api";
import { NO_FIND_PDF, type ViewerProps } from "./common";

export function PdfViewer({ file, reloadKey }: ViewerProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  useFindSource(() => ({ kind: "none", root: () => ref.current, message: NO_FIND_PDF }), []);
  return (
    <iframe
      ref={ref}
      key={`${file.path}:${reloadKey}`}
      title={file.name}
      src={rawUrl(file.path)}
      className="block h-[calc(100svh-3.5rem)] w-full border-0 bg-muted"
    />
  );
}
