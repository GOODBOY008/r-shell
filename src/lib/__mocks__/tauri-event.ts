/**
 * Mock for @tauri-apps/api/event
 */
export async function listen(_event: string, _handler: (...args: unknown[]) => void): Promise<() => void> {
  return () => {};
}
export async function emit(_event: string, _payload?: unknown): Promise<void> {}
export async function once(_event: string, _handler: (...args: unknown[]) => void): Promise<() => void> {
  return () => {};
}
