import { invoke, isTauri } from '@tauri-apps/api/core';

// Focus can transfer between mounted RDP tabs while an IPC is in flight.
// Serialize all leases in this webview so a late acquire cannot revive a
// surface after its blur/unmount, and release only that surface's owner ID.
let captureQueue: Promise<void> = Promise.resolve();

export function installRdpKeyboardCapture(
  surface: HTMLElement,
  connectionId: string,
  onError: (error: unknown) => void,
): () => void {
  if (!navigator.platform.toUpperCase().includes('MAC') || !isTauri()) return () => {};

  const owner = crypto.randomUUID();
  let revision = 0;
  let disposed = false;
  let reportedError = false;
  const request = (capture: boolean) => {
    const requestedRevision = ++revision;
    captureQueue = captureQueue.catch(() => {}).then(async () => {
      if (requestedRevision !== revision) return;
      try {
        await invoke('rdp_set_keyboard_capture', { connectionId, owner, capture });
      } catch (error) {
        if (capture && !disposed && requestedRevision === revision && !reportedError) {
          reportedError = true;
          onError(error);
        }
      }
    });
  };
  const sync = () => request(!disposed && !document.hidden && document.hasFocus() && document.activeElement === surface);
  const release = () => request(false);
  const mouseDown = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, select, textarea, a[href], [role="button"]')) return;
    // Clicking back from a toolbar explicitly restores remote input focus.
    surface.focus();
    sync();
  };

  surface.addEventListener('focusin', sync);
  surface.addEventListener('focusout', release);
  surface.addEventListener('mousedown', mouseDown, true);
  window.addEventListener('blur', release);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    if (disposed) return;
    disposed = true;
    surface.removeEventListener('focusin', sync);
    surface.removeEventListener('focusout', release);
    surface.removeEventListener('mousedown', mouseDown, true);
    window.removeEventListener('blur', release);
    window.removeEventListener('focus', sync);
    document.removeEventListener('visibilitychange', sync);
    release();
  };
}
