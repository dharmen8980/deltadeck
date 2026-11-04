"use client";

// Right-click Hide in the sidebar (any row, read-only mode too). The choice lives on the server,
// per folder (/api/hiding, hiding-api.ts); the tree follows through the usual "change" event
// (newly hidden paths reported deleted). Unhide happens in the Hidden files dialog, or with Undo.

import { useMemo } from "react";
import { EyeOffIcon } from "lucide-react";
import { toast } from "sonner";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { errorMessage } from "@/lib/api";
import { hidePaths, showPaths } from "@/lib/hiding-api";
import { basename } from "@/lib/paths";

export interface HidingCtx {
  hide: (path: string) => void;
}

const fail = (e: unknown) => toast.error("Could not change the hidden files", { description: errorMessage(e) });

/** The Hide action for the tree; null when the folder's hidden-file settings are off. */
export function useHidingCtx(root: string | null): HidingCtx | null {
  return useMemo<HidingCtx | null>(() => {
    if (!root) return null;
    return {
      hide: (path) => {
        hidePaths(root, [path]).then(() => {
          toast(`Hidden ${basename(path)}`, {
            action: { label: "Undo", onClick: () => void showPaths(root, [path]).catch(fail) },
          });
        }, fail);
      },
    };
  }, [root]);
}

/** "Hide" for a visible row (not the root). */
export function HideItem({ hiding, path }: { hiding: HidingCtx; path: string }) {
  if (!path) return null;
  return (
    <ContextMenuItem onSelect={() => hiding.hide(path)}>
      <EyeOffIcon /> Hide
    </ContextMenuItem>
  );
}
