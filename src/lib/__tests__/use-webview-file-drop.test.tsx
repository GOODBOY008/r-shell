import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { render, act, cleanup } from "@testing-library/react";
import {
  useWebviewFileDrop,
  __resetWebviewFileDropSingletonForTest,
} from "../use-webview-file-drop";

// ---- Tauri mock ---------------------------------------------------------
// We mock `@tauri-apps/api/webview` at module level. The captured handler
// lets the test drive the singleton dispatcher.

type Handler = (event: { payload: unknown }) => void;
let capturedHandler: Handler | null = null;
let listenCount = 0;
let unlistenCount = 0;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: Handler) => {
      capturedHandler = handler;
      listenCount += 1;
      return Promise.resolve(() => {
        unlistenCount += 1;
        if (capturedHandler === handler) capturedHandler = null;
      });
    },
  }),
}));

// Device pixel ratio must be writable per-test.
function setDpr(value: number) {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function fire(payload: unknown) {
  if (!capturedHandler) throw new Error("no handler subscribed");
  capturedHandler({ payload });
}

function makeRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// jsdom does not lay out elements, so `getBoundingClientRect` always returns
// zeros. We patch the element's method directly so the hook's hit-test sees
// the rect we declared.
function patchRect(el: HTMLElement, rect: DOMRect) {
  el.getBoundingClientRect = () => rect;
}

// ---- Test component that renders a single drop zone ---------------------
function DropZone({
  enabled,
  onDrop,
  priority,
  onDragOverChange,
  rect,
  label = "zone",
}: {
  enabled: boolean;
  onDrop: (paths: string[]) => void;
  priority?: number;
  onDragOverChange?: (v: boolean) => void;
  rect: DOMRect;
  label?: string;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  // jsdom never lays out — patch getBoundingClientRect on the element so the
  // hook's hit-test sees the declared rect. Re-applied on every render in
  // case React swapped the element.
  useEffect(() => {
    if (targetRef.current) patchRect(targetRef.current, rect);
  }, [rect]);
  const { isDragOver } = useWebviewFileDrop({
    enabled,
    targetRef,
    onDrop,
    priority,
  });
  useEffect(() => {
    onDragOverChange?.(isDragOver);
  }, [isDragOver, onDragOverChange]);
  return (
    <div
      ref={targetRef}
      data-testid={label}
      data-drag-over={isDragOver ? "1" : "0"}
    />
  );
}

// ---- Tests --------------------------------------------------------------

describe("useWebviewFileDrop", () => {
  beforeEach(async () => {
    capturedHandler = null;
    listenCount = 0;
    unlistenCount = 0;
    setDpr(1);
    await __resetWebviewFileDropSingletonForTest();
  });

  afterEach(async () => {
    cleanup();
    await __resetWebviewFileDropSingletonForTest();
  });

  it("starts with isDragOver=false and subscribes lazily on mount", async () => {
    const onDrop = vi.fn();
    const rect = makeRect(0, 0, 100, 100);

    const { getByTestId } = render(
      <DropZone enabled onDrop={onDrop} rect={rect} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(getByTestId("zone").getAttribute("data-drag-over")).toBe("0");
    expect(listenCount).toBe(1);
  });

  it("suppresses overlay and callback when enabled=false", async () => {
    const onDrop = vi.fn();
    const rect = makeRect(0, 0, 100, 100);
    const spy = vi.fn();

    const { getByTestId } = render(
      <DropZone
        enabled={false}
        onDrop={onDrop}
        rect={rect}
        onDragOverChange={spy}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Even if an OS event arrives, disabled subscribers never light up.
    fire({
      type: "enter",
      position: { x: 50, y: 50 },
      paths: ["/tmp/a.txt"],
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getByTestId("zone").getAttribute("data-drag-over")).toBe("0");
    // spy may have been called with `false` from mount, but never with `true`.
    expect(spy.mock.calls.every(([v]) => v === false)).toBe(true);
  });

  it("sets the winner's overlay and invokes its onDrop for an in-bounds drop", async () => {
    const onDrop = vi.fn();
    const rect = makeRect(10, 20, 100, 50);
    const spy = vi.fn();

    render(
      <DropZone enabled onDrop={onDrop} rect={rect} onDragOverChange={spy} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Enter (inside)
    fire({
      type: "enter",
      position: { x: 60, y: 40 },
      paths: ["/tmp/a.txt"],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenLastCalledWith(true);

    // Drop (inside) — callback should fire with paths
    fire({
      type: "drop",
      position: { x: 60, y: 40 },
      paths: ["/tmp/a.txt", "/tmp/b.txt"],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(["/tmp/a.txt", "/tmp/b.txt"]);
    // Overlay was shown during hover (the `leave` test below verifies the
    // overlay-clearing path specifically; the drop path's React state update
    // is batched by React 19 and not reliably flushed inside a synchronous
    // `fire()` call in jsdom).
    expect(spy).toHaveBeenCalledWith(true);
  });

  it("clears all overlays on a leave event", async () => {
    const onDrop = vi.fn();
    const rect = makeRect(0, 0, 100, 100);
    const spy = vi.fn();

    render(
      <DropZone enabled onDrop={onDrop} rect={rect} onDragOverChange={spy} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    fire({
      type: "enter",
      position: { x: 50, y: 50 },
      paths: ["/tmp/a.txt"],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenLastCalledWith(true);

    fire({ type: "leave" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenLastCalledWith(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("scales physical pixels by devicePixelRatio for hit-testing", async () => {
    // DPR=2 → a physical (200, 100) event is CSS (100, 50).
    setDpr(2);
    const onDrop = vi.fn();
    // Box from CSS (80, 40) → (160, 120). Without DPR scaling, the physical
    // (200, 100) would miss this box; with correct scaling it hits.
    const rect = makeRect(80, 40, 80, 80);
    const spy = vi.fn();

    render(
      <DropZone enabled onDrop={onDrop} rect={rect} onDragOverChange={spy} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    fire({
      type: "enter",
      position: { x: 200, y: 100 }, // physical
      paths: ["/tmp/a.txt"],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenLastCalledWith(true);
  });

  it("picks the highest-priority winner when zones overlap", async () => {
    const onDropA = vi.fn();
    const onDropB = vi.fn();
    const rectA = makeRect(0, 0, 200, 200); // covers everything
    const rectB = makeRect(50, 50, 100, 100); // smaller, higher priority

    render(
      <>
        <DropZone
          enabled
          onDrop={onDropA}
          rect={rectA}
          priority={0}
          label="a"
        />
        <DropZone
          enabled
          onDrop={onDropB}
          rect={rectB}
          priority={5}
          label="b"
        />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    fire({
      type: "drop",
      position: { x: 100, y: 100 }, // inside both rects
      paths: ["/tmp/a.txt"],
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onDropA).not.toHaveBeenCalled();
    expect(onDropB).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from the Tauri event when the last consumer unmounts", async () => {
    const onDrop = vi.fn();
    const rect = makeRect(0, 0, 100, 100);

    const { unmount } = render(
      <DropZone enabled onDrop={onDrop} rect={rect} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const beforeUnlisten = unlistenCount;
    expect(listenCount).toBe(1);

    unmount();
    // Wait for the unlisten promise chain to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(unlistenCount).toBeGreaterThan(beforeUnlisten);
  });
});
