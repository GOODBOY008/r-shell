/**
 * Guards the bridge App's layout fix depends on: `ResizablePanelGroup` must
 * forward react-resizable-panels v4's `onLayoutChanged` to its own `onLayout`
 * prop. v4 defers that callback until a drag's pointer is released, which is
 * what stops a mid-drag state write from re-deriving the layout and freezing
 * the separator.
 *
 * The library is stubbed here so the wrapper's forwarding can be driven
 * directly. app-resizable-drag-sync.test.tsx covers the App side with the
 * wrapper stubbed instead — neither file alone would notice the bridge being
 * dropped, since both sides would still type-check and pass.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

const captured = vi.hoisted(() => ({
  groupProps: null as null | Record<string, unknown>,
  libraryOnLayoutChanged: vi.fn(),
  defaultLayout: undefined as undefined | Record<string, number>,
}));

vi.mock('react-resizable-panels', async () => {
  const ReactModule = await import('react');
  return {
    Group: (props: Record<string, unknown>) => {
      captured.groupProps = props;
      return ReactModule.createElement('div', null, props.children as React.ReactNode);
    },
    Panel: (props: Record<string, unknown>) =>
      ReactModule.createElement('div', null, props.children as React.ReactNode),
    Separator: () => ReactModule.createElement('div'),
    useDefaultLayout: () => ({
      defaultLayout: captured.defaultLayout,
      onLayoutChanged: captured.libraryOnLayoutChanged,
    }),
  };
});

const WRAPPER_ID = 'r-shell-wrapper-test-layout';

function renderGroup(props: Record<string, unknown> = {}) {
  return render(
    <ResizablePanelGroup direction="horizontal" {...props}>
      <ResizablePanel id="left">
        <span />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="right">
        <span />
      </ResizablePanel>
    </ResizablePanelGroup>,
  );
}

/** Drive the callback the wrapper handed the library. */
function fireLibraryLayoutChanged(layout: Record<string, number>) {
  const onChange = captured.groupProps?.onLayoutChanged as
    | ((layout: Record<string, number>, meta: unknown) => void)
    | undefined;
  expect(typeof onChange).toBe('function');
  onChange?.(layout, { isUserInteraction: true });
}

describe('ResizablePanelGroup forwards the library onLayoutChanged to onLayout', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    captured.groupProps = null;
    captured.defaultLayout = undefined;
  });

  it('forwards the layout when no autoSaveId is set', () => {
    const onLayout = vi.fn();
    renderGroup({ onLayout });

    fireLibraryLayoutChanged({ left: 30, right: 70 });

    expect(onLayout).toHaveBeenCalledWith({ left: 30, right: 70 });
    // Without autoSaveId there is nothing to persist.
    expect(captured.libraryOnLayoutChanged).not.toHaveBeenCalled();
  });

  it('forwards to onLayout and persists when autoSaveId is set', () => {
    const onLayout = vi.fn();
    renderGroup({ onLayout, autoSaveId: WRAPPER_ID });

    fireLibraryLayoutChanged({ left: 30, right: 70 });

    expect(onLayout).toHaveBeenCalledWith({ left: 30, right: 70 });
    expect(captured.libraryOnLayoutChanged).toHaveBeenCalledTimes(1);
    expect(captured.libraryOnLayoutChanged.mock.calls[0][0]).toEqual({ left: 30, right: 70 });
  });

  it('still persists when the caller supplies no onLayout', () => {
    renderGroup({ autoSaveId: WRAPPER_ID });

    fireLibraryLayoutChanged({ left: 30, right: 70 });

    expect(captured.libraryOnLayoutChanged).toHaveBeenCalledTimes(1);
  });

  it('passes the persisted layout through to the group', () => {
    captured.defaultLayout = { left: 25, right: 75 };
    renderGroup({ autoSaveId: WRAPPER_ID });

    expect(captured.groupProps?.defaultLayout).toEqual({ left: 25, right: 75 });
  });

  it('leaves defaultLayout unset when no autoSaveId is set', () => {
    captured.defaultLayout = { left: 25, right: 75 };
    renderGroup({ onLayout: vi.fn() });

    expect(captured.groupProps?.defaultLayout).toBeUndefined();
  });
});
