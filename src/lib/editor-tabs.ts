import type { TerminalTab } from './terminal-group-types';

export interface EditorConnection {
  connectionId: string;
  savedConnectionId?: string;
  name: string;
  host?: string;
  username?: string;
  protocol?: string;
  status: TerminalTab['connectionStatus'];
}

export function createEditorTab(connection: EditorConnection, filePath: string, fileName: string): TerminalTab {
  return {
    id: `editor:${encodeURIComponent(connection.connectionId)}:${encodeURIComponent(filePath)}`,
    name: fileName,
    tabType: 'editor',
    protocol: connection.protocol ?? 'SSH',
    host: connection.host,
    username: connection.username,
    editorConnectionId: connection.connectionId,
    originalConnectionId: connection.savedConnectionId,
    editorConnectionName: connection.name,
    editorFilePath: filePath,
    connectionStatus: connection.status,
    reconnectCount: 0,
  };
}
