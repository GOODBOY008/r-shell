/**
 * Registry of live PTY terminal detach functions, keyed by connectionId.
 *
 * The PtyTerminal component owns the WebSocket connection and the PTY session
 * generation, so only it can send the `Detach` WS message correctly. Tab-bar
 * context menus live outside the terminal tree, so App.tsx uses this registry
 * to ask the mounted terminal to perform the detach handshake.
 */
type DetachFn = () => void;

const detachHandlers = new Map<string, DetachFn>();

export function registerDetachHandler(connectionId: string, fn: DetachFn): () => void {
  detachHandlers.set(connectionId, fn);
  return () => {
    if (detachHandlers.get(connectionId) === fn) {
      detachHandlers.delete(connectionId);
    }
  };
}

/** Invoke the mounted terminal's detach handshake if one is registered. */
export function requestDetach(connectionId: string): boolean {
  const fn = detachHandlers.get(connectionId);
  if (fn) {
    fn();
    return true;
  }
  return false;
}
