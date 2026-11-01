"use client";

import { useRef } from "react";
import { DownloadIcon, FileQuestionIcon } from "lucide-react";
import { useFindSource } from "@/components/find/use-find-source";
import { Button } from "@/components/ui/button";
import { rawUrl } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/format";
import { NO_FIND_BINARY, type ViewerProps } from "./common";

export function BinaryViewer({ file }: ViewerProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFindSource(() => ({ kind: "none", root: () => ref.current, message: NO_FIND_BINARY }), []);
  return (
    <div ref={ref} className="flex flex-col items-center gap-3 p-10 text-center">
      <FileQuestionIcon className="size-10 text-muted-foreground" />
      <div>
        <div className="font-medium">{file.name}</div>
        <div className="text-sm text-muted-foreground">
          Binary file ({file.mime || "unknown type"}), {formatBytes(file.size)}, modified {formatTime(file.mtime)}
        </div>
      </div>
      <p className="max-w-md text-sm text-muted-foreground">This file type cannot be previewed.</p>
      <Button asChild variant="outline">
        <a href={rawUrl(file.path)} download={file.name}>
          <DownloadIcon /> Download
        </a>
      </Button>
    </div>
  );
}
