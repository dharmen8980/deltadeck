"use client";

import { useState } from "react";
import { ClipboardCopyIcon, ListPlusIcon, ShoppingBasketIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { navigate } from "@/hooks/use-route";
import { copyText } from "@/lib/clipboard";
import { plural } from "@/lib/format";
import { basename } from "@/lib/paths";
import { buildPrompt, groupByFile, type BasketItem } from "@/lib/review-basket";
import { cn } from "@/lib/utils";
import { addWithToast, useBasket, type FileReview } from "./basket-context";

const DOT: Record<BasketItem["change"], string> = {
  added: "bg-emerald-500",
  modified: "bg-amber-500",
  removed: "bg-red-500",
};

/**
 * The review basket in the header: a count badge (only while it holds something) opening a small
 * panel with the items by file (note, remove), Clear and "Copy for AI" (one prompt, then empty,
 * with an undo).
 */
export function BasketMenu() {
  const basket = useBasket();
  const [open, setOpen] = useState(false);
  if (!basket || (!basket.items.length && !open)) return null;
  const { items } = basket;
  const groups = groupByFile(items);

  const copy = async () => {
    const prompt = buildPrompt(items, basket.pathPrefix);
    if (!(await copyText(prompt))) {
      toast.error("Could not copy to clipboard");
      return;
    }
    const held = basket.clear();
    setOpen(false);
    toast.success(`Copied ${plural(held.length, "item")} for AI`, {
      description: "Paste it into your agent. The basket is now empty.",
      action: { label: "Undo", onClick: () => basket.restore(held) },
    });
  };
  const clearAll = () => {
    const held = basket.clear();
    toast(`Removed ${plural(held.length, "item")} from the review basket`, {
      action: { label: "Undo", onClick: () => basket.restore(held) },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="mr-1 gap-1.5 border-sky-500/40 px-2 text-sky-800 dark:text-sky-200"
          aria-label={`Review basket: ${plural(items.length, "item")}`}
          title="Review basket: changes picked for feedback to the AI"
        >
          <ShoppingBasketIcon />
          <span className="tabular-nums">{items.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ShoppingBasketIcon className="size-4 text-sky-600 dark:text-sky-400" aria-hidden />
          <h2 className="flex-1 text-sm font-medium">
            Review basket <span className="font-normal text-muted-foreground">{items.length}</span>
          </h2>
          <Button size="xs" variant="ghost" onClick={clearAll} disabled={!items.length} title="Empty the basket">
            <Trash2Icon /> Clear
          </Button>
        </div>
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto px-1 py-1">
          {groups.length ? (
            groups.map((g) => (
              <section key={g.path} className="py-1">
                <button
                  type="button"
                  className="block w-full cursor-pointer truncate rounded-sm px-2 py-0.5 text-left font-mono text-xs text-muted-foreground hover:text-foreground"
                  title={`Open ${basket.pathPrefix}${g.path}`}
                  onClick={() => {
                    setOpen(false);
                    navigate(g.path);
                  }}
                >
                  {basket.pathPrefix}
                  {g.path}
                </button>
                <ul>
                  {g.items.map((it) => (
                    <li key={it.id} className="group flex flex-col gap-1 rounded-md px-2 py-1 hover:bg-muted/50">
                      <div className="flex items-center gap-2 text-xs">
                        <span className={cn("size-1.5 shrink-0 rounded-full", DOT[it.change])} aria-hidden />
                        <span className="min-w-0 flex-1 truncate" title={it.location}>
                          {it.location}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {it.change === "modified" ? "edited" : it.change}
                        </span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => basket.remove(it.id)}
                          aria-label={`Remove ${it.location} from the basket`}
                          title="Remove"
                        >
                          <XIcon />
                        </Button>
                      </div>
                      <Input
                        value={it.note}
                        onChange={(e) => basket.setNote(it.id, e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        placeholder="Note for the AI (optional)"
                        aria-label={`Note for ${it.location}`}
                        className="h-7 text-xs md:text-xs"
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">Empty. Hover a highlighted change and press +, or b.</p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <span className="flex-1 text-[11px] text-muted-foreground">One prompt with a diff and your note per change</span>
          <Button size="sm" onClick={() => void copy()} disabled={!items.length}>
            <ClipboardCopyIcon /> Copy for AI
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The banner's "add all changes in this file". */
export function BasketAddAll({ review, path }: { review: FileReview; path: string }) {
  const basket = useBasket();
  if (!basket) return null;
  const n = review.hunks.length;
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => addWithToast(basket, review.hunks.map((_, i) => review.item(i)), `${plural(n, "change")} in ${basename(path)}`)}
      aria-label="Add all changes in this file to the review basket"
      title={`Add all ${plural(n, "change")} in this file to the review basket`}
    >
      <ListPlusIcon />
      <span className="hidden sm:inline">Add all</span>
    </Button>
  );
}
