"use client";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A ghost icon button whose label is its accessible name and its tooltip (with `keys`, the
 * shortcut, after it). */
export function TooltipButton({
  label,
  keys,
  size = "icon-sm",
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; keys?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size={size} aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys ? <span className="opacity-60">{keys}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
