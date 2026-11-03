import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useTerminalGroups } from './terminal-group-context';
import type { TerminalTab } from './terminal-group-types';
import type { SessionHealth } from './session-health';

interface EditorHandle {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  focus: () => void;
}

interface EditorTabsContextValue {
  register: (tabId: string, editor: EditorHandle) => () => void;
  reportDirty: (tabId: string, dirty: boolean) => void;
  dirtyTabIds: ReadonlySet<string>;
  confirmCloseTabs: (tabIds: string[]) => Promise<boolean>;
  focusTab: (tabId: string) => void;
}

const EditorTabsContext = createContext<EditorTabsContextValue | null>(null);

export function useEditorTabs() {
  return useContext(EditorTabsContext);
}

/** One guard for all embedded editors. Hidden tabs retain their mounted buffers;
 * a close/quit resolves them sequentially without overlapping modal dialogs. */
export function EditorTabsProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { state, dispatch } = useTerminalGroups();
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  const editors = useRef(new Map<string, EditorHandle>());
  const [dirtyTabIds, setDirtyTabIds] = useState<ReadonlySet<string>>(new Set());
  const [prompt, setPrompt] = useState<TerminalTab | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const resolvePrompt = useRef<((approved: boolean) => void) | null>(null);
  const closeInFlight = useRef(false);
  const quitInFlight = useRef(false);
  const mounted = useRef(true);

  const reportDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyTabIds(previous => {
      if (previous.has(tabId) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  const register = useCallback((tabId: string, editor: EditorHandle) => {
    editors.current.set(tabId, editor);
    return () => {
      editors.current.delete(tabId);
      reportDirty(tabId, false);
    };
  }, [reportDirty]);

  const focusTab = useCallback((tabId: string) => {
    requestAnimationFrame(() => editors.current.get(tabId)?.focus());
  }, []);

  const finishPrompt = useCallback((approved: boolean) => {
    const resolve = resolvePrompt.current;
    resolvePrompt.current = null;
    setPrompt(null);
    setSaveFailed(false);
    resolve?.(approved);
  }, []);

  const confirmCloseTabs = useCallback(async (tabIds: string[]) => {
    // Repeated close shortcuts never stack confirmations or close a second tab
    // behind the current prompt. Bulk actions submit one batch.
    if (closeInFlight.current) return false;
    closeInFlight.current = true;
    try {
      for (const tabId of new Set(tabIds)) {
        if (!editors.current.get(tabId)?.isDirty()) continue;
        const current = stateRef.current;
        const groupId = current.tabToGroupMap[tabId];
        const tab = current.groups[groupId]?.tabs.find(item => item.id === tabId);
        if (!tab || !mounted.current) return false;
        dispatch({ type: 'ACTIVATE_GROUP', groupId });
        dispatch({ type: 'ACTIVATE_TAB', groupId, tabId });
        setSaveFailed(false);
        setPrompt(tab);
        const approved = await new Promise<boolean>(resolve => { resolvePrompt.current = resolve; });
        if (!approved) return false;
      }
      return true;
    } finally {
      closeInFlight.current = false;
    }
  }, [dispatch]);

  const savePrompt = async () => {
    if (!prompt || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      if (await editors.current.get(prompt.id)?.save()) finishPrompt(true);
      else setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolvePrompt.current?.(false);
      resolvePrompt.current = null;
    };
  }, []);

  // Main is a single participant in the native quit guard. One clean editor
  // must never clear another editor's unsaved state. During a quit, only the
  // completed batch may resolve main's pending decision.
  useEffect(() => {
    if (!quitInFlight.current) {
      void invoke('editor_dirty_changed', { label: 'main', dirty: dirtyTabIds.size > 0 }).catch(() => {});
    }
  }, [dirtyTabIds]);

  useEffect(() => {
    let disposed = false;
    const unlisten = listen('confirm-quit', () => {
      if (disposed || quitInFlight.current) return;
      const dirtyIds = [...editors.current].filter(([, editor]) => editor.isDirty()).map(([id]) => id);
      if (dirtyIds.length === 0) return;
      quitInFlight.current = true;
      void (async () => {
        // Offline buffers can outlive every backend session, so the native
        // session gate may not have revealed main. Restore it before prompting;
        // a failed window operation must not abort the remaining steps.
        const main = getCurrentWindow();
        await main.show().catch(() => {});
        await main.unminimize().catch(() => {});
        await main.setFocus().catch(() => {});
        const approved = await confirmCloseTabs(dirtyIds);
        if (!approved) await invoke('cancel_app_quit').catch(() => {});
        quitInFlight.current = false;
        const dirty = !approved && [...editors.current.values()].some(editor => editor.isDirty());
        await invoke('editor_dirty_changed', { label: 'main', dirty }).catch(() => {});
      })();
    });
    return () => {
      disposed = true;
      void unlisten.then(fn => fn()).catch(() => {});
    };
  }, [confirmCloseTabs]);

  // macOS hides the main window and preserves all buffers. On other platforms
  // closing main destroys its webview, so route a dirty close through quit.
  useEffect(() => {
    if (navigator.platform.toUpperCase().includes('MAC')) return;
    let disposed = false;
    try {
      const unlisten = getCurrentWindow().onCloseRequested(event => {
        if (disposed || ![...editors.current.values()].some(editor => editor.isDirty())) return;
        event.preventDefault();
        void invoke('request_app_quit').catch(() => {});
      });
      return () => {
        disposed = true;
        void unlisten.then(fn => fn()).catch(() => {});
      };
    } catch { /* Browser preview. */ }
  }, []);

  // Poll each shared file connection once. Saving remains available after
  // its source tab closes, and reconnecting keeps the editor buffers.
  const connectionsKey = JSON.stringify([...new Set(Object.values(state.groups)
    .flatMap(group => group.tabs)
    .filter(tab => tab.tabType === 'editor')
    .map(tab => tab.editorConnectionId)
    .filter((id): id is string => !!id))].sort());
  useEffect(() => {
    const connectionIds = JSON.parse(connectionsKey) as string[];
    if (connectionIds.length === 0) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await Promise.all(connectionIds.map(async connectionId => {
        try {
          const health = await invoke<SessionHealth>('get_session_health', { connectionId });
          if (disposed || typeof health?.sshConnected !== 'boolean') return;
          const status = (health.fileConnected ?? health.sshConnected) ? 'connected' : 'disconnected';
          for (const group of Object.values(stateRef.current.groups)) {
            for (const tab of group.tabs) {
              if (tab.editorConnectionId === connectionId && tab.connectionStatus !== status) {
                dispatch({ type: 'UPDATE_TAB_STATUS', tabId: tab.id, status });
              }
            }
          }
        } catch { /* Retry transient IPC failures on the next poll. */ }
      }));
      if (!disposed) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [connectionsKey, dispatch]);

  const value = useMemo(() => ({ register, reportDirty, dirtyTabIds, confirmCloseTabs, focusTab }),
    [register, reportDirty, dirtyTabIds, confirmCloseTabs, focusTab]);

  return (
    <EditorTabsContext.Provider value={value}>
      {children}
      <AlertDialog open={!!prompt} onOpenChange={open => { if (!open && !saving) finishPrompt(false); }}>
        <AlertDialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 h-fit max-h-[calc(100vh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('fileEditorView.unsavedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('fileEditorView.unsavedDescription', { fileName: prompt?.name })}</AlertDialogDescription>
            <p className="text-xs text-muted-foreground break-all">{prompt?.host} · {prompt?.editorFilePath}</p>
          </AlertDialogHeader>
          {saveFailed && <p role="alert" className="text-sm text-destructive">{t('fileEditorView.closeSaveFailed')}</p>}
          <AlertDialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => finishPrompt(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={saving} onClick={() => finishPrompt(true)}>{t('fileEditorView.discardAndClose')}</Button>
            <Button disabled={saving} onClick={() => void savePrompt()}>{t(saving ? 'fileEditorView.saving' : 'common.save')}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </EditorTabsContext.Provider>
  );
}

/** Registers a mounted editor without replacing its handle as the user types. */
export function useEditorTab(tabId: string | undefined, dirty: boolean, save: () => Promise<boolean>, focus: () => void) {
  const context = useEditorTabs();
  const register = context?.register;
  const reportDirty = context?.reportDirty;
  const latest = useRef({ dirty, save, focus });
  useLayoutEffect(() => { latest.current = { dirty, save, focus }; }, [dirty, save, focus]);
  useLayoutEffect(() => {
    if (!tabId || !register) return;
    return register(tabId, {
      isDirty: () => latest.current.dirty,
      save: () => latest.current.save(),
      focus: () => latest.current.focus(),
    });
  }, [tabId, register]);
  useLayoutEffect(() => {
    if (tabId) reportDirty?.(tabId, dirty);
  }, [tabId, dirty, reportDirty]);
}
