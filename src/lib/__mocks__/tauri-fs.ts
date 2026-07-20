/**
 * Mock for @tauri-apps/plugin-fs
 */
export async function exists(_path: string): Promise<boolean> { return false; }
export async function readTextFile(_path: string): Promise<string> { return ''; }
export async function writeTextFile(_path: string, _contents: string): Promise<void> {}
export async function readDir(_path: string): Promise<[]> { return []; }
export async function mkdir(_path: string): Promise<void> {}
export async function remove(_path: string): Promise<void> {}
