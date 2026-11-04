"use client"

import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

/** Where focus comes back from when a dialog, sheet, menu or popover closes. */
const OVERLAY =
  "[role=dialog], [role=alertdialog], [role=menu], [data-radix-popper-content-wrapper]"

/** When the user last pressed Tab: focus from nowhere (relatedTarget null) right after it is the
 * user tabbing in (into the page, say), not focus returned by a closing overlay. */
let lastTabAt = 0
const TAB_FOCUS_MS = 1000
if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab") lastTabAt = Date.now()
    },
    true
  )
}

/** Focus that is not the user moving it: a dialog or menu returning focus to its trigger on close
 * (from inside the overlay, or from <body> once the overlay is gone), or the window regaining focus.
 * Such focus does not open the tooltip; hover and Tab still do, also between triggers inside one
 * dialog or sheet. */
function isReturnedFocus(e: React.FocusEvent) {
  const from = e.relatedTarget
  if (!(from instanceof Element)) return Date.now() - lastTabAt > TAB_FOCUS_MS
  const fromOverlay = from.closest(OVERLAY)
  return fromOverlay !== null && fromOverlay !== e.currentTarget.closest(OVERLAY)
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(e) => {
        onFocus?.(e)
        // Radix skips its open-on-focus handler for a prevented event.
        if (isReturnedFocus(e)) e.preventDefault()
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
