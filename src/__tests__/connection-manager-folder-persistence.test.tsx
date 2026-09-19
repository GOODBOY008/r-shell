/**
 * The connection manager must reopen with the folders in the state the user
 * left them: collapsing a folder is persisted immediately and honoured by a
 * fresh mount (which is what an app restart is, as far as the tree knows).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '../components/connection-manager';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { COLLAPSED_FOLDERS_STORAGE_KEY } from '../lib/folder-expansion';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const workId = crypto.randomUUID();
const prodId = crypto.randomUUID();
const personalId = crypto.randomUUID();

function seedStorage() {
  localStorage.clear();
  const now = new Date().toISOString();
  localStorage.setItem(
    'r-shell-connection-folders',
    JSON.stringify([
      { id: workId, name: 'Work', path: 'Work', parentPath: undefined, createdAt: now },
      { id: prodId, name: 'Prod', path: 'Work/Prod', parentPath: 'Work', createdAt: now },
      { id: personalId, name: 'Personal', path: 'Personal', parentPath: undefined, createdAt: now },
    ]),
  );
  localStorage.setItem(
    'r-shell-connections',
    JSON.stringify([
      { id: crypto.randomUUID(), name: 'Prod box', host: 'p', port: 22, username: 'u', protocol: 'SSH', folder: 'Work/Prod', createdAt: now },
      { id: crypto.randomUUID(), name: 'Home box', host: 'h', port: 22, username: 'u', protocol: 'SSH', folder: 'Personal', createdAt: now },
    ]),
  );
  ConnectionStorageManager.initialize();
}

function mount() {
  return render(
    <ConnectionManager onConnectionSelect={vi.fn()} selectedConnectionId={null} activeConnections={new Set()} />,
  );
}

function chevronOf(container: HTMLElement, folderId: string): HTMLButtonElement {
  const row = container.querySelector(`[data-conn-node-id="${folderId}"]`);
  const button = row?.querySelector('button');
  if (!button) throw new Error(`no chevron for folder ${folderId}`);
  return button;
}

describe('ConnectionManager folder expansion persistence', () => {
  beforeEach(seedStorage);
  afterEach(cleanup);

  it('starts fully expanded when nothing was stored', () => {
    mount();
    expect(screen.getByText('Prod box')).toBeTruthy();
    expect(screen.getByText('Home box')).toBeTruthy();
  });

  it('stores a collapse immediately and restores it on a fresh mount', () => {
    const first = mount();
    fireEvent.click(chevronOf(first.container, prodId));
    expect(screen.queryByText('Prod box')).toBeNull();
    expect(JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY) ?? '[]')).toEqual([prodId]);
    first.unmount();

    const second = mount();
    expect(screen.queryByText('Prod box')).toBeNull(); // Work/Prod still collapsed
    expect(screen.getByText('Prod')).toBeTruthy(); // ...but its parent is open
    expect(screen.getByText('Home box')).toBeTruthy(); // Personal untouched

    fireEvent.click(chevronOf(second.container, prodId));
    expect(screen.getByText('Prod box')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY) ?? '[]')).toEqual([]);
  });

  it('keeps a collapsed parent collapsed across a restart and remembers nested state inside it', () => {
    const first = mount();
    fireEvent.click(chevronOf(first.container, prodId));
    fireEvent.click(chevronOf(first.container, workId));
    expect(screen.queryByText('Prod')).toBeNull();
    first.unmount();

    const second = mount();
    expect(screen.queryByText('Prod')).toBeNull();
    fireEvent.click(chevronOf(second.container, workId));
    expect(screen.getByText('Prod')).toBeTruthy();
    expect(screen.queryByText('Prod box')).toBeNull(); // nested collapse remembered too
  });

  it('drops ids of folders that no longer exist when the state is next saved', () => {
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, JSON.stringify(['deleted-folder', personalId]));
    const { container } = mount();
    expect(screen.queryByText('Home box')).toBeNull();

    fireEvent.click(chevronOf(container, workId));
    const saved: string[] = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY) ?? '[]');
    expect(saved.sort()).toEqual([personalId, workId].sort()); // 'deleted-folder' is gone
  });

  it('survives unreadable stored state', () => {
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, '{oops');
    mount();
    expect(screen.getByText('Prod box')).toBeTruthy();
  });
});
