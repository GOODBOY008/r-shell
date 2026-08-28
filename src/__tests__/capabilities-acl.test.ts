import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for runtime ACL denials. Unit tests mock the Tauri APIs,
 * so a missing capability permission only surfaces in the packaged app as a
 * silently swallowed promise rejection (e.g. a file-viewer window that
 * cannot be closed). These tests pin the permissions each window's IPC
 * actually needs.
 */

type PermissionEntry = string | { identifier: string };

interface Capability {
  windows: string[];
  permissions: PermissionEntry[];
}

function loadCapability(name: string): Capability {
  const path = resolve(__dirname, '../../src-tauri/capabilities', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as Capability;
}

function permissionIdentifiers(capability: Capability): string[] {
  return capability.permissions.map((entry) =>
    typeof entry === 'string' ? entry : entry.identifier,
  );
}

describe('window capabilities cover the IPC the frontend performs', () => {
  it('file-viewer windows may close and destroy themselves', () => {
    // close(): Ctrl+W / discard-and-close.
    // destroy(): the onCloseRequested wrapper calls destroy() whenever the
    // handler does not preventDefault — without allow-destroy the X button
    // leaves the window unclosable (tauri refuses the native close because
    // a JS listener exists).
    const perms = permissionIdentifiers(loadCapability('file-viewer'));
    expect(perms).toContain('core:window:allow-close');
    expect(perms).toContain('core:window:allow-destroy');
  });

  it('file-viewer capability targets file-viewer windows', () => {
    expect(loadCapability('file-viewer').windows).toEqual(['file-viewer-*']);
  });

  it('the main window may show/unminimize/focus editor windows (reuse path)', () => {
    // openEditorWindow focuses an existing viewer via show/unminimize/setFocus.
    const perms = permissionIdentifiers(loadCapability('default'));
    expect(perms).toContain('core:window:allow-show');
    expect(perms).toContain('core:window:allow-unminimize');
    expect(perms).toContain('core:window:allow-set-focus');
  });
});
