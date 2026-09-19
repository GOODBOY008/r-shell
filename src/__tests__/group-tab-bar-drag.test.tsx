import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    const closeButton = tabA.querySelector('button') as HTMLButtonElement;

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
