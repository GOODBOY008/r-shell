import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Monitor, Server, HardDrive, Plus, Pencil, Copy, Trash2, FolderPlus, FolderEdit } from 'lucide-react';
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
import { ConnectionStorageManager } from '../lib/connection-storage';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { toast } from 'sonner';

interface ConnectionNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string; // For folders
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  profileId?: string;
  lastConnected?: string;
  isConnected?: boolean;
  children?: ConnectionNode[];
  isExpanded?: boolean;
}

interface ConnectionManagerProps {
  onConnectionSelect: (connection: ConnectionNode) => void;
  onConnectionConnect?: (connection: ConnectionNode) => void; // Connect to connection (double-click or context menu)
  selectedConnectionId: string | null;
  activeConnections?: Set<string>; // Set of currently active connection IDs
  onNewConnection?: () => void; // Callback to open connection dialog
  onEditConnection?: (connection: ConnectionNode) => void; // Callback to edit connection
  onDeleteConnection?: (connectionId: string) => void; // Callback to delete connection
  onDuplicateConnection?: (connection: ConnectionNode) => void; // Callback to duplicate connection
}

export function ConnectionManager({
  onConnectionSelect,
  onConnectionConnect,
  selectedConnectionId,
  activeConnections = new Set(),
  onNewConnection,
  onEditConnection,
  onDeleteConnection,
  onDuplicateConnection
}: ConnectionManagerProps) {
  // Load connections from storage
  const loadConnections = (): ConnectionNode[] => {
    const tree = ConnectionStorageManager.buildConnectionTree(activeConnections);
    return tree.length > 0 ? tree : [];
  };

  const [connections, setConnections] = useState<ConnectionNode[]>(loadConnections());

  // Folder management state
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentPath, setNewFolderParentPath] = useState<string | undefined>(undefined);
  const [deleteFolderDialogOpen, setDeleteFolderDialogOpen] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ path: string; name: string } | null>(null);
  const [renameFolderDialogOpen, setRenameFolderDialogOpen] = useState(false);
  const [folderToRename, setFolderToRename] = useState<{ path: string; name: string; parentPath?: string } | null>(null);
  const [renameFolderNewName, setRenameFolderNewName] = useState('');

  // Drag and drop state
  const [draggedItem, setDraggedItem] = useState<{ node: ConnectionNode; type: 'connection' | 'folder' } | null>(null);

  // Reload connections when active connections change
  useEffect(() => {
    setConnections(loadConnections());
  }, [activeConnections]);

  // Handle connection deletion
  const handleDelete = (connectionId: string) => {
    if (ConnectionStorageManager.deleteConnection(connectionId)) {
      setConnections(loadConnections());
      toast.success('Connection deleted');
      if (onDeleteConnection) {
        onDeleteConnection(connectionId);
      }
    } else {
      toast.error('Failed to delete connection');
    }
  };

  // Handle connection duplication
  const handleDuplicate = (node: ConnectionNode) => {
    if (node.type === 'connection' && node.host) {
      // Load the full connection data to get authentication credentials
      const connectionData = ConnectionStorageManager.getConnection(node.id);
      if (connectionData) {
        const duplicated = ConnectionStorageManager.saveConnection({
          name: `${node.name} (Copy)`,
          host: node.host,
          port: node.port || 22,
          username: node.username || '',
          protocol: node.protocol || 'SSH',
          folder: connectionData.folder || 'All Connections',
          // Copy authentication credentials
          authMethod: connectionData.authMethod,
          password: connectionData.password,
          privateKeyPath: connectionData.privateKeyPath,
          passphrase: connectionData.passphrase,
        });
        setConnections(loadConnections());
        toast.success(`Duplicated: ${duplicated.name}`);
        if (onDuplicateConnection) {
          onDuplicateConnection(node);
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
      ConnectionStorageManager.createFolder(newFolderName.trim(), newFolderParentPath);
      setConnections(loadConnections());
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

    if (ConnectionStorageManager.deleteFolder(folderToDelete.path, true)) {
      setConnections(loadConnections());
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

  // Handle renaming folder
  const handleRenameFolder = () => {
    if (!folderToRename || !renameFolderNewName.trim()) {
      toast.error('Folder name cannot be empty');
      return;
    }

    try {
      const oldPath = folderToRename.path;
      const newName = renameFolderNewName.trim();
      const newPath = folderToRename.parentPath
        ? `${folderToRename.parentPath}/${newName}`
        : newName;

      // Get all connections in this folder and subfolders
      const allConnections = ConnectionStorageManager.getConnectionsByFolderRecursive(oldPath);

      // Get all subfolders
      const subfolders = ConnectionStorageManager.getSubfoldersRecursive(oldPath);

      // Create new folder first
      ConnectionStorageManager.createFolder(newName, folderToRename.parentPath);

      // Recreate all subfolders with new parent path
      subfolders.forEach(subfolder => {
        const relativePath = subfolder.path.substring(oldPath.length + 1); // Remove old parent path
        const newSubfolderPath = `${newPath}/${relativePath}`;
        const parts = relativePath.split('/');
        const subfolderName = parts[parts.length - 1];
        const subfolderParentPath = parts.length > 1
          ? `${newPath}/${parts.slice(0, -1).join('/')}`
          : newPath;

        ConnectionStorageManager.createFolder(subfolderName, subfolderParentPath);
      });

      // Move all connections to new paths
      allConnections.forEach(connection => {
        let newConnectionPath: string;
        if (connection.folder === oldPath) {
          // Connection directly in the renamed folder
          newConnectionPath = newPath;
        } else {
          // Connection in a subfolder - update the path
          const relativePath = connection.folder!.substring(oldPath.length + 1);
          newConnectionPath = `${newPath}/${relativePath}`;
        }
        ConnectionStorageManager.moveConnection(connection.id, newConnectionPath);
      });

      // Delete old folder and all subfolders
      ConnectionStorageManager.deleteFolder(oldPath, true);

      setConnections(loadConnections());
      toast.success(`Folder renamed to "${newName}"`);
      setRenameFolderDialogOpen(false);
      setFolderToRename(null);
      setRenameFolderNewName('');
    } catch (error) {
      console.error('Rename folder error:', error);
      toast.error('Failed to Rename Folder', {
        description: error instanceof Error ? error.message : 'Unable to rename folder.',
      });
    }
  };

  // Open rename folder dialog
  const openRenameFolderDialog = (path: string, name: string, parentPath?: string) => {
    setFolderToRename({ path, name, parentPath });
    setRenameFolderNewName(name);
    setRenameFolderDialogOpen(true);
  };

  // Open delete folder dialog
  const openDeleteFolderDialog = (path: string, name: string) => {
    setFolderToDelete({ path, name });
    setDeleteFolderDialogOpen(true);
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, node: ConnectionNode) => {
    setDraggedItem({ node, type: node.type });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetNode: ConnectionNode) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedItem) return;

    // Can only drop into folders
    if (targetNode.type !== 'folder') return;

    // Don't drop into itself
    if (draggedItem.node.id === targetNode.id) return;

    // Don't drop folder into its own child
    if (draggedItem.type === 'folder' && targetNode.path?.startsWith(draggedItem.node.path + '/')) {
      toast.error('Cannot move folder into its own subfolder');
      return;
    }

    if (draggedItem.type === 'connection') {
      // Move connection to target folder
      if (ConnectionStorageManager.moveConnection(draggedItem.node.id, targetNode.path!)) {
        setConnections(loadConnections());
        toast.success(`Moved "${draggedItem.node.name}" to "${targetNode.name}"`);
      } else {
        toast.error('Failed to move connection');
      }
    } else if (draggedItem.type === 'folder') {
      // Move folder by renaming its path
      try {
        const connections = ConnectionStorageManager.getConnectionsByFolder(draggedItem.node.path!);
        const newPath = `${targetNode.path}/${draggedItem.node.name}`;

        // Create new folder
        ConnectionStorageManager.createFolder(draggedItem.node.name, targetNode.path);

        // Move all connections
        connections.forEach(connection => {
          ConnectionStorageManager.moveConnection(connection.id, newPath);
        });

        // Delete old folder
        ConnectionStorageManager.deleteFolder(draggedItem.node.path!, false);

        setConnections(loadConnections());
        toast.success(`Moved folder "${draggedItem.node.name}" to "${targetNode.name}"`);
      } catch (error) {
        toast.error('Failed to Move Folder', {
          description: error instanceof Error ? error.message : 'Unable to move folder to new location.',
        });
      }
    }

    setDraggedItem(null);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
  };

  // Find the selected connection details
  const getSelectedConnection = (nodes: ConnectionNode[]): ConnectionNode | null => {
    for (const node of nodes) {
      if (node.id === selectedConnectionId) {
        return node;
      }
      if (node.children) {
        const found = getSelectedConnection(node.children);
        if (found) return found;
      }
    }
    return null;
  };

  const selectedConnection = getSelectedConnection(connections);

  const toggleExpanded = (nodeId: string) => {
    const updateNode = (nodes: ConnectionNode[]): ConnectionNode[] => {
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
    setConnections(updateNode(connections));
  };

  const getIcon = (node: ConnectionNode) => {
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

  const renderNode = (node: ConnectionNode, level: number = 0) => {
    const isSelected = selectedConnectionId === node.id;
    const isConnected = node.type === 'connection' && node.isConnected;
    const isDragging = draggedItem?.node.id === node.id;

    const handleNodeClick = () => {
      // Always select the node first
      onConnectionSelect(node);

      // Then toggle folder expansion if it's a folder
      if (node.type === 'folder') {
        toggleExpanded(node.id);
      }
    };

    const handleNodeDoubleClick = () => {
      if (node.type === 'connection') {
        // Double click to connect
        if (onConnectionConnect) {
          onConnectionConnect(node);
        } else {
          onConnectionSelect(node);
        }
      }
    };

    const nodeContent = (
      <div
        className={`flex items-center gap-2 px-2 py-1 hover:bg-accent cursor-pointer ${
          isSelected ? 'bg-accent' : ''
        } ${isDragging ? 'opacity-50' : ''}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleNodeClick}
        onDoubleClick={handleNodeDoubleClick}
        draggable={node.path !== 'All Connections'}
        onDragStart={(e) => handleDragStart(e, node)}
        onDragOver={node.type === 'folder' ? handleDragOver : undefined}
        onDrop={node.type === 'folder' ? (e) => handleDrop(e, node) : undefined}
        onDragEnd={handleDragEnd}
      >
        {node.type === 'folder' && (
          <Button variant="ghost" size="sm" className="p-0 h-4 w-4">
            {node.isExpanded ?
              <ChevronDown className="w-3 h-3" /> :
              <ChevronRight className="w-3 h-3" />
            }
          </Button>
        )}
        {node.type === 'connection' && <div className="w-4" />}

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
        {node.type === 'connection' ? (
          <ContextMenu onOpenChange={(open) => {
            if (open) {
              // Select the connection when context menu opens (right-click)
              onConnectionSelect(node);
            }
          }}>
            <ContextMenuTrigger asChild>
              {nodeContent}
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => {
                  if (onConnectionConnect) {
                    onConnectionConnect(node);
                  } else {
                    onConnectionSelect(node);
                  }
                }}
              >
                {isConnected ? 'Switch to Connection' : 'Connect'}
              </ContextMenuItem>
              {onEditConnection && (
                <ContextMenuItem
                  onClick={() => onEditConnection(node)}
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
          <ContextMenu onOpenChange={(open) => {
            if (open && node.type === 'folder') {
              // Select the folder when context menu opens (right-click)
              onConnectionSelect(node);
            }
          }}>
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
              {node.path !== 'All Connections' && (
                <>
                  <ContextMenuItem
                    onClick={() => {
                      const folders = ConnectionStorageManager.getFolders();
                      const folder = folders.find(f => f.path === node.path);
                      openRenameFolderDialog(node.path!, node.name, folder?.parentPath);
                    }}
                  >
                    <FolderEdit className="w-4 h-4 mr-2" />
                    Rename Folder
                  </ContextMenuItem>
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
      {/* Connection Browser */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h3 className="font-medium">Connection Manager</h3>
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
          {connections.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
              <p className="text-sm text-muted-foreground mb-4">No connections yet</p>
              {onNewConnection && (
                <Button onClick={onNewConnection} size="sm" variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  New Connection
                </Button>
              )}
            </div>
          ) : (
            connections.map(connection => renderNode(connection))
          )}
        </div>
      </div>

      {/* Connection Details */}
      <div className="border-t border-border">
        <div className="p-3">
          <h3 className="font-medium text-sm mb-3">Connection Details</h3>

          {!selectedConnection || selectedConnection.type === 'folder' ? (
            <p className="text-sm text-muted-foreground">No connection selected</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Name</span>
                  <span className="text-xs">{selectedConnection.name}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Type</span>
                  <Badge variant="outline" className="text-xs py-0 px-1 h-5">
                    {selectedConnection.protocol}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Status</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${selectedConnection.isConnected ? 'bg-green-500' : 'bg-gray-500'}`} />
                    <span className="text-xs">{selectedConnection.isConnected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                </div>

                {selectedConnection.lastConnected && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Last Connected</span>
                    <span className="text-xs">
                      {new Date(selectedConnection.lastConnected).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>

              {selectedConnection.host && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Host</span>
                      <span className="text-xs">{selectedConnection.host}</span>
                    </div>

                    {selectedConnection.username && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">Username</span>
                        <span className="text-xs">{selectedConnection.username}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Port</span>
                      <span className="text-xs">
                        {selectedConnection.port || (selectedConnection.protocol === 'SSH' ? 22 : 23)}
                      </span>
                    </div>
                  </div>
                </>
              )}

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Protocol</span>
                  <span className="text-xs">{selectedConnection.protocol}</span>
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
            Create a new folder to organize your connections.
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
            This will also delete all connections and subfolders within it.
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
    
    {/* Rename Folder Dialog */}
    <Dialog open={renameFolderDialogOpen} onOpenChange={setRenameFolderDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Folder</DialogTitle>
          <DialogDescription>
            Rename the folder "{folderToRename?.name}".
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="rename-folder-name">Folder Name</Label>
            <Input
              id="rename-folder-name"
              placeholder="Enter new folder name"
              value={renameFolderNewName}
              onChange={(e) => setRenameFolderNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameFolder();
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRenameFolderDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleRenameFolder}>Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}