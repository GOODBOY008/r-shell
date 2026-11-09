import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WelcomeScreen } from '../components/welcome-screen';

vi.mock('@/lib/layout-context', () => ({
  useLayout: () => ({
    layout: { leftSidebarVisible: true },
    toggleLeftSidebar: vi.fn(),
  }),
}));

vi.mock('@/lib/shortcut-registry', () => ({
  useShortcutBindings: () => ({
    newSession: 'Ctrl+N',
    toggleLeftSidebar: 'Ctrl+B',
    openSettings: 'Ctrl+,',
  }),
}));

vi.mock('@/lib/connection-storage', () => ({
  ConnectionStorageManager: { getRecentConnections: () => [] },
}));

vi.mock('@/lib/app-events', () => ({
  quickConnectConnection: vi.fn(),
}));

function renderWelcome() {
  return render(<WelcomeScreen onNewConnection={vi.fn()} onOpenSettings={vi.fn()} />);
}

describe('WelcomeScreen wallpaper', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the theme surface that wallpaper CSS makes translucent', () => {
    localStorage.setItem('terminalAppearance', JSON.stringify({
      backgroundImage: 'data:image/png;base64,AAAA',
    }));

    renderWelcome();

    const main = screen.getByRole('main');
    expect(main.className).toContain('bg-background');
    expect(main.className).not.toContain('bg-transparent');
  });

  it('keeps the opaque surface without a wallpaper', () => {
    renderWelcome();

    expect(screen.getByRole('main').className).toContain('bg-background');
  });
});
