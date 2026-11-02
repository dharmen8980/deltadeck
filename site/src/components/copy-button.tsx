"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={copy}
        aria-label={label}
        title={copied ? "Copied" : label}
        className="text-muted-foreground"
      >
        {copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
      </Button>
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/** A shell command in a box with a copy button. */
export function Command({ cmd, label }: { cmd: string; label?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/60 py-1.5 pr-1.5 pl-3 font-mono text-[13px] leading-6">
      <span aria-hidden className="select-none text-muted-foreground">
        $
      </span>
      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{cmd}</code>
      <CopyButton text={cmd} label={label ?? `Copy command: ${cmd}`} />
    </div>
  );
}
