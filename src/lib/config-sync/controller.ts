import { invoke, isTauri } from '@tauri-apps/api/core';
import { isPasswordSavingAllowed } from '../credential-crypto';
import { applyLanguageFromPreference } from '../i18n';
import { applyTheme, getSavedTheme } from '../utils';
import { buildStorageImage, captureConfig, readStorageImage, stable, validateShortcutRecords, writeStorageImage, type StorageImage } from './storage';
import type { ProviderAuth, SyncTarget, SyncBatch, SyncChoices, SyncOptions, SyncPreview, SyncRecords, SyncStatus } from './types';

export type SyncPhase = 'disabled' | 'locked' | 'paused' | 'pending' | 'syncing' | 'synced' | 'review' | 'conflict' | 'error';
export interface SyncView {
  status: SyncStatus | null;
  phase: SyncPhase;
  busy: boolean;
  error: string | null;
  preview: SyncPreview | null;
  reviewOpen: boolean;
  lastSuccess: string | null;
}
const listeners = new Set<() => void>();
let view: SyncView = { status: null, phase: 'disabled', busy: false, error: null, preview: null, reviewOpen: false, lastSuccess: null };
let previewRecords: SyncRecords | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let started = 0;
let observedImage: StorageImage | null = null;
let observedRecords = '';
let due = Infinity;
let pullDue = Infinity;
let retryAt = 0;
let failures = 0;
const LAST_SUCCESS = 'rshell-config-sync-last-success';
// A terminal, a file editor or a remote desktop takes session input, not configuration.
const SESSION_INPUT = '.xterm, .cm-editor, [data-remote-desktop-input]';

export const getSyncView = (): SyncView => view;
export const subscribeSync = (listener: () => void): (() => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
function update(change: Partial<SyncView>): void { view = { ...view, ...change }; listeners.forEach(listener => listener()); }
function idlePhase(status: SyncStatus): SyncPhase {
  return !status.options.enabled ? 'disabled' : !status.unlocked ? 'locked' : status.options.paused ? 'paused' : 'pending';
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('SYNC_') ? message : 'SYNC_UNKNOWN';
}
function isTransientError(code: string): boolean {
  return ['SYNC_NETWORK', 'SYNC_STALE', 'SYNC_WRITE_UNCERTAIN', 'SYNC_RATE_LIMIT'].some(c => code.startsWith(c));
}
function fail(error: unknown): void {
  const code = errorCode(error);
  const transient = isTransientError(code);
  failures++;
  const wait = code.startsWith('SYNC_RATE_LIMIT:') ? Number(code.split(':')[1]) * 1000 : Math.min(300_000, 5000 * 2 ** Math.min(failures, 6));
  retryAt = transient ? Date.now() + wait : Infinity;
  if (transient) due = retryAt;
  update({ busy: false, phase: code === 'SYNC_LOCKED' ? 'locked' : 'error', error: code });
}
function recordsNow(): SyncRecords {
  const include = view.status?.options.credentials ?? false;
  if (include && !isPasswordSavingAllowed()) throw new Error('SYNC_PASSWORD_POLICY');
  return captureConfig(readStorageImage(), include);
}
function editing(): boolean {
  const focused = document.activeElement;
  const inlineEditor = focused instanceof HTMLElement
    && focused.matches('input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]')
    && !focused.closest(SESSION_INPUT);
  return inlineEditor || !!document.querySelector('[role="dialog"][data-state="open"]:not([data-config-sync-review]), [role="alertdialog"][data-state="open"]');
}
/** Blocks what is on screen while the stores are replaced. Session input stays usable and keeps its focus. */
function lockInterface(): () => void {
  const locked: HTMLElement[] = [];
  const focused = document.activeElement;
  const lock = (parent: Element): void => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || child.inert || child.matches(SESSION_INPUT)) continue;
      if (child.querySelector(SESSION_INPUT)) lock(child);
      else { child.inert = true; locked.push(child); }
    }
  };
  const root = document.getElementById('root');
  if (root) lock(root);
  return () => {
    for (const element of locked) element.inert = false;
    // An inert element loses focus and the browser does not give it back.
    // A tooltip trigger stays without it: focus would open the tooltip.
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body
      && !focused.matches('[data-slot="tooltip-trigger"]')) focused.focus({ preventScroll: true });
  };
}
function notifyStores(): void {
  for (const event of ['rshell-connections-changed', 'storage', 'sshClientSettingsChanged', 'rshell-editor-config-changed',
    'rshell-snippets-changed', 'rshell-monitor-changed', 'rshell-dashboards-changed']) window.dispatchEvent(new Event(event));
  applyTheme(getSavedTheme());
  void applyLanguageFromPreference();
}

