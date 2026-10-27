import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopToolbar } from '../desktop-toolbar';

function toolbarProps() {
  return {
    protocol: 'RDP',
    scalingMode: 'fit' as const,
    isFullScreen: false,
    onToggleScalingMode: vi.fn(),
    onSendCtrlAltDel: vi.fn(),
    onToggleFullScreen: vi.fn(),
    onDisconnect: vi.fn(),
    onPopOut: vi.fn(),
  };
}

const controls = () => screen.queryByRole('group', { name: 'Remote desktop controls' });
const handle = () => screen.getByRole('button', { name: 'Show remote desktop controls' });
const advance = (ms = 3000) => act(() => { vi.advanceTimersByTime(ms); });

describe('DesktopToolbar auto-hide', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps a reachable handle after hiding and can be revealed repeatedly', () => {
    render(<DesktopToolbar {...toolbarProps()} />);
    expect(controls()).not.toBeNull();

    for (let cycle = 0; cycle < 3; cycle++) {
      advance();
      expect(controls()).toBeNull();
      expect(handle().getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();

      fireEvent.pointerEnter(handle());
      expect(controls()).not.toBeNull();
      expect(handle().getAttribute('aria-expanded')).toBe('true');
      fireEvent.pointerLeave(handle().parentElement!);
    }
  });

  it('stays visible while the pointer is over the controls, including after movement', () => {
    render(<DesktopToolbar {...toolbarProps()} />);
    fireEvent.pointerEnter(handle());
    fireEvent.mouseMove(screen.getByRole('button', { name: 'Disconnect' }));
    advance(10_000);
    expect(controls()).not.toBeNull();

    fireEvent.pointerLeave(handle().parentElement!);
    advance(2999);
    expect(controls()).not.toBeNull();
    advance(1);
    expect(controls()).toBeNull();
  });

  it('reveals on keyboard focus and stays open while focus moves between controls', () => {
    render(<><DesktopToolbar {...toolbarProps()} /><button>Outside</button></>);
    advance();
    act(() => handle().focus());
    expect(controls()).not.toBeNull();
    act(() => screen.getByRole('button', { name: 'Full Screen' }).focus());
    fireEvent.pointerLeave(handle().parentElement!);
    advance(10_000);
    expect(controls()).not.toBeNull();

    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    advance();
    expect(controls()).toBeNull();
  });

  it('does not hide on blur while the pointer is still over the controls', () => {
    render(<><DesktopToolbar {...toolbarProps()} /><button>Outside</button></>);
    fireEvent.pointerEnter(handle());
    act(() => handle().focus());
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    advance(10_000);
    expect(controls()).not.toBeNull();
    fireEvent.pointerLeave(handle().parentElement!);
    advance();
    expect(controls()).toBeNull();
  });

  it('runs local actions without forwarding pointer, wheel, or keyboard input to the desktop', () => {
    const props = toolbarProps();
    const remoteInput = vi.fn();
    render(
      <div onMouseDown={remoteInput} onMouseUp={remoteInput} onMouseMove={remoteInput}
        onWheel={remoteInput} onKeyDown={remoteInput} onKeyUp={remoteInput}>
        <DesktopToolbar {...props} />
      </div>,
    );
    advance();
    fireEvent.click(handle());
    const actions = [
      ['Fit', props.onToggleScalingMode],
      ['Ctrl+Alt+Del', props.onSendCtrlAltDel],
      ['Full Screen', props.onToggleFullScreen],
      ['Open in Separate Window', props.onPopOut],
      ['Disconnect', props.onDisconnect],
    ] as const;
    for (const [name, action] of actions) {
      const button = screen.getByRole('button', { name });
      fireEvent.mouseMove(button);
      fireEvent.mouseDown(button);
      fireEvent.mouseUp(button);
      fireEvent.wheel(button);
      fireEvent.keyDown(button, { key: 'Enter' });
      fireEvent.keyUp(button, { key: 'Enter' });
      fireEvent.click(button);
      expect(action).toHaveBeenCalledOnce();
    }
    expect(remoteInput).not.toHaveBeenCalled();
  });

  it('also restores VNC controls without exposing RDP-only actions', () => {
    render(<DesktopToolbar {...toolbarProps()} protocol="VNC" />);
    advance();
    fireEvent.pointerEnter(handle());
    expect(controls()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Ctrl+Alt+Del' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open in Separate Window' })).toBeNull();
  });

  it('cancels pending hide timers when the connection view unmounts', () => {
    const view = render(<DesktopToolbar {...toolbarProps()} />);
    fireEvent.pointerEnter(handle());
    fireEvent.pointerLeave(handle().parentElement!);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
