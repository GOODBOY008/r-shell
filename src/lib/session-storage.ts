/**
 * Session Storage Management
 * Handles saving, loading, and managing SSH sessions with hierarchical organization
 */

export interface SessionData {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: string;
  folder?: string; // Path to parent folder (e.g., 'All Sessions/Work')
  profileId?: string; // Link to connection profile if created from one
  createdAt: string;
  lastConnected?: string;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  description?: string;
  // Authentication details
  authMethod?: 'password' | 'publickey' | 'keyboard-interactive';
  password?: string; // Note: In production, this should be encrypted
  privateKeyPath?: string;
  passphrase?: string;
}

export interface SessionFolder {
  id: string;
  name: string;
  path: string; // Full path (e.g., 'All Sessions/Work/Production')
  parentPath?: string; // Parent folder path
  createdAt: string;
}

const SESSIONS_STORAGE_KEY = 'r-shell-sessions';
const FOLDERS_STORAGE_KEY = 'r-shell-session-folders';

export class SessionStorageManager {
  /**
   * Initialize default folder structure if not exists
   */
  static initialize(): void {
    const folders = this.getFolders();
    if (folders.length === 0) {
      // Create default folder structure
      this.createFolder('All Sessions', undefined);
      this.createFolder('Personal', 'All Sessions');
      this.createFolder('Work', 'All Sessions');
    }
  }

  /**
   * Get all saved sessions
   */
  static getSessions(): SessionData[] {
    try {
      const stored = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as SessionData[];
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }

  /**
   * Get a single session by ID
   */
  static getSession(id: string): SessionData | undefined {
    const sessions = this.getSessions();
    return sessions.find(s => s.id === id);
  }

  /**
   * Get sessions by folder path
   */
  static getSessionsByFolder(folderPath: string): SessionData[] {
    const sessions = this.getSessions();
    return sessions.filter(s => s.folder === folderPath);
  }

  /**
   * Save a new session
   */
  static saveSession(session: Omit<SessionData, 'id' | 'createdAt'>): SessionData {
    const sessions = this.getSessions();
    
    const newSession: SessionData = {
      ...session,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      folder: session.folder || 'All Sessions',
    };
    
    sessions.push(newSession);
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    
    return newSession;
  }

  /**
   * Update an existing session
   */
  static updateSession(id: string, updates: Partial<Omit<SessionData, 'id' | 'createdAt'>>): SessionData | null {
    const sessions = this.getSessions();
    const index = sessions.findIndex(s => s.id === id);
    
    if (index === -1) return null;
    
    sessions[index] = {
      ...sessions[index],
      ...updates,
    };
    
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    return sessions[index];
  }

  /**
   * Update last connected timestamp
   */
  static updateLastConnected(id: string): void {
    this.updateSession(id, {
      lastConnected: new Date().toISOString(),
    });
  }

  /**
   * Delete a session
   */
  static deleteSession(id: string): boolean {
    const sessions = this.getSessions();
    const filtered = sessions.filter(s => s.id !== id);
    
    if (filtered.length === sessions.length) return false;
    
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(filtered));
    return true;
  }

  /**
   * Move session to a different folder
   */
  static moveSession(sessionId: string, newFolderPath: string): boolean {
    return this.updateSession(sessionId, { folder: newFolderPath }) !== null;
  }

