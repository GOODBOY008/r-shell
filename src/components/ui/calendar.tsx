"use client";

import * as React from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";

import { cn } from "./utils";
import { buttonVariants } from "./button";

/**
 * Calendar built on react-day-picker v9+ (v10) — the redesigned API that
 * replaced the v8 table markup and IconLeft/IconRight components with CSS
 * grid/flex classes and a single Chevron component.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  buttonVariant = "ghost",
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: "ghost" | "outline";
}) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      mode="single"
      showOutsideDays={showOutsideDays}
      className={cn("bg-background group/calendar p-3 [--cell-size:2rem]", className)}
      formatters={{
        formatMonthDropdown: (date) =>
          date.toLocaleString("default", { month: "short" }),
        ...formatters,
      }}
      classNames={{
        root: cn("w-fit", defaultClassNames.root),
        months: cn(
          "flex flex-col relative md:flex-row gap-4",
          defaultClassNames.months,
        ),
        month: cn("flex flex-col w-full gap-4", defaultClassNames.month),
        nav: cn(
          "flex items-center gap-1 w-full absolute top-0 inset-x-0 h-9 justify-between",
          defaultClassNames.nav,
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant === "outline" ? "outline" : "ghost", size: "icon" }),
          "size-9 p-0 select-none aria-disabled:opacity-50",
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant === "outline" ? "outline" : "ghost", size: "icon" }),
          "size-9 p-0 select-none aria-disabled:opacity-50",
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          "flex items-center justify-center h-9 w-full px-8",
          defaultClassNames.month_caption,
        ),
        dropdowns: cn(
          "flex items-center gap-1 justify-center h-9 w-full",
          defaultClassNames.dropdowns,
        ),
        dropdown_root: cn(
          "relative has-focus:border-ring border border-input shadow-2xs has-focus:ring-ring/50 has-focus:ring-2 rounded-md",
          defaultClassNames.dropdown_root,
        ),
        dropdown: "absolute inset-0 opacity-0",
        caption_label: cn(
          "select-none font-medium text-sm",
          defaultClassNames.caption_label,
        ),
        month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
        weekdays: cn("flex", defaultClassNames.weekdays),
        weekday: cn(
          "text-muted-foreground rounded-md flex-1 font-normal text-[0.8rem] select-none",
          defaultClassNames.weekday,
        ),
        week: cn("flex w-full mt-2", defaultClassNames.week),
        week_number: cn(
          "text-muted-foreground select-none text-[0.8rem] w-(--cell-size)",
          defaultClassNames.week_number,
        ),
        day: cn(
          "relative w-full aspect-square p-0 text-center select-none",
          "[&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md",
          defaultClassNames.day,
        ),
        day_button: cn(
          "relative flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal select-none rounded-md",
          "hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring transition-shadow",
          defaultClassNames.day_button,
        ),
        range_start: cn(
          "bg-accent rounded-l-md",
          defaultClassNames.range_start,
        ),
        range_middle: cn(
          "rounded-none aria-selected:bg-accent aria-selected:text-accent-foreground",
          defaultClassNames.range_middle,
        ),
        range_end: cn("bg-accent rounded-r-md", defaultClassNames.range_end),
        today: cn(
          "bg-accent text-accent-foreground rounded-md data-[selected=true]:rounded-none",
          defaultClassNames.today,
        ),
        outside: cn(
          "text-muted-foreground aria-selected:bg-accent/50 aria-selected:text-muted-foreground",
          defaultClassNames.outside,
        ),
        disabled: cn(
          "text-muted-foreground opacity-50",
          defaultClassNames.disabled,
        ),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === "left") {
            return <ChevronLeftIcon className={cn("size-4", className)} {...props} />;
          }
          if (orientation === "right") {
            return <ChevronRightIcon className={cn("size-4", className)} {...props} />;
          }
          return <ChevronDownIcon className={cn("size-4", className)} {...props} />;
        },
        ...components,
      }}
      {...props}
    />
  );
}

export { Calendar };
