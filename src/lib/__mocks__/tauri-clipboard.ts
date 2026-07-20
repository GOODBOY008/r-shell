/**
 * Mock for @tauri-apps/plugin-clipboard-manager
 */
export async function writeText(_text: string): Promise<void> {}
export async function readText(): Promise<string> { return ''; }
