"use client";

import * as React from "react";
import { GripVerticalIcon } from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type Layout,
  type LayoutStorage,
} from "react-resizable-panels";

import { cn } from "./utils";

/**
 * Compatibility wrappers around react-resizable-panels v4.
 *
 * The v4 API renamed components and changed several prop semantics; these
 * wrappers absorb the differences so call sites can keep the v3 prop surface:
 * - `PanelGroup` → `Group` (`direction` → `orientation`)
 * - v4 interprets numeric size props as pixels; v3 used percentages, so
 *   numbers are converted to unit-less percent strings here
 * - `onResize` now receives a `PanelSize` object; wrappers pass the plain
 *   percentage through
 * - `autoSaveId` → `useDefaultLayout` persistence (v3-format entries ignored);
 *   pass `panelIds` when panels mount conditionally so each combination is
 *   saved under its own key
 * - `order` no longer exists in v4; accepted and ignored
 */

// v3's autoSaveId wrote its own storage shape for the same localStorage keys;
// reject anything that isn't a {panelId: percent} map so stale v3 entries
// fall back to default sizes instead of confusing the v4 hook.
const percentLayoutStorage: LayoutStorage = {
  getItem(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const values = Object.values(parsed);
      if (values.length === 0 || !values.every((v) => typeof v === "number")) {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage may be unavailable (private mode, quota); layout persistence
      // is best-effort.
    }
  },
};

// v3 percent semantics: a bare number is a percentage, not pixels.
const toPercentString = (value: number | string | undefined) =>
  typeof value === "number" ? `${value}` : value;

type PanelGroupProps = React.ComponentProps<typeof Group> & {
  direction?: "horizontal" | "vertical";
  autoSaveId?: string;
  /**
   * Ids of the panels currently rendered in this group. Required when panels
   * are conditionally mounted: v4 persists one layout per panel combination
   * (keyed by these ids), so without them every combination shares a single
   * saved layout and hides overwrite it.
   */
  panelIds?: string[];
  onLayout?: (layout: Layout) => void;
};

function ResizablePanelGroup({
  direction,
  autoSaveId,
  panelIds,
  onLayout,
  className,
  ...props
}: PanelGroupProps) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: autoSaveId ?? "__rshell-noop__",
    panelIds,
    storage: percentLayoutStorage,
  });

  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction}
      defaultLayout={autoSaveId ? defaultLayout : undefined}
      onLayoutChanged={(layout, meta) => {
        if (autoSaveId) onLayoutChanged(layout, meta);
        onLayout?.(layout);
      }}
      className={className}
      {...props}
    />
  );
}

type ResizablePanelProps = Omit<
  React.ComponentProps<typeof Panel>,
  "onResize"
> & {
  order?: number;
  onResize?: (size: number) => void;
};

function ResizablePanel({
  order: _order,
  onResize,
  collapsedSize,
  defaultSize,
  maxSize,
  minSize,
  style,
  ...props
}: ResizablePanelProps) {
  return (
    <Panel
      data-slot="resizable-panel"
      // v4 renders children into an inner scrollable div; restore the v3
      // non-scrolling behaviour so popovers and context menus aren't clipped.
      style={{ overflow: "visible", ...style }}
      collapsedSize={toPercentString(collapsedSize)}
      defaultSize={toPercentString(defaultSize)}
      maxSize={toPercentString(maxSize)}
      minSize={toPercentString(minSize)}
      onResize={
        onResize
          ? (panelSize) => onResize(panelSize.asPercentage)
          : undefined
      }
      {...props}
    />
  );
}

type ResizableHandleProps = React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
};

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizableHandleProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        // Base styles - transparent background, wide hit area
        "group relative flex items-center justify-center",
        // Horizontal resize (default): narrow column with a centered vertical line
        "w-[6px]",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-[2px] before:-translate-x-1/2",
        "before:bg-transparent before:transition-colors before:duration-150",
        "hover:before:bg-primary active:before:bg-primary",
        "data-[separator=hover]:before:bg-primary data-[separator=drag]:before:bg-primary data-[separator=active]:before:bg-primary",
        // Vertical resize overrides (separators of vertical groups report
        // aria-orientation="horizontal"): short row with a centered horizontal line
        "aria-[orientation=horizontal]:h-[6px] aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:before:inset-x-0 aria-[orientation=horizontal]:before:inset-y-auto",
        "aria-[orientation=horizontal]:before:top-1/2 aria-[orientation=horizontal]:before:left-0",
        "aria-[orientation=horizontal]:before:h-[2px] aria-[orientation=horizontal]:before:w-full",
        "aria-[orientation=horizontal]:before:-translate-y-1/2 aria-[orientation=horizontal]:before:translate-x-0",
        // Rotate handle icon for vertical groups
        "[&[aria-orientation=horizontal]>div]:rotate-90",
        // Focus styles
        "focus-visible:outline-hidden focus-visible:before:bg-primary",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border border-border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
