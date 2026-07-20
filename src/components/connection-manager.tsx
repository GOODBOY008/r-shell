import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Monitor, Server, HardDrive, Plus, Pencil, Copy, Trash2, FolderPlus, FolderEdit, Zap, Clock } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
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
  onConnectionConnect?: (connection: ConnectionNode) => void;
  selectedConnectionId: string | null;
  activeConnections?: Set<string>;
  onNewConnection?: (folderPath?: string) => void;
  onEditConnection?: (connection: ConnectionNode) => void;
  onDeleteConnection?: (connectionId: string) => void;
  onDuplicateConnection?: (connection: ConnectionNode) => void;
  recentConnections?: { id: string; name: string; host: string; username: string; port?: number; lastConnected?: string }[];
  onQuickConnect?: (connectionId: string) => void;
}

export function ConnectionManager({
  onConnectionSelect,
  onConnectionConnect,
  selectedConnectionId,
  activeConnections = new Set(),
  onNewConnection,
  onEditConnection,
  onDeleteConnection,
  onDuplicateConnection,
  recentConnections = [],
  onQuickConnect,
}: ConnectionManagerProps) {
  const { t } = useTranslation();
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
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  // Reload connections when active connections change
  useEffect(() => {
    setConnections(loadConnections());
  }, [activeConnections]);

  // Handle connection deletion
  const handleDelete = (connectionId: string) => {
    if (ConnectionStorageManager.deleteConnection(connectionId)) {
      setConnections(loadConnections());
      toast.success(t('connectionManager.connectionDeleted'));
      if (onDeleteConnection) {
        onDeleteConnection(connectionId);
      }
    } else {
      toast.error(t('connectionManager.failedToDeleteConnection'));
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
        toast.success(t('connectionManager.duplicated', { name: duplicated.name }));
        if (onDuplicateConnection) {
          onDuplicateConnection(node);
        }
      }
    }
  };

  // Handle creating new folder
  const handleCreateFolder = () => {
    if (!newFolderName.trim()) {
      toast.error(t('connectionManager.folderNameEmpty'));
      return;
    }

    try {
      ConnectionStorageManager.createFolder(newFolderName.trim(), newFolderParentPath);
      setConnections(loadConnections());
      toast.success(t('connectionManager.folderCreated', { name: newFolderName }));
      setNewFolderDialogOpen(false);
      setNewFolderName('');
      setNewFolderParentPath(undefined);
    } catch (_error) {
      toast.error(t('connectionManager.failedToCreateFolder'));
    }
  };

  // Handle deleting folder
  const handleDeleteFolder = () => {
    if (!folderToDelete) return;

    if (ConnectionStorageManager.deleteFolder(folderToDelete.path, true)) {
      setConnections(loadConnections());
      toast.success(t('connectionManager.folderDeleted', { name: folderToDelete.name }));
      setDeleteFolderDialogOpen(false);
      setFolderToDelete(null);
    } else {
      toast.error(t('connectionManager.failedToDeleteFolder'));
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
      toast.error(t('connectionManager.folderNameEmpty'));
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
        const _newSubfolderPath = `${newPath}/${relativePath}`;
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
      toast.success(t('connectionManager.folderRenamed', { name: newName }));
      setRenameFolderDialogOpen(false);
      setFolderToRename(null);
      setRenameFolderNewName('');
    } catch (error) {
      toast.error(t('connectionManager.failedToRenameFolder'), {
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
    // Store drag data in DataTransfer — the standard HTML5 DnD mechanism
    // This ensures handleDrop can always access it regardless of React state timing
    e.dataTransfer.setData('application/x-r-shell-item', JSON.stringify({
      id: node.id,
      name: node.name,
      path: node.path,
      type: node.type,
      protocol: node.protocol,
      host: node.host,
    }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, targetNode: ConnectionNode) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (targetNode.type === 'folder') {
      setDragOverFolderId(targetNode.id);
    }
  };

  const handleDragLeave = (e: React.DragEvent, targetNode: ConnectionNode) => {
    if (targetNode.type === 'folder') {
      setDragOverFolderId(null);
    }
  };

  const handleDrop = (e: React.DragEvent, targetNode: ConnectionNode) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);

    // Read drag data from DataTransfer (the standard HTML5 DnD mechanism)
    const rawData = e.dataTransfer.getData('application/x-r-shell-item');
    if (!rawData) return;
    const item = JSON.parse(rawData) as {
      id: string; name: string; path?: string;
      type: 'connection' | 'folder'; protocol?: string; host?: string;
    };

    // Can only drop into folders
    if (targetNode.type !== 'folder') return;

    // Don't drop into itself
    if (item.id === targetNode.id) return;

    // Don't drop folder into its own child
    if (item.type === 'folder' && targetNode.path?.startsWith(item.path + '/')) {
      toast.error(t('connectionManager.cannotMoveIntoOwn'));
      return;
    }

    if (item.type === 'connection') {
      // Move connection to target folder
      if (ConnectionStorageManager.moveConnection(item.id, targetNode.path!)) {
        setConnections(loadConnections());
        toast.success(t('connectionManager.movedConnection', { source: item.name, target: targetNode.name }));
      } else {
        toast.error(t('connectionManager.failedToMoveConnection'));
      }
    } else if (item.type === 'folder') {
      // Use moveFolder to recursively move folder and all its contents
      try {
        if (ConnectionStorageManager.moveFolder(item.path!, targetNode.path!)) {
          setConnections(loadConnections());
          toast.success(t('connectionManager.movedFolder', { source: item.name, target: targetNode.name }));
        } else {
          toast.error(t('connectionManager.failedToMoveFolder'));
        }
      } catch (error) {
        toast.error(t('connectionManager.failedToMoveFolder'), {
          description: error instanceof Error ? error.message : t('connectionManager.unableToMoveFolder'),
        });
      }
    }

    setDraggedItem(null);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDragOverFolderId(null);
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
        } ${isDragging ? 'opacity-50' : ''} ${
          dragOverFolderId === node.id && node.type === 'folder' ? 'bg-accent/50 ring-1 ring-primary' : ''
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleNodeClick}
        onDoubleClick={handleNodeDoubleClick}
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
      <div
        key={node.id}
        draggable={node.path !== 'All Connections'}
        onDragStart={(e) => handleDragStart(e, node)}
        onDragOver={node.type === 'folder' ? (e) => handleDragOver(e, node) : undefined}
        onDrop={node.type === 'folder' ? (e) => handleDrop(e, node) : undefined}
        onDragLeave={node.type === 'folder' ? (e) => handleDragLeave(e, node) : undefined}
        onDragEnd={handleDragEnd}
      >
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
                {isConnected ? t('connectionManager.switchToConnection') : t('connectionManager.connect')}
              </ContextMenuItem>
              {onEditConnection && (
                <ContextMenuItem
                  onClick={() => onEditConnection(node)}
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  {t('connectionManager.edit')}
                </ContextMenuItem>
              )}
              <ContextMenuItem
                onClick={() => handleDuplicate(node)}
              >
                <Copy className="w-4 h-4 mr-2" />
                {t('connectionManager.duplicate')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => handleDelete(node.id)}
                className="text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {t('connectionManager.delete')}
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
                onClick={() => onNewConnection?.(node.path)}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('connectionManager.newConnection')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => openNewFolderDialog(node.path)}
              >
                <FolderPlus className="w-4 h-4 mr-2" />
                {t('connectionManager.newSubfolder')}
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
                    {t('connectionManager.folder.renameFolder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => openDeleteFolderDialog(node.path!, node.name)}
                    className="text-destructive"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    {t('connectionManager.folder.deleteFolder')}
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
        <div className="px-3 py-1.5 border-b border-border flex items-center gap-1">
          <h3 className="font-medium text-sm flex-1">{t('connectionManager.connectionsHeader')}</h3>
          <TooltipProvider>
            {/* Quick Connect */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                      <Zap className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{t('toolbar.quickConnect')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="flex items-center gap-2 text-xs">
                  <Clock className="w-3.5 h-3.5" />
                  {t('toolbar.recentConnections')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {recentConnections.length > 0 ? (
                  recentConnections.map((conn) => (
                    <DropdownMenuItem
                      key={conn.id}
                      onClick={() => onQuickConnect?.(conn.id)}
                      className="flex items-start gap-2 py-2 cursor-pointer"
                    >
                      <Server className="w-3.5 h-3.5 mt-0.5 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{conn.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {conn.username}@{conn.host}
                        </div>
                      </div>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {t('toolbar.noRecentConnections')}
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* New Folder */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openNewFolderDialog()}
                  className="h-6 w-6 p-0"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('connectionManager.newFolder')}</TooltipContent>
            </Tooltip>

            {/* New Connection */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNewConnection?.(
                    selectedConnection?.type === 'folder' ? selectedConnection.path : undefined
                  )}
                  className="h-6 w-6 p-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('connectionManager.newConnection')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="flex-1 overflow-auto">
          {connections.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
              <p className="text-sm text-muted-foreground mb-4">{t('connectionManager.noConnectionsYet')}</p>
              {onNewConnection && (
                <Button onClick={() => onNewConnection()} size="sm" variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  {t('connectionManager.newConnection')}
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
          <h3 className="font-medium text-sm mb-3">{t('connectionManager.connectionDetails')}</h3>

          {!selectedConnection || selectedConnection.type === 'folder' ? (
            <p className="text-sm text-muted-foreground">{t('connectionManager.noConnectionSelected')}</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t('connectionDetails.name')}</span>
                  <span className="text-xs">{selectedConnection.name}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t('connectionDetails.type')}</span>
                  <Badge variant="outline" className="text-xs py-0 px-1 h-5">
                    {selectedConnection.protocol}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t('connectionDetails.status')}</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${selectedConnection.isConnected ? 'bg-green-500' : 'bg-gray-500'}`} />
                    <span className="text-xs">{selectedConnection.isConnected ? t('connectionDetails.connected') : t('connectionDetails.disconnected')}</span>
                  </div>
                </div>

                {selectedConnection.lastConnected && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{t('connectionDetails.lastConnected')}</span>
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
                      <span className="text-xs font-medium">{t('connectionManager.host')}</span>
                      <span className="text-xs">{selectedConnection.host}</span>
                    </div>

                    {selectedConnection.username && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">{t('connectionManager.username')}</span>
                        <span className="text-xs">{selectedConnection.username}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{t('connectionManager.port')}</span>
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
                  <span className="text-xs font-medium">{t('connectionManager.protocol')}</span>
                  <span className="text-xs">{selectedConnection.protocol}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t('connectionManager.description')}</span>
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
          <DialogTitle>{t('connectionManager.createNewFolder')}</DialogTitle>
          <DialogDescription>
            {t('connectionManager.createFolderDesc')}
            {newFolderParentPath && ` ${t('connectionManager.parent')}: ${newFolderParentPath}`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="folder-name">{t('connectionManager.folderName')}</Label>
            <Input
              id="folder-name"
              placeholder={t('connectionManager.enterFolderName')}
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
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreateFolder}>{t('connectionManager.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    
    {/* Delete Folder Confirmation Dialog */}
    <AlertDialog open={deleteFolderDialogOpen} onOpenChange={setDeleteFolderDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('connectionManager.deleteFolderTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('connectionManager.deleteFolderDesc', { name: folderToDelete?.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteFolder} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {t('connectionManager.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    
    {/* Rename Folder Dialog */}
    <Dialog open={renameFolderDialogOpen} onOpenChange={setRenameFolderDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('connectionManager.renameFolder')}</DialogTitle>
          <DialogDescription>
            {t('connectionManager.renameFolderDesc', { name: folderToRename?.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="rename-folder-name">{t('connectionManager.folderName')}</Label>
            <Input
              id="rename-folder-name"
              placeholder={t('connectionManager.enterNewFolderName')}
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
            {t('common.cancel')}
          </Button>
          <Button onClick={handleRenameFolder}>{t('connectionManager.rename')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}