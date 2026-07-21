/**
 * Mock for @tauri-apps/api/window
 */
export async function current(): Promise<{ label: string }> {
  return { label: 'main' };
}
export async function getCurrentWindow(): Promise<{ label: string }> {
  return { label: 'main' };
}
