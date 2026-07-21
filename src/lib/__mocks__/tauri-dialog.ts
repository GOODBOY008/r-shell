/**
 * Mock for @tauri-apps/plugin-dialog
 */
export async function open(_options?: Record<string, unknown>): Promise<string | null> {
  return null;
}
export async function save(_options?: Record<string, unknown>): Promise<string | null> {
  return null;
}
export async function message(_message: string): Promise<void> {}
export async function ask(_message: string): Promise<boolean> { return false; }
export async function confirm(_message: string): Promise<boolean> { return false; }
