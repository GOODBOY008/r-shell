import React, { useState, useEffect, useRef } from 'react';
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
  onNewConnection?: () => void;
  onEditConnection?: (connection: ConnectionNode) => void;
  onDeleteConnection?: (connectionId: string) => void;
  onDuplicateConnection?: (connection: ConnectionNode) => void;
  recentConnections?: { id: string; name: string; host: string; username: string; port?: number; lastConnected?: string }[];
  onQuickConnect?: (connectionId: string) => void;
}

type DropPosition = 'before' | 'after' | 'inside';
const ROOT_DROP_ID = '__root__';

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

  // Drag and drop state (pointer-based — HTML5 DnD is unusable in WKWebView)
  const [draggedItem, setDraggedItem] = useState<{ node: ConnectionNode; type: 'connection' | 'folder' } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ nodeId: string; position: DropPosition } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; name: string; type: 'connection' | 'folder' } | null>(null);
  const suppressClickRef = useRef(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);

  // Reload connections when active connections change, preserving expand state
  useEffect(() => {
    const newTree = loadConnections();
    setConnections(prev => {
      // Merge isExpanded from the previous tree to preserve the user's
      // expand/collapse state across tree rebuilds (the storage backend
      // always returns isExpanded: true).
      const mergeExpanded = (newNodes: ConnectionNode[]): ConnectionNode[] =>
        newNodes.map(newNode => {
          const prevNode = prev.find(n => n.id === newNode.id);
          const merged: ConnectionNode = {
            ...newNode,
            isExpanded: prevNode !== undefined ? prevNode.isExpanded : newNode.isExpanded,
          };
          if (newNode.children && prevNode?.children) {
            merged.children = mergeExpanded(newNode.children);
          }
          return merged;
        });
      return mergeExpanded(newTree);
    });
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

  // ── Pointer-based drag and drop (HTML5 DnD does not fire drop events in WKWebView) ──

  // Find a node's context in the tree: its parent path and same-type siblings
  const findNodeContext = (
    nodes: ConnectionNode[],
    nodeId: string,
    parentPath?: string
  ): { parentPath: string | undefined; sameTypeSiblings: ConnectionNode[] } | null => {
    const idx = nodes.findIndex(n => n.id === nodeId);
    if (idx !== -1) {
      return {
        parentPath,
        sameTypeSiblings: nodes.filter(n => n.type === nodes[idx].type),
      };
    }
    for (const n of nodes) {
      if (n.children) {
        const found = findNodeContext(n.children, nodeId, n.path);
        if (found) return found;
      }
    }
    return null;
  };

  // Find a node by id in the tree
  const findNodeById = (nodes: ConnectionNode[], id: string): ConnectionNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = findNodeById(n.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  // Guard: dropping a folder into its own subtree is invalid
  const isInvalidFolderTarget = (draggedNode: ConnectionNode, targetNode: ConnectionNode): boolean => {
    if (draggedNode.type !== 'folder') return false;
    const draggedPath = draggedNode.path!;
    if (targetNode.type === 'folder' && (targetNode.path === draggedPath || targetNode.path?.startsWith(draggedPath + '/'))) {
      return true;
    }
    if (targetNode.type === 'connection') {
      const ctx = findNodeContext(connections, targetNode.id);
      const connParent = ctx?.parentPath ?? 'All Connections';
      if (connParent === draggedPath || connParent.startsWith(draggedPath + '/')) return true;
    }
    return false;
  };

  // Compute before/after/inside from pointer Y within a row
  const calcDropPosition = (targetNode: ConnectionNode, rowEl: HTMLElement, clientY: number): DropPosition => {
    if (targetNode.path === 'All Connections') return 'inside'; // root only accepts inside
    const rect = rowEl.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    if (targetNode.type === 'folder') {
      return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
    }
    return ratio < 0.5 ? 'before' : 'after';
  };

  // Hit-test the element stack for a connection tree row
  const findRowAtPoint = (x: number, y: number): HTMLElement | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.hasAttribute('data-conn-node-id')) return el as HTMLElement;
    }
    return null;
  };

  const isOverTreeContainer = (x: number, y: number): boolean => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.hasAttribute('data-conn-tree-container')) return true;
    }
    return false;
  };

  // Update drop indicator from pointer position during drag
  const updateDropTargetFromPoint = (x: number, y: number, draggedNode: ConnectionNode) => {
    const rowEl = findRowAtPoint(x, y);
    if (rowEl) {
      const targetId = rowEl.getAttribute('data-conn-node-id')!;
      if (targetId === draggedNode.id) {
        setDropTarget(null);
        return;
      }
      const targetNode = findNodeById(connections, targetId);
      if (!targetNode || isInvalidFolderTarget(draggedNode, targetNode)) {
        setDropTarget(null);
        return;
      }
      const position = calcDropPosition(targetNode, rowEl, y);
      setDropTarget(prev =>
        prev?.nodeId === targetId && prev.position === position ? prev : { nodeId: targetId, position }
      );
      return;
    }
    // Empty space inside the tree container → drop to root
    if (isOverTreeContainer(x, y)) {
      setDropTarget(prev =>
        prev?.nodeId === ROOT_DROP_ID ? prev : { nodeId: ROOT_DROP_ID, position: 'inside' }
      );
      return;
    }
    setDropTarget(null);
  };

  // Execute the drop at the pointer position
  const performDropAtPoint = (x: number, y: number, draggedNode: ConnectionNode) => {
    const rowEl = findRowAtPoint(x, y);
    if (rowEl) {
      const targetId = rowEl.getAttribute('data-conn-node-id')!;
      if (targetId === draggedNode.id) return;
      const targetNode = findNodeById(connections, targetId);
      if (!targetNode) return;
      const position = calcDropPosition(targetNode, rowEl, y);
      executeDrop(draggedNode, targetNode, position);
    } else if (isOverTreeContainer(x, y)) {
      executeDrop(draggedNode, undefined, 'inside');
    }
  };

  const handleNodePointerDown = (e: React.PointerEvent, node: ConnectionNode) => {
    if (e.button !== 0) return; // left button only
    if (node.path === 'All Connections') return; // root folder is not draggable

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const DRAG_THRESHOLD = 5;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;
        suppressClickRef.current = true;
        setDraggedItem({ node, type: node.type });
        document.body.style.userSelect = 'none';
      }

      setDragGhost({ x: ev.clientX, y: ev.clientY, name: node.name, type: node.type });
      updateDropTargetFromPoint(ev.clientX, ev.clientY, node);

      // Auto-scroll the tree near vertical edges
      const container = treeContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const EDGE = 40;
        const SPEED = 10;
        if (ev.clientY < rect.top + EDGE) {
          container.scrollTop -= SPEED;
        } else if (ev.clientY > rect.bottom - EDGE) {
          container.scrollTop += SPEED;
        }
      }
    };

    const onUp = (ev: PointerEvent | FocusEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
      document.body.style.userSelect = '';

      if (dragging) {
        const clientX = 'clientX' in ev ? ev.clientX : 0;
        const clientY = 'clientY' in ev ? ev.clientY : 0;
        if (clientX || clientY) {
          performDropAtPoint(clientX, clientY, node);
        }
      }

      setDraggedItem(null);
      setDropTarget(null);
      setDragGhost(null);
      // Release click suppression after the synthetic click has fired
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
  };

  const executeDrop = (draggedNode: ConnectionNode, targetNode?: ConnectionNode, position: DropPosition = 'inside') => {
    // Connections never accept 'inside' drops
    if (targetNode?.type === 'connection' && position === 'inside') {
      position = 'after';
    }

    // Resolve target parent path and insertion index among same-type siblings
    let targetParentPath: string | undefined;
    let newIndex: number;

    if (!targetNode) {
      // Dropped on empty container space → move into 'All Connections' at end
      targetParentPath = 'All Connections';
      const rootNode = connections.find(n => n.path === 'All Connections');
      newIndex = rootNode?.children?.filter(c => c.type === draggedNode.type).length ?? 0;
    } else if (position === 'inside') {
      // Dropped into a folder
      targetParentPath = targetNode.path!;
      newIndex = targetNode.children?.filter(c => c.type === draggedNode.type).length ?? 0;
    } else {
      // Dropped before/after a sibling node
      const ctx = findNodeContext(connections, targetNode.id);
      if (!ctx) return;
      targetParentPath = ctx.parentPath;
      const siblingsWithoutDragged = ctx.sameTypeSiblings.filter(s => s.id !== draggedNode.id);
      const targetIndexInFiltered = siblingsWithoutDragged.findIndex(s => s.id === targetNode.id);
      newIndex = position === 'before' ? targetIndexInFiltered : targetIndexInFiltered + 1;
    }

    // Guard: cannot move a folder into its own subtree
    if (draggedNode.type === 'folder' && targetParentPath !== undefined) {
      const draggedPath = draggedNode.path!;
      if (targetParentPath === draggedPath || targetParentPath.startsWith(draggedPath + '/')) {
        toast.error(t('connectionManager.cannotMoveIntoOwn'));
        return;
      }
    }

    // Skip no-op drops (same parent, same position)
    const draggedCtx = findNodeContext(connections, draggedNode.id);
    if (draggedCtx) {
      const currentParent = draggedCtx.parentPath ?? 'All Connections';
      const resolvedTarget = targetParentPath ?? 'All Connections';
      if (currentParent === resolvedTarget) {
        const currentIndex = draggedCtx.sameTypeSiblings.findIndex(s => s.id === draggedNode.id);
        if (currentIndex === newIndex) {
          return;
        }
      }
    }

    const sourceParentPath = draggedNode.type === 'connection'
      ? (ConnectionStorageManager.getConnection(draggedNode.id)?.folder || 'All Connections')
      : ConnectionStorageManager.getFolders().find(f => f.id === draggedNode.id)?.parentPath;

    let success: boolean;
    if (draggedNode.type === 'connection') {
      success = ConnectionStorageManager.reorderItem(draggedNode.id, 'connection', targetParentPath, newIndex);
    } else {
      // Move folder recursively (rewrites all nested paths), then set position
      success = ConnectionStorageManager.moveFolderRecursive(draggedNode.path!, targetParentPath);
      if (success) {
        success = ConnectionStorageManager.reorderItem(draggedNode.id, 'folder', targetParentPath, newIndex);
      }
    }

    if (success) {
      setConnections(loadConnections());
      // Only show a toast when the item changed parent folder
      const resolvedTargetParent = targetParentPath ?? 'All Connections';
      if (sourceParentPath !== targetParentPath) {
        if (resolvedTargetParent === 'All Connections') {
          toast.success(t('connectionManager.movedToRoot', { name: draggedNode.name }));
        } else {
          const targetName = position === 'inside' && targetNode
            ? targetNode.name
            : targetParentPath?.split('/').pop() ?? 'All Connections';
          if (draggedNode.type === 'connection') {
            toast.success(t('connectionManager.movedConnection', { source: draggedNode.name, target: targetName }));
          } else {
            toast.success(t('connectionManager.movedFolder', { source: draggedNode.name, target: targetName }));
          }
        }
      }
    } else {
      toast.error(t('connectionManager.failedToReorder'));
    }
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
    const isDropBefore = dropTarget?.nodeId === node.id && dropTarget.position === 'before';
    const isDropAfter = dropTarget?.nodeId === node.id && dropTarget.position === 'after';
    const isDropInside = dropTarget?.nodeId === node.id && dropTarget.position === 'inside';

    const handleNodeClick = () => {
      // Suppress the synthetic click that follows a completed drag
      if (suppressClickRef.current) return;

      // Select the node — folder toggle is handled separately by the chevron button
      onConnectionSelect(node);
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
        data-conn-node-id={node.id}
        className={`relative flex items-center gap-2 px-2 py-1 hover:bg-accent cursor-pointer select-none ${
          isSelected ? 'bg-accent' : ''
        } ${isDragging ? 'opacity-50' : ''} ${isDropInside ? 'bg-accent/60 ring-1 ring-primary/50 rounded-sm' : ''}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleNodeClick}
        onDoubleClick={handleNodeDoubleClick}
        onPointerDown={(e) => handleNodePointerDown(e, node)}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      >
        {isDropBefore && (
          <div className="absolute top-0 right-0 h-0.5 bg-primary rounded" style={{ left: `${level * 16 + 8}px` }} />
        )}
        {isDropAfter && (
          <div className="absolute bottom-0 right-0 h-0.5 bg-primary rounded" style={{ left: `${level * 16 + 8}px` }} />
        )}
        {node.type === 'folder' && (
          <Button
            variant="ghost"
            size="sm"
            className="p-0 h-4 w-4"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(node.id);
            }}
          >
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
                  onClick={onNewConnection}
                  className="h-6 w-6 p-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('connectionManager.newConnection')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div
          ref={treeContainerRef}
          data-conn-tree-container="true"
          className={`flex-1 overflow-auto ${dropTarget?.nodeId === ROOT_DROP_ID ? 'ring-1 ring-inset ring-primary/30' : ''}`}
        >
          {connections.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
              <p className="text-sm text-muted-foreground mb-4">{t('connectionManager.noConnectionsYet')}</p>
              {onNewConnection && (
                <Button onClick={onNewConnection} size="sm" variant="outline">
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

    {/* Drag ghost following the pointer (HTML5 drag image is unavailable in WKWebView) */}
    {dragGhost && (
      <div
        className="fixed z-50 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-popover text-popover-foreground shadow-md text-sm"
        style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}
      >
        {dragGhost.type === 'folder' ? <Folder className="w-3.5 h-3.5" /> : <Server className="w-3.5 h-3.5 text-green-500" />}
        <span className="max-w-[160px] truncate">{dragGhost.name}</span>
      </div>
    )}
    </>
  );
}