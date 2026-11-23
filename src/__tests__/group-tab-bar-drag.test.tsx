import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { GroupTabBar } from '../components/terminal/group-tab-bar';
import type { TerminalTab } from '../lib/terminal-group-types';

const dispatch = vi.fn();

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({ state: {}, dispatch }),
}));

beforeEach(() => {
  dispatch.mockClear();
});

function makeTab(id: string): TerminalTab {
  return { id, name: id, connectionStatus: 'connected', reconnectCount: 0 };
}

/** jsdom lacks elementsFromPoint; stub it so drag hit-testing finds this bar. */
function stubDropTarget(container: HTMLElement, groupId: string) {
  const tabBarEl = container.querySelector(`[data-tab-bar-group="${groupId}"]`) as HTMLElement;
  document.elementsFromPoint = () => [tabBarEl];
}

function getTabEl(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-tab-id]') as HTMLElement;
}

describe('GroupTabBar custom drag', () => {
  it('ends the drag on a no-button move when pointerup was missed', () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    const { container } = render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);
    stubDropTarget(container, '1');

    const tabA = getTabEl('a');
    fireEvent.pointerDown(tabA, { button: 0, pointerId: 1, clientX: 100, clientY: 10 });
    // Move past the threshold with the button held — drag is now active
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientX: 130, clientY: 10 });
    expect(tabA.className).toContain('opacity-40');

    // pointerup was never delivered (e.g. released outside the window): the
    // next hover move arrives with buttons = 0 and must end the drag
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 0, clientX: 130, clientY: 10 });

    expect(dispatch).toHaveBeenCalledWith({
      type: 'REORDER_TAB',
      groupId: '1',
      fromIndex: 0,
      toIndex: 2,
    });
    expect(tabA.className).not.toContain('opacity-40');
    expect(document.body.style.userSelect).toBe('');

    // Drag machinery fully torn down — further hover moves do nothing
    dispatch.mockClear();
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 0, clientX: 10, clientY: 10 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores pointer moves from a different pointer', () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    const { container } = render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);
    stubDropTarget(container, '1');

    const tabA = getTabEl('a');
    fireEvent.pointerDown(tabA, { button: 0, pointerId: 1, clientX: 100, clientY: 10 });

    // A second pointer wiggles past the threshold — must not drive this drag
    fireEvent.pointerMove(document, { pointerId: 2, buttons: 1, clientX: 130, clientY: 10 });
    expect(tabA.className).not.toContain('opacity-40');

    fireEvent.pointerUp(document, { pointerId: 1, clientX: 130, clientY: 10 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not start a drag from sub-threshold wiggle during a click', () => {
    const tabs = [makeTab('a'), makeTab('b')];
    const { container } = render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);
    stubDropTarget(container, '1');

    const tabA = getTabEl('a');
    fireEvent.pointerDown(tabA, { button: 0, pointerId: 1, clientX: 100, clientY: 10 });
    // 3px diagonal = ~4.2px Euclidean, below the 5px threshold
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientX: 103, clientY: 13 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 103, clientY: 13 });

    expect(tabA.className).not.toContain('opacity-40');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a press on the close button out of the drag handler so the click closes the tab', () => {
    // Regression: the tab's pointerdown handler calls setPointerCapture, which
    // retargets pointerup to the tab; the browser then dispatches the click to
    // the tab (the common ancestor) instead of the X button, so the close
    // never fires and the press only selects the tab. jsdom has no pointer
    // capture, so stub it on the tab and assert the press never reaches it.
    const tabs = [makeTab('a'), makeTab('b')];
    const { container } = render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);
    stubDropTarget(container, '1');

    const tabA = getTabEl('a');
    const capture = vi.fn();
    (tabA as HTMLElement & { setPointerCapture: (id: number) => void }).setPointerCapture = capture;
    const closeButton = tabA.querySelector('button[aria-label="Close"]') as HTMLButtonElement;

    fireEvent.pointerDown(closeButton, { button: 0, pointerId: 1, clientX: 100, clientY: 10 });
    expect(capture).not.toHaveBeenCalled();

    fireEvent.click(closeButton);
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_TAB', groupId: '1', tabId: 'a' });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ACTIVATE_TAB' }));

    // A press on the tab body still arms the drag as before.
    dispatch.mockClear();
    fireEvent.pointerDown(tabA, { button: 0, pointerId: 2, clientX: 100, clientY: 10 });
    expect(capture).toHaveBeenCalledWith(2);
    fireEvent.pointerUp(document, { pointerId: 2, clientX: 100, clientY: 10 });
  });

  function layoutBar(container: HTMLElement, groupId: string) {
    const bar = container.querySelector<HTMLElement>(`[data-tab-bar-group="${groupId}"]`)!;
    const nodes = bar.querySelectorAll<HTMLElement>('[data-tab-id]');
    for (const node of nodes) {
      Object.defineProperties(node, {
        offsetWidth: { configurable: true, value: 100 },
        offsetLeft: { configurable: true, get: () =>
          Array.from(bar.querySelectorAll('[data-tab-id]')).indexOf(node) * 100 },
      });
      // A painted position during FLIP is not the slot where the item lives.
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ left: 480, width: 100 } as DOMRect);
    }
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 240, width: 240 } as DOMRect);
    document.elementsFromPoint = () => [bar];
    return bar;
  }

  function begin(source: string, startX: number, endX: number) {
    fireEvent.pointerDown(getTabEl(source), { button: 0, pointerId: 1, clientX: startX, clientY: 10 });
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientX: endX, clientY: 10 });
  }

  function release(x: number, pointerId = 1) {
    fireEvent.pointerUp(document, { pointerId, clientX: x, clientY: 10 });
  }

  it.each([
    ['a', 50, 148.6, 0, 1, 200],
    ['b', 150, 51.4, 1, 0, 0],
    ['a', 50, 250, 0, 2, 298],
    ['c', 250, 50, 2, 0, 0],
  ] as const)('drops %s at its target center (%i -> %i)', (id, fromX, toX, fromIndex, toIndex, marker) => {
    const { container } = render(<GroupTabBar groupId="1" tabs={['a','b','c'].map(makeTab)} activeTabId="a" />);
    const bar = layoutBar(container, '1');
    begin(id, fromX, toX);
    const line = bar.querySelector<HTMLElement>('[data-tab-drop-marker]')!;
    expect(line.style.left).toBe(`${marker}px`);
    expect(line.classList).toContain('absolute');
    release(toX);
    expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex, toIndex });
    expect(bar.querySelector('[data-tab-drop-marker]')).toBeNull();
  });

  it('shows the marker in another group and inserts at its unadjusted index', () => {
    const { container } = render(<>
      <GroupTabBar groupId="1" tabs={['a','b'].map(makeTab)} activeTabId="a" />
      <GroupTabBar groupId="2" tabs={['x','y'].map(makeTab)} activeTabId="x" />
    </>);
    const source = layoutBar(container, '1');
    const target = layoutBar(container, '2');
    begin('a', 50, 130);
    expect(target.querySelector<HTMLElement>('[data-tab-drop-marker]')?.style.left).toBe('100px');
    expect(source.querySelector('[data-tab-drop-marker]')).toBeNull();
    release(130);
    expect(dispatch).toHaveBeenCalledWith({ type: 'MOVE_TAB', tabId: 'a', sourceGroupId: '1', targetGroupId: '2', targetIndex: 1 });
  });

  it('keeps the owning pointer through an unrelated pointerup or cancellation', () => {
    const { container } = render(<GroupTabBar groupId="1" tabs={['a','b'].map(makeTab)} activeTabId="a" />);
    layoutBar(container, '1');
    begin('a', 50, 150);
    release(150, 2);
    fireEvent.pointerCancel(document, { pointerId: 2, clientX: 150 });
    expect(document.body.style.userSelect).toBe('none');
    expect(dispatch).not.toHaveBeenCalled();
    release(150);
    expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex: 0, toIndex: 1 });
  });

  it('uses the current source index if another tab closed mid-drag', () => {
    const bar = (ids: string[]) => <GroupTabBar groupId="1" tabs={ids.map(makeTab)} activeTabId="b" />;
    const { container, rerender } = render(bar(['a','b','c','d']));
    layoutBar(container, '1');
    begin('b', 150, 250);
    rerender(bar(['b','c','d']));
    release(250);
    expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex: 0, toIndex: 2 });
  });

  it.each(['pointercancel','blur','lostcapture','escape','removed','unmount'])('abandons the gesture on %s', reason => {
    const view = (ids: string[]) => <GroupTabBar groupId="1" tabs={ids.map(makeTab)} activeTabId="b" />;
    const { container, rerender, unmount } = render(view(['a','b','c']));
    layoutBar(container, '1');
    begin('a', 50, 150);
    if (reason === 'pointercancel') fireEvent.pointerCancel(document, { pointerId: 1, clientX: 150 });
    if (reason === 'blur') fireEvent.blur(window);
    if (reason === 'lostcapture') fireEvent.lostPointerCapture(container.querySelector('[data-tab-id="a"]')!, { pointerId: 1 });
    if (reason === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
    if (reason === 'removed') rerender(view(['b','c']));
    if (reason === 'unmount') unmount();
    release(150);
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('');
    expect(container.querySelector('[data-tab-drop-marker]')).toBeNull();
  });

  it('keeps an inactive dropped tab in view while focus stays in the active terminal', () => {
    const view = (ids: string[]) => <>
      <GroupTabBar groupId="1" tabs={ids.map(makeTab)} activeTabId="a" />
      <div className="xterm"><textarea aria-label="Active terminal" /></div>
    </>;
    const { container, rerender } = render(view(['a', 'b', 'c', 'd', 'e']));
    const bar = layoutBar(container, '1');
    Object.defineProperties(bar, { scrollWidth: { value: 500 }, clientWidth: { value: 240 } });
    const input = screen.getByRole('textbox');
    input.focus();
    bar.scrollLeft = 100;
    begin('c', 150, 235);
    bar.scrollLeft = 260;
    release(235);
    expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex: 2, toIndex: 4 });
    rerender(view(['a', 'b', 'd', 'e', 'c']));
    expect(bar.scrollLeft).toBe(260);
    expect(document.activeElement).toBe(input);
  });

  it('continues to scroll and update the marker under a stationary edge pointer', () => {
    const { container } = render(<GroupTabBar groupId="1" tabs={['a','b','c','d','e'].map(makeTab)} activeTabId="a" />);
    const bar = layoutBar(container, '1');
    Object.defineProperties(bar, { scrollWidth: { value: 500 }, clientWidth: { value: 240 } });
    const callbacks = new Map<number, FrameRequestCallback>();
    let handle = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++handle, cb); return handle; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
    try {
      begin('a', 50, 235);
      expect(bar.querySelector<HTMLElement>('[data-tab-drop-marker]')?.style.left).toBe('200px');
      for (let frame = 1; frame <= 15; frame++) {
        const [id, cb] = callbacks.entries().next().value!;
        callbacks.delete(id);
        act(() => cb(frame * 16));
      }
      expect(bar.scrollLeft).toBe(120);
      expect(bar.querySelector<HTMLElement>('[data-tab-drop-marker]')?.style.left).toBe('400px');
      const activeScrollFrame = handle;
      release(235);
      expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex: 0, toIndex: 3 });
      expect(window.cancelAnimationFrame).toHaveBeenCalledWith(activeScrollFrame);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('FLIP-animates tabs when the order changes', () => {
    // jsdom rects are all-zero; fake per-tab lefts so the FLIP effect sees the
    // position change caused by a reorder.
    const lefts: Record<string, number> = { a: 0, b: 120 };
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        const id = this.getAttribute?.('data-tab-id');
        return { left: id ? lefts[id] ?? 0 : 0 } as DOMRect;
      });

    try {
      const { rerender } = render(
        <GroupTabBar groupId="1" tabs={[makeTab('a'), makeTab('b')]} activeTabId="a" />,
      );

      // Reorder commit: DOM order and on-screen positions swap
      lefts.a = 120;
      lefts.b = 0;
      rerender(<GroupTabBar groupId="1" tabs={[makeTab('b'), makeTab('a')]} activeTabId="a" />);

      const tabA = getTabEl('a');
      const tabB = getTabEl('b');
      // Both tabs are playing from their inverted positions back to zero
      expect(tabA.style.transition).toContain('transform');
      expect(tabB.style.transition).toContain('transform');
      expect(tabA.style.transform).toBe('');
      expect(tabB.style.transform).toBe('');
    } finally {
      rectSpy.mockRestore();
    }
  });
});
