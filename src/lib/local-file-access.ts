import { invoke } from '@tauri-apps/api/core';
import { readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

/**
 * Grant the fs plugin access to a single local file.
 *
 * The app's capability no longer allows the whole disk to the webview, so a
 * file has to be granted before the fs plugin may read or write it. The
 * frontend calls this right after the user picked a file in a native dialog.
 *
 * This is defence in depth, not a trust boundary: the path comes from the
 * webview, so a script running in the main window could ask for any path it
 * likes. Opening the dialog from Rust and returning the picked path is the
 * follow-up that would bind the grant to a real user gesture.
 */
export async function authorizeLocalFile(path: string): Promise<void> {
  await invoke('authorize_local_file', { path });
}

/**
 * Read a local text file, granting the fs plugin access to it first.
 *
 * The grant has to happen before the read: the fs plugin rejects paths that
 * are not in the scope, so a read without a grant fails with "forbidden path".
 */
export async function readLocalTextFile(path: string): Promise<string> {
  await authorizeLocalFile(path);
  return readTextFile(path);
}

/** Write a local text file, granting the fs plugin access to it first. */
export async function writeLocalTextFile(path: string, contents: string): Promise<void> {
  await authorizeLocalFile(path);
  await writeTextFile(path, contents);
}

/** Read a local binary file (e.g. a background image), granting access first. */
export async function readLocalBinaryFile(path: string): Promise<Uint8Array> {
  await authorizeLocalFile(path);
  return readFile(path);
}
