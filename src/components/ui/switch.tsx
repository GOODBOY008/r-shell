"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "./utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none",
        // Unchecked track: themed via --switch-background (slate-300 light / slate-600 dark)
        "data-[state=unchecked]:bg-switch-background",
        "data-[state=unchecked]:hover:bg-slate-400 dark:data-[state=unchecked]:hover:bg-slate-500",
        // Checked track
        "data-[state=checked]:bg-emerald-500",
        "data-[state=checked]:hover:bg-emerald-600 dark:data-[state=checked]:hover:bg-emerald-500",
        // Brand-blue focus ring (default-palette color so the /alpha modifier works)
        "focus-visible:border-blue-500 focus-visible:ring-[3px] focus-visible:ring-blue-500/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-white pointer-events-none block size-4 rounded-full shadow ring-0 transition-transform",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
