import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegratedFileBrowser } from '../components/integrated-file-browser';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('../components/directory-tree', () => ({
  DirectoryTree: () => <div data-testid="directory-tree" />,
}));

vi.mock('../components/transfer-queue', () => ({
  TransferQueue: () => null,
}));

vi.mock('../components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IntegratedFileBrowser keyboard shortcuts', () => {
  it('does not intercept document shortcuts from editable targets', () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected={false}
        onClose={() => {}}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    input.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();

    input.remove();
  });
});
