"use client";

import { useLayoutEffect, useRef } from "react";
import { setPanelWidth, usePanelWidth, useViewportWidth } from "@/lib/layout-prefs";
import { dragWidth, keyResize, maxWidth, SIDEBAR_SPEC, TOC_SPEC, type PanelSpec } from "@/lib/panel-size";
import { SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  spec: PanelSpec;
  /** the CSS variable that holds the panel width */
  cssVar: string;
  /** where the variable is set: the sidebar wrapper (default) or the handle's parent element */
  scope?: "wrapper" | "parent";
  /** the width another panel takes beside this one (see maxWidth in panel-size.ts) */
  reserved?: number;
  /** move focus to the sidebar trigger if the handle goes away while focused (sidebar collapse) */
  refocusTrigger?: boolean;
  /** +1: the handle is on the panel's right edge (drag right to grow); -1: on its left edge */
  dir: 1 | -1;
  label: string;
  className?: string;
}

/**
 * A drag handle on a panel edge (role="separator"). While dragging it writes the CSS
 * variable directly, once per frame, and saves the width on release.
 */
export function ResizeHandle({
  spec,
  cssVar,
  dir,
  label,
  className,
  scope = "wrapper",
  reserved = 0,
  refocusTrigger,
}: ResizeHandleProps) {
  const width = usePanelWidth(spec, reserved);
  const viewport = useViewportWidth();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!refocusTrigger) return;
    const el = ref.current;
    return () => {
      if (el && el === document.activeElement) document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.focus();
    };
  }, [refocusTrigger]);
  const drag = useRef<{ id: number; x: number; start: number; last: number; frame: number; target: HTMLElement } | null>(null);

  const apply = (el: HTMLElement, target: HTMLElement, w: number) => {
    target.style.setProperty(cssVar, `${w}px`);
    el.setAttribute("aria-valuenow", String(w));
  };

  const finish = (el: HTMLElement, save: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    document.body.classList.remove("panel-resizing");
    if (el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id);
    if (save && d.last !== d.start) {
      apply(el, d.target, d.last);
      setPanelWidth(spec, d.last);
    } else apply(el, d.target, width);
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={maxWidth(spec, viewport, reserved)}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      data-slot="resize-handle"
      className={cn(
        "no-print group/resize absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none outline-none select-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors",
        "hover:after:bg-ring/60 focus-visible:after:bg-ring data-[dragging]:after:bg-ring",
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        const target =
          scope === "parent"
            ? e.currentTarget.parentElement
            : e.currentTarget.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
        if (!target) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "";
        document.body.classList.add("panel-resizing");
        drag.current = { id: e.pointerId, x: e.clientX, start: width, last: width, frame: 0, target };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        d.last = dragWidth(d.start, e.clientX - d.x, spec, window.innerWidth, dir, reserved);
        if (d.frame) return;
        const el = e.currentTarget;
        d.frame = requestAnimationFrame(() => {
          d.frame = 0;
          apply(el, d.target, d.last);
        });
      }}
      onPointerUp={(e) => {
        delete e.currentTarget.dataset.dragging;
        finish(e.currentTarget, true);
      }}
      onPointerCancel={(e) => {
        delete e.currentTarget.dataset.dragging;
        finish(e.currentTarget, false);
      }}
      onLostPointerCapture={(e) => {
        delete e.currentTarget.dataset.dragging;
        finish(e.currentTarget, true);
      }}
      onDoubleClick={() => setPanelWidth(spec, null)}
      onKeyDown={(e) => {
        if (e.altKey || e.metaKey || e.ctrlKey) return;
        const next = keyResize(e.key, e.shiftKey, width, spec, window.innerWidth, dir, reserved);
        if (next === null) return;
        e.preventDefault();
        setPanelWidth(spec, next === "reset" ? null : next);
      }}
    />
  );
}

/** The file sidebar's right edge: a resize handle while open, shadcn's click-to-open rail while collapsed. */
export function SidebarEdge() {
  const { state, isMobile } = useSidebar();
  if (isMobile) return null;
  if (state === "collapsed") return <SidebarRail />;
  return (
    <ResizeHandle spec={SIDEBAR_SPEC} cssVar="--sidebar-width" dir={1} label="Resize sidebar" className="right-0" refocusTrigger />
  );
}

/** The width the open file sidebar takes beside the contents panel (0 when collapsed or on mobile). */
function useTocReserved(): number {
  const { state, isMobile } = useSidebar();
  const sidebar = usePanelWidth(SIDEBAR_SPEC);
  return isMobile || state === "collapsed" ? 0 : sidebar;
}

/** The contents panel's width, kept clear of the open sidebar; set as --toc-width on the panel itself. */
export function useTocWidth(): { width: number; reserved: number } {
  const reserved = useTocReserved();
  return { width: usePanelWidth(TOC_SPEC, reserved), reserved };
}
