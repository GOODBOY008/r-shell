import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Monitor, Server, HardDrive, Plus, Pencil, Copy, Trash2, FolderPlus } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { SessionStorageManager } from '../lib/session-storage';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { toast } from 'sonner';

interface SessionNode {
  id: string;
  name: string;
  type: 'folder' | 'session';
  path?: string; // For folders
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  profileId?: string;
  lastConnected?: string;
  isConnected?: boolean;
  children?: SessionNode[];
  isExpanded?: boolean;
}

interface SessionManagerProps {
  onSessionSelect: (session: SessionNode) => void;
  selectedSessionId: string | null;
  activeSessions?: Set<string>; // Set of currently active session IDs
  onNewConnection?: () => void; // Callback to open connection dialog
  onEditSession?: (session: SessionNode) => void; // Callback to edit session
  onDeleteSession?: (sessionId: string) => void; // Callback to delete session
  onDuplicateSession?: (session: SessionNode) => void; // Callback to duplicate session
}

export function SessionManager({ 
  onSessionSelect, 
  selectedSessionId, 
  activeSessions = new Set(), 
  onNewConnection,
  onEditSession,
  onDeleteSession,
  onDuplicateSession
}: SessionManagerProps) {
  // Load sessions from storage
  const loadSessions = (): SessionNode[] => {
    const tree = SessionStorageManager.buildSessionTree(activeSessions);
    return tree.length > 0 ? tree : [];
  };

  const [sessions, setSessions] = useState<SessionNode[]>(loadSessions());
  
  // Folder management state
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentPath, setNewFolderParentPath] = useState<string | undefined>(undefined);
  const [deleteFolderDialogOpen, setDeleteFolderDialogOpen] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ path: string; name: string } | null>(null);

  // Reload sessions when active sessions change
  useEffect(() => {
    setSessions(loadSessions());
  }, [activeSessions]);

  // Handle session deletion
  const handleDelete = (sessionId: string) => {
    if (SessionStorageManager.deleteSession(sessionId)) {
      setSessions(loadSessions());
      toast.success('Session deleted');
      if (onDeleteSession) {
        onDeleteSession(sessionId);
      }
    } else {
      toast.error('Failed to delete session');
    }
  };

  // Handle session duplication
  const handleDuplicate = (node: SessionNode) => {
    if (node.type === 'session' && node.host) {
      // Load the full session data to get authentication credentials
      const sessionData = SessionStorageManager.getSession(node.id);
      if (sessionData) {
        const duplicated = SessionStorageManager.saveSession({
          name: `${node.name} (Copy)`,
          host: node.host,
          port: node.port || 22,
          username: node.username || '',
          protocol: node.protocol || 'SSH',
          folder: sessionData.folder || 'All Sessions',
          // Copy authentication credentials
          authMethod: sessionData.authMethod,
          password: sessionData.password,
          privateKeyPath: sessionData.privateKeyPath,
          passphrase: sessionData.passphrase,
        });
        setSessions(loadSessions());
        toast.success(`Duplicated: ${duplicated.name}`);
        if (onDuplicateSession) {
          onDuplicateSession(node);
        }
      }
    }
  };
  
  // Handle creating new folder
  const handleCreateFolder = () => {
    if (!newFolderName.trim()) {
      toast.error('Folder name cannot be empty');
      return;
    }
    
    try {
      SessionStorageManager.createFolder(newFolderName.trim(), newFolderParentPath);
      setSessions(loadSessions());
      toast.success(`Folder "${newFolderName}" created`);
      setNewFolderDialogOpen(false);
      setNewFolderName('');
      setNewFolderParentPath(undefined);
    } catch (error) {
      toast.error('Failed to create folder');
    }
  };
  
  // Handle deleting folder
  const handleDeleteFolder = () => {
    if (!folderToDelete) return;
    
    if (SessionStorageManager.deleteFolder(folderToDelete.path, true)) {
      setSessions(loadSessions());
      toast.success(`Folder "${folderToDelete.name}" deleted`);
      setDeleteFolderDialogOpen(false);
      setFolderToDelete(null);
    } else {
      toast.error('Failed to delete folder');
    }
  };
  
  // Open new folder dialog
  const openNewFolderDialog = (parentPath?: string) => {
    setNewFolderParentPath(parentPath);
    setNewFolderDialogOpen(true);
  };
  
  // Open delete folder dialog
  const openDeleteFolderDialog = (path: string, name: string) => {
    setFolderToDelete({ path, name });
    setDeleteFolderDialogOpen(true);
  };
  
  // Find the selected session details
  const getSelectedSession = (nodes: SessionNode[]): SessionNode | null => {
    for (const node of nodes) {
      if (node.id === selectedSessionId) {
        return node;
      }
      if (node.children) {
        const found = getSelectedSession(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  
  const selectedSession = getSelectedSession(sessions);

  const toggleExpanded = (nodeId: string) => {
    const updateNode = (nodes: SessionNode[]): SessionNode[] => {
      return nodes.map(node => {
        if (node.id === nodeId) {
          return { ...node, isExpanded: !node.isExpanded };
        }
        if (node.children) {
          return { ...node, children: updateNode(node.children) };
        }
        return node;
      });
    };
    setSessions(updateNode(sessions));
  };

  const getIcon = (node: SessionNode) => {
    if (node.type === 'folder') {
      return node.isExpanded ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />;
    }
    
    switch (node.protocol) {
      case 'SSH':
        return <Server className="w-4 h-4 text-green-500" />;
      case 'CMD':
      case 'PowerShell':
      case 'Shell':
        return <Monitor className="w-4 h-4 text-blue-500" />;
      case 'WSL':
        return <HardDrive className="w-4 h-4 text-orange-500" />;
      default:
        return <Monitor className="w-4 h-4" />;
    }
  };

  const renderNode = (node: SessionNode, level: number = 0) => {
    const isSelected = selectedSessionId === node.id;
    const isConnected = node.type === 'session' && node.isConnected;
    
    const handleNodeClick = () => {
      if (node.type === 'folder') {
        toggleExpanded(node.id);
      } else {
        onSessionSelect(node);
      }
    };

    const handleContextMenu = () => {
      // Select/highlight the node when right-clicking
      // This helps users know which item the context menu will operate on
      // Only select if not already selected to avoid unnecessary updates
      if (!isSelected) {
        onSessionSelect(node);
      }
    };
    
    const nodeContent = (
      <div
        className={`flex items-center gap-2 px-2 py-1 hover:bg-accent cursor-pointer ${
          isSelected ? 'bg-accent' : ''
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleNodeClick}
        onContextMenu={handleContextMenu}
      >
        {node.type === 'folder' && (
          <Button variant="ghost" size="sm" className="p-0 h-4 w-4">
            {node.isExpanded ? 
              <ChevronDown className="w-3 h-3" /> : 
              <ChevronRight className="w-3 h-3" />
            }
          </Button>
        )}
        {node.type === 'session' && <div className="w-4" />}
        
        <div className="relative">
          {getIcon(node)}
          {isConnected && (
            <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full border border-card" />
          )}
        </div>
        <span className="text-sm flex-1">{node.name}</span>
      </div>
    );
    
    return (
      <div key={node.id}>
        {node.type === 'session' ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              {nodeContent}
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => onSessionSelect(node)}
              >
                {isConnected ? 'Switch to Session' : 'Connect'}
              </ContextMenuItem>
              {onEditSession && (
                <ContextMenuItem
                  onClick={() => onEditSession(node)}
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit
                </ContextMenuItem>
              )}
              <ContextMenuItem
                onClick={() => handleDuplicate(node)}
              >
                <Copy className="w-4 h-4 mr-2" />
                Duplicate
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => handleDelete(node.id)}
                className="text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : node.type === 'folder' ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              {nodeContent}
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => openNewFolderDialog(node.path)}
              >
                <FolderPlus className="w-4 h-4 mr-2" />
                New Subfolder
              </ContextMenuItem>
              {node.path !== 'All Sessions' && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => openDeleteFolderDialog(node.path!, node.name)}
                    className="text-destructive"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete Folder
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          nodeContent
        )}
        
        {node.type === 'folder' && node.isExpanded && node.children && (
          <div>
            {node.children.map(child => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
    <div className="bg-card border-r border-border h-full flex flex-col">
      {/* Session Browser */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h3 className="font-medium">Session Manager</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openNewFolderDialog()}
            className="h-7 w-7 p-0"
          >
            <FolderPlus className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
              <p className="text-sm text-muted-foreground mb-4">No sessions yet</p>
              {onNewConnection && (
                <Button onClick={onNewConnection} size="sm" variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  New Connection
                </Button>
              )}
            </div>
          ) : (
            sessions.map(session => renderNode(session))
          )}
        </div>
      </div>
      
      {/* Connection Details */}
      <div className="border-t border-border">
        <div className="p-3">
          <h3 className="font-medium text-sm mb-3">Connection Details</h3>
          
          {!selectedSession || selectedSession.type === 'folder' ? (
            <p className="text-sm text-muted-foreground">No session selected</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Name</span>
                  <span className="text-xs">{selectedSession.name}</span>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Type</span>
                  <Badge variant="outline" className="text-xs py-0 px-1 h-5">
                    {selectedSession.protocol}
                  </Badge>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Status</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${selectedSession.isConnected ? 'bg-green-500' : 'bg-gray-500'}`} />
                    <span className="text-xs">{selectedSession.isConnected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                </div>

                {selectedSession.lastConnected && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Last Connected</span>
                    <span className="text-xs">
                      {new Date(selectedSession.lastConnected).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
              
              {selectedSession.host && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Host</span>
                      <span className="text-xs">{selectedSession.host}</span>
                    </div>
                    
                    {selectedSession.username && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">Username</span>
                        <span className="text-xs">{selectedSession.username}</span>
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Port</span>
                      <span className="text-xs">
                        {selectedSession.port || (selectedSession.protocol === 'SSH' ? 22 : 23)}
                      </span>
                    </div>
                  </div>
                </>
              )}
              
              <Separator />
              
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Protocol</span>
                  <span className="text-xs">{selectedSession.protocol}</span>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Description</span>
                  <span className="text-xs text-muted-foreground">-</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    
    {/* New Folder Dialog */}
    <Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Folder</DialogTitle>
          <DialogDescription>
            Create a new folder to organize your sessions.
            {newFolderParentPath && ` Parent: ${newFolderParentPath}`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="folder-name">Folder Name</Label>
            <Input
              id="folder-name"
              placeholder="Enter folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleCreateFolder();
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewFolderDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreateFolder}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    
    {/* Delete Folder Confirmation Dialog */}
    <AlertDialog open={deleteFolderDialogOpen} onOpenChange={setDeleteFolderDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Folder?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the folder "{folderToDelete?.name}"? 
            This will also delete all sessions and subfolders within it. 
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteFolder} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}