/** Runs before React mounts, so no store sees a partially applied transaction. */
export async function recoverConfigSync(): Promise<boolean> {
  if (!isTauri()) return false;
  const recovery = await invoke<{ id: string; image: StorageImage } | null>('config_sync_recovery');
  if (!recovery) return false;
  writeStorageImage(recovery.image);
  await invoke('config_sync_finish_apply', { id: recovery.id });
  return true;
}

export async function refreshSyncStatus(): Promise<void> {
  if (!isTauri()) return;
  const status = await invoke<SyncStatus>('config_sync_status');
  update({ status, phase: idlePhase(status), ...(!status.initialized ? { lastSuccess: null } : {}) });
}

export async function configureSync(options: SyncOptions, auth?: ProviderAuth, passphrase?: string): Promise<void> {
  if (view.busy) throw new Error('SYNC_BUSY');
  if (options.credentials && !isPasswordSavingAllowed()) throw new Error('SYNC_PASSWORD_POLICY');
  update({ busy: true });
  try {
    if (await recoverConfigSync()) notifyStores();
  } catch {
    fail('SYNC_RECOVERY_REQUIRED');
    throw new Error('SYNC_RECOVERY_REQUIRED');
  }
  try {
    const status = await invoke<SyncStatus>('config_sync_configure', { options, auth: auth ?? null, passphrase: passphrase ?? null });
    if (!status.initialized) {
      try { localStorage.removeItem(LAST_SUCCESS); } catch { /* Optional display metadata. */ }
    }
    update({ status, phase: idlePhase(status), busy: false, error: null, preview: null, reviewOpen: false,
      ...(!status.initialized ? { lastSuccess: null } : {}) });
    previewRecords = null; observedImage = null; observedRecords = ''; due = Date.now() + 1500; retryAt = 0; failures = 0;
  } catch (error) {
    // A rejected draft leaves the active provider and its retry schedule intact.
    update({ busy: false }); throw error;
  }
}

export async function testSyncConnection(target: SyncTarget, auth?: ProviderAuth): Promise<void> {
  await invoke('config_sync_test', { target, auth: auth ?? null });
}

export function openSyncReview(): void { if (view.preview) update({ reviewOpen: true }); }
export function closeSyncReview(): void { update({ reviewOpen: false }); }
export function discardSyncPreview(): void {
  previewRecords = null; update({ preview: null, reviewOpen: false, error: null, phase: view.status ? idlePhase(view.status) : 'disabled' });
  due = Infinity; pullDue = Date.now() + 300_000;
}

function resolvedPublicSnapshot(preview: SyncPreview, choices: SyncChoices) {
  const snapshot = structuredClone(preview.snapshot);
  // Credential choices are opaque to the webview. Their resolved shape is
  // checked by Rust before upload and again with the returned local batch.
  for (const key of Object.keys(snapshot.records)) if (key.startsWith('credentials/')) delete snapshot.records[key];
  const related = (key: string) => ['folders/', 'connections/', 'profiles/', 'monitors/', 'dashboards/'].some(prefix => key.startsWith(prefix));
  for (const conflict of preview.conflicts) {
    const choice = choices[conflict.key];
    if (!choice) throw new Error('SYNC_CONFLICT');
    if (conflict.key.startsWith('credentials/')) continue; // Opaque to the webview; Rust resolves and seals it.
    const value = choice === 'local' ? conflict.local : conflict.remote;
    if (conflict.key === '@relationships') {
      for (const key of Object.keys(snapshot.records)) if (related(key)) delete snapshot.records[key];
      Object.assign(snapshot.records, value);
    } else if (value === null || value === undefined) delete snapshot.records[conflict.key];
    else snapshot.records[conflict.key] = value;
  }
  return snapshot;
}

export async function prepareSync(manual = true): Promise<void> {
  if (!isTauri() || view.busy || !view.status?.options.enabled) return;
  if (!manual && (editing() || view.preview || view.status.options.paused)) return;
  update({ busy: true, error: null, phase: 'syncing', preview: null });
  try {
    const records = recordsNow();
    const preview = await invoke<SyncPreview>('config_sync_prepare', { records });
    previewRecords = records;
    // A platform-specific reserved chord is a conflict even when only one
    // device edited it. Local choices are passed through the same CAS commit.
    try { validateShortcutRecords(preview.snapshot.records); }
    catch (error) {
      if (errorCode(error) !== 'SYNC_SHORTCUTS') throw error;
      const keys = new Set([...Object.keys(records), ...Object.keys(preview.snapshot.records)]);
      let hasChoice = false;
      for (const key of keys) if (key.startsWith('shortcuts/') && stable(records[key]) !== stable(preview.snapshot.records[key])) {
        hasChoice = true;
        if (!preview.conflicts.some(conflict => conflict.key === key)) {
          preview.conflicts.push({ key, local: records[key] ?? null, remote: preview.snapshot.records[key] ?? null });
        }
      }
      if (!hasChoice) throw error;
    }
    if (!preview.conflicts.length) buildStorageImage(preview.snapshot, readStorageImage(), view.status.options.credentials);
    update({ busy: false, preview, reviewOpen: manual, phase: preview.conflicts.length ? 'conflict' : 'review' });
    if (!manual && !preview.firstSync && !preview.conflicts.length) await commitSync({}, true);
  } catch (error) { fail(error); }
}

