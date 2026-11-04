"use client";

// The eye in the sidebar header (left of Folder settings): how many top-level items are hidden
// (/api/tree hidden_count) and the Hidden files dialog. Shown in every mode once a folder is open.

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { HiddenFilesDialog } from "@/components/hidden-files-dialog";
import { Button } from "@/components/ui/button";
import { DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function HiddenFilesButton({
  root,
  count,
  onOpen,
}: {
  root: string;
  count: number;
  onOpen: (path: string, isDir: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = count ? EyeOffIcon : EyeIcon;
  return (
    // DialogTrigger: Radix returns focus to this button when the dialog closes.
    <HiddenFilesDialog root={root} open={open} onOpenChange={setOpen} onOpen={onOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label={count ? `Hidden files, ${count.toLocaleString()} hidden` : "Hidden files"}
            >
              <Icon />
              {count ? (
                <span
                  className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-muted-foreground px-0.5 text-[9px] leading-none text-background"
                  aria-hidden
                >
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Hidden files</TooltipContent>
      </Tooltip>
    </HiddenFilesDialog>
  );
}
