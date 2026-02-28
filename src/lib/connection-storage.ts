/**
 * Connection Storage Management
 * Handles saving, loading, and managing SSH connections with hierarchical organization
 */

export interface ConnectionData {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: string;
  folder?: string; // Path to parent folder (e.g., 'All Connections/Work')
  profileId?: string; // Link to connection profile if created from one
  createdAt: string;
  lastConnected?: string;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  description?: string;
  // Authentication details
  authMethod?: 'password' | 'publickey' | 'keyboard-interactive' | 'anonymous';
  password?: string; // Note: In production, this should be encrypted
  privateKeyPath?: string;
  passphrase?: string;
  // FTP-specific
  ftpsEnabled?: boolean;
}

export interface ConnectionFolder {
  id: string;
  name: string;
  path: string; // Full path (e.g., 'All Connections/Work/Production')
  parentPath?: string; // Parent folder path
  createdAt: string;
}

const CONNECTIONS_STORAGE_KEY = 'r-shell-connections';
const FOLDERS_STORAGE_KEY = 'r-shell-connection-folders';

// Legacy keys for migration
const LEGACY_SESSIONS_STORAGE_KEY = 'r-shell-sessions';
const LEGACY_FOLDERS_STORAGE_KEY = 'r-shell-session-folders';

export class ConnectionStorageManager {
  /**
   * Migrate data from old session storage to new connection storage
   */
  private static migrateFromSessionStorage(): void {
    try {
      // Check if migration is needed
      const hasNewData = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
      const hasLegacyData = localStorage.getItem(LEGACY_SESSIONS_STORAGE_KEY);
      
      if (!hasNewData && hasLegacyData) {
        console.log('[Migration] Migrating session data to connection data...');
        
        // Migrate sessions to connections
        const legacySessions = localStorage.getItem(LEGACY_SESSIONS_STORAGE_KEY);
        if (legacySessions) {
          const sessions = JSON.parse(legacySessions);
          // Update folder paths from "All Sessions" to "All Connections"
          const connections = sessions.map((session: any) => ({
            ...session,
            folder: session.folder?.replace(/All Sessions/g, 'All Connections')
          }));
          localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
          console.log(`[Migration] Migrated ${connections.length} sessions to connections`);
        }
        
        // Migrate folders
        const legacyFolders = localStorage.getItem(LEGACY_FOLDERS_STORAGE_KEY);
        if (legacyFolders) {
          const folders = JSON.parse(legacyFolders);
          // Update folder names and paths
          const connectionFolders = folders.map((folder: any) => ({
            ...folder,
            name: folder.name.replace(/All Sessions/g, 'All Connections'),
            path: folder.path.replace(/All Sessions/g, 'All Connections'),
            parentPath: folder.parentPath?.replace(/All Sessions/g, 'All Connections')
          }));
          localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(connectionFolders));
          console.log(`[Migration] Migrated ${connectionFolders.length} session folders to connection folders`);
        }
        
        console.log('[Migration] Migration completed successfully');
      }
    } catch (error) {
      console.error('[Migration] Failed to migrate session data:', error);
    }
  }

  /**
   * Initialize default folder structure if not exists
   */
  static initialize(): void {
    // First, try to migrate legacy data
    this.migrateFromSessionStorage();
    
    const folders = this.getFolders();
    if (folders.length === 0) {
      // Create default folder structure
      this.createFolder('All Connections', undefined);
      this.createFolder('Personal', 'All Connections');
      this.createFolder('Work', 'All Connections');
    }
  }

  /**
   * Get all saved connections
   */
  static getConnections(): ConnectionData[] {
    try {
      const stored = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ConnectionData[];
    } catch (error) {
      console.error('Failed to load connections:', error);
      return [];
    }
  }

  /**
   * Get a single connection by ID
   */
  static getConnection(id: string): ConnectionData | undefined {
    const connections = this.getConnections();
    return connections.find(c => c.id === id);
  }

  /**
   * Get connections by folder path
   */
  static getConnectionsByFolder(folderPath: string): ConnectionData[] {
    const connections = this.getConnections();
    return connections.filter(c => c.folder === folderPath);
  }

  /**
   * Get all connections in a folder and its subfolders (recursive)
   */
  static getConnectionsByFolderRecursive(folderPath: string): ConnectionData[] {
    const connections = this.getConnections();
    return connections.filter(c => c.folder === folderPath || c.folder?.startsWith(folderPath + '/'));
  }

  /**
   * Get all subfolders recursively
   */
  static getSubfoldersRecursive(folderPath: string): ConnectionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.path.startsWith(folderPath + '/'));
  }

  /**
   * Save a new connection
   */
  static saveConnection(connection: Omit<ConnectionData, 'id' | 'createdAt'>): ConnectionData {
    const connections = this.getConnections();

    const newConnection: ConnectionData = {
      ...connection,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      folder: connection.folder || 'All Connections',
    };

    connections.push(newConnection);
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));

    return newConnection;
  }

  /**
   * Save a new connection with a specific ID
   * This is used to ensure the connection ID matches the tab ID for proper tracking
   */
  static saveConnectionWithId(id: string, connection: Omit<ConnectionData, 'id' | 'createdAt'>): ConnectionData {
    const connections = this.getConnections();

    // Check if connection with this ID already exists
    const existingIndex = connections.findIndex(c => c.id === id);

    const newConnection: ConnectionData = {
      ...connection,
      id,
      createdAt: new Date().toISOString(),
      lastConnected: new Date().toISOString(),
      folder: connection.folder || 'All Connections',
    };

    if (existingIndex !== -1) {
      // Update existing connection
      connections[existingIndex] = newConnection;
    } else {
      // Add new connection
      connections.push(newConnection);
    }

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));

    return newConnection;
  }

  /**
   * Update an existing connection
   */
  static updateConnection(id: string, updates: Partial<Omit<ConnectionData, 'id' | 'createdAt'>>): ConnectionData | null {
    const connections = this.getConnections();
    const index = connections.findIndex(c => c.id === id);

    if (index === -1) return null;

    connections[index] = {
      ...connections[index],
      ...updates,
    };

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    return connections[index];
  }

  /**
   * Update last connected timestamp
   */
  static updateLastConnected(id: string): void {
    this.updateConnection(id, {
      lastConnected: new Date().toISOString(),
    });
  }

  /**
   * Delete a connection
   */
  static deleteConnection(id: string): boolean {
    const connections = this.getConnections();
    const filtered = connections.filter(c => c.id !== id);

    if (filtered.length === connections.length) return false;

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(filtered));
    return true;
  }

  /**
   * Move connection to a different folder
   */
  static moveConnection(connectionId: string, newFolderPath: string): boolean {
    return this.updateConnection(connectionId, { folder: newFolderPath }) !== null;
  }

  /**
   * Get all folders
   */
  static getFolders(): ConnectionFolder[] {
    try {
      const stored = localStorage.getItem(FOLDERS_STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ConnectionFolder[];
    } catch (error) {
      console.error('Failed to load folders:', error);
      return [];
    }
  }

  /**
   * Create a new folder
   */
  static createFolder(name: string, parentPath?: string): ConnectionFolder {
    const folders = this.getFolders();

    const path = parentPath ? `${parentPath}/${name}` : name;

    // Check if folder already exists
    const existing = folders.find(f => f.path === path);
    if (existing) return existing;

    const newFolder: ConnectionFolder = {
      id: crypto.randomUUID(),
      name,
      path,
      parentPath,
      createdAt: new Date().toISOString(),
    };

    folders.push(newFolder);
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));

    return newFolder;
  }

  /**
   * Delete a folder and all its connections
   */
  static deleteFolder(path: string, deleteSubfolders: boolean = false): boolean {
    // Don't allow deleting root folder
    if (path === 'All Connections') return false;

    const folders = this.getFolders();
    const connections = this.getConnections();

    // Filter out the folder and optionally subfolders
    const filteredFolders = folders.filter(f => {
      if (f.path === path) return false;
      if (deleteSubfolders && f.path.startsWith(path + '/')) return false;
      return true;
    });

    // Filter out connections in the folder and optionally subfolders
    const filteredConnections = connections.filter(c => {
      if (c.folder === path) return false;
      if (deleteSubfolders && c.folder?.startsWith(path + '/')) return false;
      return true;
    });

    if (filteredFolders.length === folders.length) return false;

    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(filteredFolders));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(filteredConnections));

    return true;
  }

  /**
   * Get subfolders of a parent path
   */
  static getSubfolders(parentPath: string): ConnectionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.parentPath === parentPath);
  }

  /**
   * Get all valid folders that are part of the tree hierarchy
   * This excludes orphaned folders that don't have a valid parent chain
   */
  static getValidFolders(): ConnectionFolder[] {
    const allFolders = this.getFolders();
    const validPaths = new Set<string>();

    // Recursively collect valid folder paths starting from root
    const collectValidPaths = (parentPath?: string) => {
      const children = allFolders.filter(f => f.parentPath === parentPath);
      for (const child of children) {
        validPaths.add(child.path);
        collectValidPaths(child.path);
      }
    };

    collectValidPaths(undefined);

    return allFolders.filter(f => validPaths.has(f.path));
  }

  /**
   * Build hierarchical connection tree
   */
  static buildConnectionTree(activeConnections: Set<string> = new Set()): ConnectionTreeNode[] {
    const folders = this.getFolders();
    const connections = this.getConnections();

    // Build folder hierarchy
    const buildFolderTree = (parentPath?: string): ConnectionTreeNode[] => {
      const result: ConnectionTreeNode[] = [];

      // Get direct subfolders
      const subfolders = folders.filter(f => f.parentPath === parentPath);

      for (const folder of subfolders) {
        const folderNode: ConnectionTreeNode = {
          id: folder.id,
          name: folder.name,
          type: 'folder',
          path: folder.path,
          isExpanded: true,
          children: [
            ...buildFolderTree(folder.path),
            ...connections
              .filter(c => c.folder === folder.path)
              .map(c => ({
                id: c.id,
                name: c.name,
                type: 'connection' as const,
                protocol: c.protocol,
                host: c.host,
                username: c.username,
                port: c.port,
                profileId: c.profileId,
                lastConnected: c.lastConnected,
                isConnected: activeConnections.has(c.id),
                favorite: c.favorite,
                color: c.color,
                tags: c.tags,
              }))
          ],
        };
        result.push(folderNode);
      }

      return result;
    };

    // Start from root
    return buildFolderTree(undefined);
  }

  /**
   * Get favorite connections
   */
  static getFavorites(): ConnectionData[] {
    return this.getConnections().filter(c => c.favorite);
  }

  /**
   * Get recent connections (sorted by lastConnected)
   */
  static getRecentConnections(limit: number = 10): ConnectionData[] {
    const connections = this.getConnections();
    return connections
      .filter(c => c.lastConnected)
      .sort((a, b) => {
        const dateA = a.lastConnected ? new Date(a.lastConnected).getTime() : 0;
        const dateB = b.lastConnected ? new Date(b.lastConnected).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  /**
   * Export connections as JSON
   */
  static exportConnections(): string {
    const connections = this.getConnections();
    const folders = this.getFolders();
    return JSON.stringify({ connections, folders }, null, 2);
  }

  /**
   * Import connections from JSON
   */
  static importConnections(json: string, merge: boolean = false): number {
    try {
      const imported = JSON.parse(json) as {
        connections: ConnectionData[];
        folders?: ConnectionFolder[];
      };

      if (!imported.connections || !Array.isArray(imported.connections)) {
        throw new Error('Invalid JSON format');
      }

      let connections = merge ? this.getConnections() : [];
      let folders = merge ? this.getFolders() : [];

      // Import folders with new IDs
      if (imported.folders) {
        imported.folders.forEach(folder => {
          if (!folders.find(f => f.path === folder.path)) {
            folders.push({
              ...folder,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            });
          }
        });
      }

      // Import connections with new IDs
      imported.connections.forEach(connection => {
        connections.push({
          ...connection,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        });
      });

      localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
      localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));

      return imported.connections.length;
    } catch (error) {
      console.error('Failed to import connections:', error);
      throw error;
    }
  }

  /**
   * Clear all connections and folders (use with caution!)
   */
  static clearAll(): void {
    localStorage.removeItem(CONNECTIONS_STORAGE_KEY);
    localStorage.removeItem(FOLDERS_STORAGE_KEY);
    this.initialize();
  }
}