export async function commitSync(choices: SyncChoices, automatic = false): Promise<void> {
  const preview = view.preview;
  if (!preview || !previewRecords || view.busy || !view.status) return;
  if (editing()) {
    if (automatic) {
      previewRecords = null; due = Date.now() + 1000;
      update({ preview: null, reviewOpen: false, phase: 'pending', error: null });
    } else update({ error: 'SYNC_EDITING' });
    return;
  }
  update({ busy: true, error: null, phase: 'syncing' });
  let journalId: string | null = null;
  let unlock = (): void => {};
  try {
    const records = recordsNow();
    if (stable(records) !== stable(previewRecords)) throw new Error('SYNC_STALE');
    // Validate the selected public records before any remote mutation.
    buildStorageImage(resolvedPublicSnapshot(preview, choices), readStorageImage(), false);
    const batch = await invoke<SyncBatch>('config_sync_commit', { planId: preview.planId, records, choices });
    // Network I/O never holds a UI editing lock. If edits raced it, retain the
    // old baseline and merge again; never treat un-applied records as deletions.
    if (stable(recordsNow()) !== stable(records) || editing()) throw new Error('SYNC_STALE');
    unlock = lockInterface();
    const before = readStorageImage();
    const after = buildStorageImage(batch.snapshot, before, view.status.options.credentials);
    journalId = batch.id;
    await invoke('config_sync_stage_apply', { journal: { id: batch.id, before, after } });
    if (stable(readStorageImage()) !== stable(before)) throw new Error('SYNC_STALE');
    writeStorageImage(after);
    await invoke('config_sync_ack', { id: batch.id });
    await invoke('config_sync_finish_apply', { id: batch.id }); journalId = null;
    const now = new Date().toISOString();
    try { localStorage.setItem(LAST_SUCCESS, now); } catch { /* Nonessential status metadata. */ }
    observedImage = readStorageImage(); observedRecords = stable(recordsNow());
    previewRecords = null; failures = 0; retryAt = 0; due = Infinity; pullDue = Date.now() + 300_000;
    update({ phase: 'synced', busy: false, preview: null, reviewOpen: false, lastSuccess: now,
      status: { ...view.status, initialized: true, lastAppliedId: batch.id } });
    if (stable(before) !== stable(after)) notifyStores();
  } catch (error) {
    if (journalId) {
      try { await recoverConfigSync(); notifyStores(); }
      catch { fail('SYNC_RECOVERY_REQUIRED'); window.location.reload(); return; }
    }
    const code = errorCode(error);
    if (code === 'SYNC_STALE' || code === 'SYNC_WRITE_UNCERTAIN' || (automatic && isTransientError(code))) {
      previewRecords = null; update({ preview: null, reviewOpen: false });
    }
    fail(error);
  } finally { unlock(); }
}

function tick(): void {
  const status = view.status;
  if (!status?.options.enabled || status.options.paused || !status.unlocked || view.busy || view.preview || editing()) return;
  const now = Date.now();
  try {
    const image = readStorageImage();
    if (!observedImage || Object.keys(image).some(key => image[key] !== observedImage?.[key])) {
      observedImage = image;
      const fingerprint = stable(recordsNow());
      if (fingerprint !== observedRecords && (observedRecords || view.error)) {
        due = now + 10_000;
        if (!view.error?.startsWith('SYNC_RATE_LIMIT')) retryAt = 0;
      }
      observedRecords = fingerprint;
    }
    if (now >= retryAt && now >= Math.min(due, pullDue)) { due = Infinity; pullDue = now + 300_000; void prepareSync(false); }
  } catch (error) { if (view.error !== errorCode(error)) fail(error); }
}
function wake(): void {
  if (document.visibilityState === 'hidden') return;
  pullDue = Math.min(pullDue, Date.now() + 1000);
  if (retryAt !== Infinity && !view.error?.startsWith('SYNC_RATE_LIMIT')) retryAt = Math.min(retryAt, Date.now() + 1000);
}
export function startConfigSync(): () => void {
  if (!isTauri()) return () => {};
  if (++started === 1) {
    try { update({ lastSuccess: localStorage.getItem(LAST_SUCCESS) }); } catch { /* optional status metadata */ }
    void refreshSyncStatus().then(() => { due = Date.now() + 1500; }).catch(fail);
    timer = setInterval(tick, 1000);
    window.addEventListener('online', wake); window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
  }
  return () => {
    if (--started !== 0) return;
    clearInterval(timer); timer = undefined;
    window.removeEventListener('online', wake); window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
