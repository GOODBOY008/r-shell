import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SNIPPETS_CHANGED_EVENT,
  SnippetStorageManager,
  normalizeTags,
  parseTagInput,
  type CommandSnippet,
} from '../snippet-storage';

const STORAGE_KEY = 'r-shell-command-snippets';

function makeInput(overrides: Partial<CommandSnippet> = {}) {
  return {
    id: '',
    name: 'Restart nginx',
    command: 'sudo systemctl restart nginx',
    tags: ['web'],
    ...overrides,
  };
}

describe('snippet-storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a snippet with a generated id and timestamps', () => {
    const snippet = SnippetStorageManager.saveSnippet(makeInput());

    expect(snippet).not.toBeNull();
    expect(snippet!.id).toMatch(/^snippet-/);
    expect(snippet!.id).not.toBe('');
    expect(snippet!.createdAt).toBeTypeOf('string');
    expect(snippet!.updatedAt).toBeTypeOf('string');
    expect(snippet!.usageCount).toBe(0);
    expect(SnippetStorageManager.getSnippets()).toHaveLength(1);
  });

  it('rejects blank names and commands', () => {
    expect(SnippetStorageManager.saveSnippet(makeInput({ name: '   ' }))).toBeNull();
    expect(SnippetStorageManager.saveSnippet(makeInput({ command: '' }))).toBeNull();
    expect(SnippetStorageManager.getSnippets()).toHaveLength(0);
  });

  it('round-trips snippets through localStorage', () => {
    const saved = SnippetStorageManager.saveSnippet(makeInput());

    const loaded = SnippetStorageManager.getSnippet(saved!.id);
    expect(loaded).toMatchObject({
      name: 'Restart nginx',
      command: 'sudo systemctl restart nginx',
      tags: ['web'],
    });
  });

  it('updates an existing snippet in place, preserving createdAt and usageCount', () => {
    const created = SnippetStorageManager.saveSnippet(makeInput())!;
    SnippetStorageManager.recordSnippetUsage(created.id);
    SnippetStorageManager.recordSnippetUsage(created.id);

    const updated = SnippetStorageManager.saveSnippet({
      ...created,
      name: 'Restart nginx (hard)',
      command: 'sudo systemctl restart nginx --force',
    })!;

    const all = SnippetStorageManager.getSnippets();
    expect(all).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.usageCount).toBe(2);
    expect(updated.name).toBe('Restart nginx (hard)');
  });

  it('does not adopt another id when updating', () => {
    const a = SnippetStorageManager.saveSnippet(makeInput({ name: 'A' }))!;
    const b = SnippetStorageManager.saveSnippet(makeInput({ name: 'B' }))!;

    const updated = SnippetStorageManager.saveSnippet({ ...b, name: 'B2' })!;

    expect(updated.id).toBe(b.id);
    const ids = SnippetStorageManager.getSnippets().map(s => s.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('deletes snippets and reports whether anything was removed', () => {
    const created = SnippetStorageManager.saveSnippet(makeInput())!;

    expect(SnippetStorageManager.deleteSnippet('missing')).toBe(false);
    expect(SnippetStorageManager.deleteSnippet(created.id)).toBe(true);
    expect(SnippetStorageManager.getSnippets()).toHaveLength(0);
    expect(SnippetStorageManager.deleteSnippet(created.id)).toBe(false);
  });

  it('records usage by bumping usageCount and lastUsedAt', () => {
    const created = SnippetStorageManager.saveSnippet(makeInput())!;

    SnippetStorageManager.recordSnippetUsage(created.id);

    const loaded = SnippetStorageManager.getSnippet(created.id)!;
    expect(loaded.usageCount).toBe(1);
    expect(loaded.lastUsedAt).toBeTypeOf('string');
    // Unknown ids are a no-op, not an error.
    expect(() => SnippetStorageManager.recordSnippetUsage('missing')).not.toThrow();
  });

  it('normalizes tags: trims, drops empties, de-duplicates', () => {
    expect(normalizeTags([' docker ', '', 'logs', 'docker', ' '])).toEqual(['docker', 'logs']);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(parseTagInput('docker, logs,, web ')).toEqual(['docker', 'logs', 'web']);
  });

  it('degrades to an empty list on corrupt storage', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');

    expect(SnippetStorageManager.getSnippets()).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones on load', () => {
    const valid = {
      id: 'snippet-1',
      name: 'OK',
      command: 'ls',
      tags: ['x'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      valid,
      { id: 'nope' },
      'garbage',
      null,
    ]));

    const snippets = SnippetStorageManager.getSnippets();
    expect(snippets).toHaveLength(1);
    expect(snippets[0].usageCount).toBe(0); // missing usageCount defaults to 0
  });

  it('emits the change event on every mutation', () => {
    const listener = vi.fn();
    window.addEventListener(SNIPPETS_CHANGED_EVENT, listener);

    const created = SnippetStorageManager.saveSnippet(makeInput())!;
    expect(listener).toHaveBeenCalledTimes(1);

    SnippetStorageManager.recordSnippetUsage(created.id);
    expect(listener).toHaveBeenCalledTimes(2);

    SnippetStorageManager.deleteSnippet(created.id);
    expect(listener).toHaveBeenCalledTimes(3);

    window.removeEventListener(SNIPPETS_CHANGED_EVENT, listener);
  });

  it('clears an all-whitespace description to undefined', () => {
    const created = SnippetStorageManager.saveSnippet(makeInput({ description: '   ' }))!;
    expect(created.description).toBeUndefined();
  });
});