/**
 * Connection tree node structure for UI rendering
 */
export interface ConnectionTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  profileId?: string;
  lastConnected?: string;
  isConnected?: boolean;
  isExpanded?: boolean;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  children?: ConnectionTreeNode[];
}

/**
 * Active Connections Manager
 * Tracks currently open tabs for connection persistence
 */
const ACTIVE_CONNECTIONS_KEY = 'r-shell-active-connections';
const LEGACY_ACTIVE_SESSIONS_KEY = 'r-shell-active-sessions';

export interface ActiveConnectionState {
  tabId: string;
  connectionId: string;
  order: number;
  originalConnectionId?: string; // For duplicated tabs, reference to the original connection
  tabType?: 'terminal' | 'file-browser'; // Tab type for SFTP/FTP vs SSH
  protocol?: string; // Protocol used (SSH, SFTP, FTP)
}

export class ActiveConnectionsManager {
  /**
   * Migrate active sessions to active connections
   */
  private static migrateFromActiveSessions(): void {
    try {
      const hasNewData = localStorage.getItem(ACTIVE_CONNECTIONS_KEY);
      const hasLegacyData = localStorage.getItem(LEGACY_ACTIVE_SESSIONS_KEY);
      
      if (!hasNewData && hasLegacyData) {
        console.log('[Migration] Migrating active sessions to active connections...');
        const legacySessions = JSON.parse(hasLegacyData);
        
        // Convert old ActiveSessionState to new ActiveConnectionState
        const activeConnections = legacySessions.map((session: any) => ({
          tabId: session.tabId,
          connectionId: session.sessionId,
          order: session.order,
          originalConnectionId: session.originalSessionId
        }));
        
        localStorage.setItem(ACTIVE_CONNECTIONS_KEY, JSON.stringify(activeConnections));
        console.log(`[Migration] Migrated ${activeConnections.length} active sessions to active connections`);
      }
    } catch (error) {
      console.error('[Migration] Failed to migrate active sessions:', error);
    }
  }

  /**
   * Get active connection states
   */
  static getActiveConnections(): ActiveConnectionState[] {
    try {
      // Try migration first
      this.migrateFromActiveSessions();
      
      const stored = localStorage.getItem(ACTIVE_CONNECTIONS_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ActiveConnectionState[];
    } catch (error) {
      console.error('Failed to load active connections:', error);
      return [];
    }
  }

  /**
   * Save active connection states
   */
  static saveActiveConnections(connections: ActiveConnectionState[]): void {
    localStorage.setItem(ACTIVE_CONNECTIONS_KEY, JSON.stringify(connections));
  }

  /**
   * Clear active connections
   */
  static clearActiveConnections(): void {
    localStorage.removeItem(ACTIVE_CONNECTIONS_KEY);
  }
}

// Initialize on module load
ConnectionStorageManager.initialize();