  /**
   * Get all folders
   */
  static getFolders(): SessionFolder[] {
    try {
      const stored = localStorage.getItem(FOLDERS_STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as SessionFolder[];
    } catch (error) {
      console.error('Failed to load folders:', error);
      return [];
    }
  }

  /**
   * Create a new folder
   */
  static createFolder(name: string, parentPath?: string): SessionFolder {
    const folders = this.getFolders();
    
    const path = parentPath ? `${parentPath}/${name}` : name;
    
    // Check if folder already exists
    const existing = folders.find(f => f.path === path);
    if (existing) return existing;
    
    const newFolder: SessionFolder = {
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
   * Delete a folder and all its sessions
   */
  static deleteFolder(path: string, deleteSubfolders: boolean = false): boolean {
    // Don't allow deleting root folder
    if (path === 'All Sessions') return false;
    
    const folders = this.getFolders();
    const sessions = this.getSessions();
    
    // Filter out the folder and optionally subfolders
    const filteredFolders = folders.filter(f => {
      if (f.path === path) return false;
      if (deleteSubfolders && f.path.startsWith(path + '/')) return false;
      return true;
    });
    
    // Filter out sessions in the folder and optionally subfolders
    const filteredSessions = sessions.filter(s => {
      if (s.folder === path) return false;
      if (deleteSubfolders && s.folder?.startsWith(path + '/')) return false;
      return true;
    });
    
    if (filteredFolders.length === folders.length) return false;
    
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(filteredFolders));
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(filteredSessions));
    
    return true;
  }

  /**
   * Get subfolders of a parent path
   */
  static getSubfolders(parentPath: string): SessionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.parentPath === parentPath);
  }

  /**
   * Build hierarchical session tree
   */
  static buildSessionTree(activeSessions: Set<string> = new Set()): SessionTreeNode[] {
    const folders = this.getFolders();
    const sessions = this.getSessions();
    
    // Build folder hierarchy
    const buildFolderTree = (parentPath?: string): SessionTreeNode[] => {
      const result: SessionTreeNode[] = [];
      
      // Get direct subfolders
      const subfolders = folders.filter(f => f.parentPath === parentPath);
      
      for (const folder of subfolders) {
        const folderNode: SessionTreeNode = {
          id: folder.id,
          name: folder.name,
          type: 'folder',
          path: folder.path,
          isExpanded: true,
          children: [
            ...buildFolderTree(folder.path),
            ...sessions
              .filter(s => s.folder === folder.path)
              .map(s => ({
                id: s.id,
                name: s.name,
                type: 'session' as const,
                protocol: s.protocol,
                host: s.host,
                username: s.username,
                port: s.port,
                profileId: s.profileId,
                lastConnected: s.lastConnected,
                isConnected: activeSessions.has(s.id),
                favorite: s.favorite,
                color: s.color,
                tags: s.tags,
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
   * Get favorite sessions
   */
  static getFavorites(): SessionData[] {
    return this.getSessions().filter(s => s.favorite);
  }

  /**
   * Get recent sessions (sorted by lastConnected)
   */
  static getRecentSessions(limit: number = 10): SessionData[] {
    const sessions = this.getSessions();
    return sessions
      .filter(s => s.lastConnected)
      .sort((a, b) => {
        const dateA = a.lastConnected ? new Date(a.lastConnected).getTime() : 0;
        const dateB = b.lastConnected ? new Date(b.lastConnected).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  /**
   * Export sessions as JSON
   */
  static exportSessions(): string {
    const sessions = this.getSessions();
    const folders = this.getFolders();
    return JSON.stringify({ sessions, folders }, null, 2);
  }

  /**
   * Import sessions from JSON
   */
  static importSessions(json: string, merge: boolean = false): number {
    try {
      const imported = JSON.parse(json) as {
        sessions: SessionData[];
        folders?: SessionFolder[];
      };
      
      if (!imported.sessions || !Array.isArray(imported.sessions)) {
        throw new Error('Invalid JSON format');
      }
      
      let sessions = merge ? this.getSessions() : [];
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
      
      // Import sessions with new IDs
      imported.sessions.forEach(session => {
        sessions.push({
          ...session,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        });
      });
      
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
      localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
      
      return imported.sessions.length;
    } catch (error) {
      console.error('Failed to import sessions:', error);
      throw error;
    }
  }

  /**
   * Clear all sessions and folders (use with caution!)
   */
  static clearAll(): void {
    localStorage.removeItem(SESSIONS_STORAGE_KEY);
    localStorage.removeItem(FOLDERS_STORAGE_KEY);
    this.initialize();
  }
}

/**
 * Session tree node structure for UI rendering
 */
export interface SessionTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'session';
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
  children?: SessionTreeNode[];
}

/**
 * Active Sessions Manager
 * Tracks currently open tabs for session persistence
 */
const ACTIVE_SESSIONS_KEY = 'r-shell-active-sessions';

export interface ActiveSessionState {
  tabId: string;
  sessionId: string;
  order: number;
}

export class ActiveSessionsManager {
  /**
   * Get active session states
   */
  static getActiveSessions(): ActiveSessionState[] {
    try {
      const stored = localStorage.getItem(ACTIVE_SESSIONS_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ActiveSessionState[];
    } catch (error) {
      console.error('Failed to load active sessions:', error);
      return [];
    }
  }

  /**
   * Save active session states
   */
  static saveActiveSessions(sessions: ActiveSessionState[]): void {
    localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(sessions));
  }

  /**
   * Clear active sessions
   */
  static clearActiveSessions(): void {
    localStorage.removeItem(ACTIVE_SESSIONS_KEY);
  }
}

// Initialize on module load
SessionStorageManager.initialize();
