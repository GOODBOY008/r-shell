/**
 * Drag payload helpers for the connection tree.
 *
 * WebKit (WKWebView, which Tauri uses on macOS) aborts a drag whose
 * `dataTransfer` carries no items, so `dragover`/`drop` never fire and the node
 * snaps back. Chromium (WebView2 on Windows) starts the drag regardless, which
 * is why this only reproduces on macOS. Always seed at least `text/plain`.
 */

export const CONNECTION_DRAG_MIME = 'application/x-r-shell-connection';

export interface DraggableConnectionNode {
  id: string;
  name: string;
}

/** Populate a dragstart dataTransfer so the drag survives on WebKit. */
export function applyConnectionDragData(
  dataTransfer: DataTransfer,
  node: DraggableConnectionNode,
): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData(CONNECTION_DRAG_MIME, node.id);
  // text/plain is the format WebKit actually checks for.
  dataTransfer.setData('text/plain', node.name);
}

/** Read back the dragged connection id, if this drag originated in the tree. */
export function readConnectionDragId(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData(CONNECTION_DRAG_MIME) || null;
}
