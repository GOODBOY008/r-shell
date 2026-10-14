/**
 * Folder path for a new connection, or undefined.
 *
 * "New connection" handlers are wired straight into `onClick`, so React hands
 * them a MouseEvent instead of a folder path. Anything that is not a
 * non-empty string is treated as "no folder" so an event object can never
 * end up as the saved connection's `folder` field (see issue #218).
 */
export function folderPathFromArg(arg: unknown): string | undefined {
  return typeof arg === 'string' && arg.length > 0 ? arg : undefined;
}
