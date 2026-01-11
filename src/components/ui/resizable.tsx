"use client";

import * as React from "react";
import { GripVerticalIcon } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "./utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        // Base styles - transparent background, wide hit area
        "group relative flex items-center justify-center",
        // Horizontal resize (default)
        "w-[6px]",
        // The visible line - centered, appears on hover
        "before:absolute before:inset-y-0 before:left-1/2 before:w-[2px] before:-translate-x-1/2",
        "before:bg-transparent before:transition-colors before:duration-150",
        "hover:before:bg-primary active:before:bg-primary",
        "data-[resize-handle-state=drag]:before:bg-primary",
        // Focus styles
        "focus-visible:outline-hidden focus-visible:before:bg-primary",
        // Vertical resize overrides
        "data-[panel-group-direction=vertical]:h-[6px] data-[panel-group-direction=vertical]:w-full",
        "data-[panel-group-direction=vertical]:before:inset-x-0 data-[panel-group-direction=vertical]:before:inset-y-auto",
        "data-[panel-group-direction=vertical]:before:top-1/2 data-[panel-group-direction=vertical]:before:left-0",
        "data-[panel-group-direction=vertical]:before:h-[2px] data-[panel-group-direction=vertical]:before:w-full",
        "data-[panel-group-direction=vertical]:before:-translate-y-1/2 data-[panel-group-direction=vertical]:before:translate-x-0",
        // Rotate handle icon for vertical
        "[&[data-panel-group-direction=vertical]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
