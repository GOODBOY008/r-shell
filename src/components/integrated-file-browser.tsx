import React, { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { 
  Folder, 
  File, 
  Upload, 
  Download, 
  RefreshCw, 
  Home, 
  ArrowUp, 
  MoreHorizontal,
  Trash2,
  Plus,
  Search,
  FileText,
  Image,
  Archive,
  Code,
  Edit,
  Eye,
  Copy,
  Scissors,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  X,
  Save,
  FileEdit,
  ClipboardPaste,
  Info,
  Share,
  Link,
  Move,
  RotateCcw,
  FileType,
  Settings,
  Layers,
  GripVertical
} from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from './ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { toast } from 'sonner';

interface FileItem {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: Date;
  permissions: string;
  owner: string;
  group: string;
  path: string;
}

interface TransferItem {
  id: string;
  type: 'upload' | 'download';
  fileName: string;
  size: number;
  transferred: number;
  status: 'queued' | 'transferring' | 'completed' | 'error';
  speed: number;
}

interface IntegratedFileBrowserProps {
  sessionId: string;
  host?: string;
  isConnected: boolean;
  onClose: () => void;
}

export function IntegratedFileBrowser({ sessionId, host, isConnected, onClose }: IntegratedFileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('/home');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showTransfers, setShowTransfers] = useState(false);
  const [fileContent, setFileContent] = useState<string>('');
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [clipboard, setClipboard] = useState<{ files: FileItem[], operation: 'copy' | 'cut' } | null>(null);
  const [renamingFile, setRenamingFile] = useState<FileItem | null>(null);
  const [newFileName, setNewFileName] = useState('');
  
  // Column widths state
  const [columnWidths, setColumnWidths] = useState({
    name: 300,
    size: 80,
    modified: 140,
    permissions: 100,
    owner: 110
  });
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  
  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);

  // Mock file data - in real implementation, this would fetch from SSH connection
  const mockFiles: FileItem[] = [
    { name: '..', type: 'directory', size: 0, modified: new Date(), permissions: 'drwxr-xr-x', owner: 'root', group: 'root', path: '..' },
    { name: 'documents', type: 'directory', size: 4096, modified: new Date('2024-01-15'), permissions: 'drwxr-xr-x', owner: 'user01', group: 'users', path: 'documents' },
    { name: 'scripts', type: 'directory', size: 4096, modified: new Date('2024-01-10'), permissions: 'drwxr-xr-x', owner: 'user01', group: 'admin', path: 'scripts' },
    { name: 'config.txt', type: 'file', size: 1024, modified: new Date('2024-01-20'), permissions: '-rw-r--r--', owner: 'user01', group: 'users', path: 'config.txt' },
    { name: 'setup.sh', type: 'file', size: 2048, modified: new Date('2024-01-18'), permissions: '-rwxr-xr-x', owner: 'root', group: 'admin', path: 'setup.sh' },
    { name: 'README.md', type: 'file', size: 3072, modified: new Date('2024-01-16'), permissions: '-rw-r--r--', owner: 'user01', group: 'users', path: 'README.md' },
    { name: 'image.jpg', type: 'file', size: 1048576, modified: new Date('2024-01-14'), permissions: '-rw-r--r--', owner: 'user01', group: 'users', path: 'image.jpg' },
    { name: 'data.json', type: 'file', size: 5120, modified: new Date('2024-01-12'), permissions: '-rw-r--r--', owner: 'www-data', group: 'www-data', path: 'data.json' }
  ];

  useEffect(() => {
    if (isConnected) {
      loadFiles();
    }
  }, [currentPath, isConnected]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        switch (event.key) {
          case 'c':
            if (selectedFiles.size > 0) {
              event.preventDefault();
              const selectedFileItems = files.filter(f => selectedFiles.has(f.name));
              handleCopyFiles(selectedFileItems);
            }
            break;
          case 'x':
            if (selectedFiles.size > 0) {
              event.preventDefault();
              const selectedFileItems = files.filter(f => selectedFiles.has(f.name));
              handleCutFiles(selectedFileItems);
            }
            break;
          case 'v':
            if (clipboard) {
              event.preventDefault();
              handlePasteFiles();
            }
            break;
          case 'a':
            event.preventDefault();
            setSelectedFiles(new Set(files.map(f => f.name)));
            break;
          case 'r':
            event.preventDefault();
            loadFiles();
            break;
        }
      } else if (event.key === 'Delete' && selectedFiles.size > 0) {
        event.preventDefault();
        const selectedFileItems = files.filter(f => selectedFiles.has(f.name));
        selectedFileItems.forEach(handleDeleteFile);
      } else if (event.key === 'F2' && selectedFiles.size === 1) {
        event.preventDefault();
        const selectedFile = files.find(f => selectedFiles.has(f.name));
        if (selectedFile) {
          handleRenameFile(selectedFile);
        }
      } else if (event.key === 'Escape') {
        setSelectedFiles(new Set());
        if (renamingFile) {
          handleRenameCancel();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedFiles, files, clipboard, renamingFile]);

  // Column resize effect
  useEffect(() => {
    if (!resizingColumn) return;

    const handleMouseMove = (e: MouseEvent) => {
      const columnsContainer = document.querySelector('[data-columns-container]');
      if (!columnsContainer) return;

      const containerRect = columnsContainer.getBoundingClientRect();
      const relativeX = e.clientX - containerRect.left - 8; // Account for padding

      // Calculate new width based on mouse position
      setColumnWidths(prev => {
        const columns = Object.keys(prev);
        const columnIndex = columns.indexOf(resizingColumn);
        
        if (columnIndex === -1) return prev;

        // Calculate the start position of the column being resized
        let columnStart = 0;
        for (let i = 0; i < columnIndex; i++) {
          columnStart += prev[columns[i] as keyof typeof prev] + 8; // Add gap
        }

        const newWidth = Math.max(50, relativeX - columnStart - 8); // Minimum width of 50px, account for gaps

        return {
          ...prev,
          [resizingColumn]: newWidth
        };
      });
    };

    const handleMouseUp = () => {
      setResizingColumn(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingColumn]);

  const handleResizeStart = (columnName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingColumn(columnName);
  };

  const loadFiles = async () => {
    setIsLoading(true);
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 500));
    setFiles(mockFiles);
    setIsLoading(false);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getFileIcon = (file: FileItem) => {
    if (file.type === 'directory') {
      return <Folder className="h-4 w-4 text-blue-500" />;
    }
    
    const ext = file.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'txt':
      case 'md':
      case 'log':
        return <FileText className="h-4 w-4 text-gray-500" />;
      case 'jpg':
      case 'png':
      case 'gif':
      case 'jpeg':
        return <Image className="h-4 w-4 text-green-500" />;
      case 'zip':
      case 'tar':
      case 'gz':
        return <Archive className="h-4 w-4 text-orange-500" />;
      case 'js':
      case 'py':
      case 'sh':
      case 'json':
        return <Code className="h-4 w-4 text-purple-500" />;
      default:
        return <File className="h-4 w-4 text-gray-400" />;
    }
  };

  const handleFileDoubleClick = async (file: FileItem) => {
    if (file.type === 'directory') {
      if (file.name === '..') {
        const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
        setCurrentPath(parentPath);
      } else {
        setCurrentPath(`${currentPath}/${file.name}`);
      }
    } else {
      // Open file for viewing/editing
      setEditingFile(file);
      // Mock file content loading
      setFileContent(`# ${file.name}\n\nThis is mock content for ${file.name}\nFile size: ${formatFileSize(file.size)}\nLast modified: ${formatDate(file.modified)}\nPermissions: ${file.permissions}\n\n// Add your content here...`);
    }
  };

  const handleFileSelect = (fileName: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(fileName)) {
      newSelected.delete(fileName);
    } else {
      newSelected.add(fileName);
    }
    setSelectedFiles(newSelected);
  };

  const handleUpload = () => {
    // Mock file upload
    const mockTransfer: TransferItem = {
      id: `upload-${Date.now()}`,
      type: 'upload',
      fileName: 'uploaded-file.txt',
      size: 1024000,
      transferred: 0,
      status: 'transferring',
      speed: 0
    };
    
    setTransfers(prev => [...prev, mockTransfer]);
    setShowTransfers(true);
    
    // Simulate transfer progress
    const interval = setInterval(() => {
      setTransfers(prev => prev.map(t => {
        if (t.id === mockTransfer.id && t.status === 'transferring') {
          const newTransferred = Math.min(t.transferred + 50000, t.size);
          const speed = 250000; // 250 KB/s
          return {
            ...t,
            transferred: newTransferred,
            speed,
            status: newTransferred === t.size ? 'completed' : 'transferring'
          };
        }
        return t;
      }));
    }, 200);

    setTimeout(() => {
      clearInterval(interval);
      toast.success('File uploaded successfully');
      loadFiles(); // Refresh file list
    }, 5000);
  };

  const handleDownload = (file: FileItem) => {
    const mockTransfer: TransferItem = {
      id: `download-${Date.now()}`,
      type: 'download',
      fileName: file.name,
      size: file.size,
      transferred: 0,
      status: 'transferring',
      speed: 0
    };
    
    setTransfers(prev => [...prev, mockTransfer]);
    setShowTransfers(true);
    
    // Simulate transfer progress
    const interval = setInterval(() => {
      setTransfers(prev => prev.map(t => {
        if (t.id === mockTransfer.id && t.status === 'transferring') {
          const newTransferred = Math.min(t.transferred + 100000, t.size);
          const speed = 500000; // 500 KB/s
          return {
            ...t,
            transferred: newTransferred,
            speed,
            status: newTransferred === t.size ? 'completed' : 'transferring'
          };
        }
        return t;
      }));
    }, 200);

    setTimeout(() => {
      clearInterval(interval);
      toast.success(`${file.name} downloaded successfully`);
    }, 3000);
  };

  const handleCreateFolder = () => {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
      toast.success(`Folder "${folderName}" created`);
      loadFiles();
    }
  };

  const handleDeleteFile = (file: FileItem) => {
    if (confirm(`Are you sure you want to delete "${file.name}"?`)) {
      toast.success(`${file.name} deleted`);
      loadFiles();
    }
  };

  const handleSaveFile = () => {
    if (editingFile) {
      toast.success(`${editingFile.name} saved successfully`);
      setEditingFile(null);
      setFileContent('');
    }
  };

  const handleCopyFiles = (files: FileItem[]) => {
    setClipboard({ files, operation: 'copy' });
    toast.success(`${files.length} item(s) copied to clipboard`);
  };

  const handleCutFiles = (files: FileItem[]) => {
    setClipboard({ files, operation: 'cut' });
    toast.success(`${files.length} item(s) cut to clipboard`);
  };

  const handlePasteFiles = () => {
    if (clipboard) {
      const operation = clipboard.operation === 'copy' ? 'copied' : 'moved';
      toast.success(`${clipboard.files.length} item(s) ${operation} successfully`);
      setClipboard(null);
      loadFiles(); // Refresh file list
    }
  };

  const handleRenameFile = (file: FileItem) => {
    setRenamingFile(file);
    setNewFileName(file.name);
  };

  const handleRenameConfirm = () => {
    if (renamingFile && newFileName.trim()) {
      toast.success(`"${renamingFile.name}" renamed to "${newFileName}"`);
      setRenamingFile(null);
      setNewFileName('');
      loadFiles();
    }
  };

  const handleRenameCancel = () => {
    setRenamingFile(null);
    setNewFileName('');
  };

  const handleCopyPath = (file: FileItem) => {
    const fullPath = `${currentPath}/${file.name}`;
    navigator.clipboard.writeText(fullPath);
    toast.success('Path copied to clipboard');
  };

  const handleFileInfo = (file: FileItem) => {
    toast.info(`File: ${file.name}\nSize: ${formatFileSize(file.size)}\nModified: ${formatDate(file.modified)}\nPermissions: ${file.permissions}`);
  };

  const handleNewFile = () => {
    const fileName = prompt('Enter file name:');
    if (fileName) {
      toast.success(`File "${fileName}" created`);
      loadFiles();
    }
  };

  const handleDuplicateFile = (file: FileItem) => {
    const newName = `${file.name}_copy`;
    toast.success(`"${file.name}" duplicated as "${newName}"`);
    loadFiles();
  };

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter(prev => prev + 1);
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter(prev => {
      const newCount = prev - 1;
      if (newCount === 0) {
        setIsDraggingOver(false);
      }
      return newCount;
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    setDragCounter(0);

    const droppedFiles = Array.from(e.dataTransfer.files);
    
    if (droppedFiles.length === 0) return;

    toast.success(`Uploading ${droppedFiles.length} file${droppedFiles.length > 1 ? 's' : ''} to ${currentPath}`);
    
    // Process each dropped file
    droppedFiles.forEach((file, index) => {
      const mockTransfer: TransferItem = {
        id: `upload-${Date.now()}-${index}`,
        type: 'upload',
        fileName: file.name,
        size: file.size,
        transferred: 0,
        status: 'transferring',
        speed: 0
      };
      
      setTransfers(prev => [...prev, mockTransfer]);
      setShowTransfers(true);
      
      // Simulate transfer progress
      const interval = setInterval(() => {
        setTransfers(prev => prev.map(t => {
          if (t.id === mockTransfer.id && t.status === 'transferring') {
            const newTransferred = Math.min(t.transferred + 50000, t.size);
            const speed = 250000 + Math.random() * 100000; // Variable speed
            return {
              ...t,
              transferred: newTransferred,
              speed,
              status: newTransferred === t.size ? 'completed' : 'transferring'
            };
          }
          return t;
        }));
      }, 200);

      // Complete the transfer after simulated time
      const duration = Math.max(2000, (file.size / 250000) * 1000); // Simulate based on size
      setTimeout(() => {
        clearInterval(interval);
        setTransfers(prev => prev.map(t => 
          t.id === mockTransfer.id ? { ...t, status: 'completed' as const, transferred: t.size } : t
        ));
        
        // Show success message for last file
        if (index === droppedFiles.length - 1) {
          toast.success(`Successfully uploaded ${droppedFiles.length} file${droppedFiles.length > 1 ? 's' : ''}`);
          loadFiles(); // Refresh file list
        }
      }, duration);
    });
  };

  const filteredFiles = files.filter(file => 
    file.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Folder className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Connect to SSH to browse remote files</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col bg-background border-t ${resizingColumn ? 'cursor-col-resize select-none' : ''}`}>
      {/* Compact Toolbar */}
      <div className="px-2 py-1.5 border-b flex items-center gap-1.5 text-xs">
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setCurrentPath('/home')}>
          <Home className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={loadFiles} disabled={isLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={handleCreateFolder}>
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={handleUpload}>
          <Upload className="h-3.5 w-3.5" />
        </Button>
        
        <div className="flex-1 min-w-0">
          <Input
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-6 text-xs"
          />
        </div>
        
        <span className="text-muted-foreground whitespace-nowrap">{filteredFiles.length} items</span>
        
        {selectedFiles.size > 0 && (
          <span className="text-muted-foreground whitespace-nowrap">{selectedFiles.size} selected</span>
        )}
        
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setShowTransfers(!showTransfers)}>
          <Download className="h-3.5 w-3.5" />
          {transfers.length > 0 && (
            <Badge variant="secondary" className="ml-1 h-3.5 px-1 text-[10px]">
              {transfers.filter(t => t.status !== 'completed').length}
            </Badge>
          )}
        </Button>
      </div>

      {/* File List */}
      <div 
        className="flex-1 overflow-hidden relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDraggingOver && (
          <div className="absolute inset-0 bg-accent/20 border-2 border-dashed border-primary z-50 flex items-center justify-center pointer-events-none">
            <div className="bg-background/90 rounded-lg p-6 shadow-lg">
              <Upload className="h-12 w-12 mx-auto mb-3 text-primary" />
              <p className="font-medium">Drop files to upload</p>
              <p className="text-sm text-muted-foreground mt-1">Upload to {currentPath}</p>
            </div>
          </div>
        )}
        
        <ScrollArea className="h-full">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="p-1 min-h-full" data-columns-container>
                {/* Column Headers */}
                <div 
                  className="flex gap-2 px-2 py-1 text-xs font-medium text-muted-foreground border-b bg-muted/30 sticky top-0"
                >
                  <div className="flex items-center relative" style={{ width: `${columnWidths.name}px` }}>
                    <span>Name</span>
                    <div 
                      className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                      onMouseDown={(e) => handleResizeStart('name', e)}
                    >
                      <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                    </div>
                  </div>
                  <div className="flex items-center relative" style={{ width: `${columnWidths.size}px` }}>
                    <span>Size</span>
                    <div 
                      className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                      onMouseDown={(e) => handleResizeStart('size', e)}
                    >
                      <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                    </div>
                  </div>
                  <div className="flex items-center relative" style={{ width: `${columnWidths.modified}px` }}>
                    <span>Modified</span>
                    <div 
                      className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                      onMouseDown={(e) => handleResizeStart('modified', e)}
                    >
                      <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                    </div>
                  </div>
                  <div className="flex items-center relative" style={{ width: `${columnWidths.permissions}px` }}>
                    <span>Permissions</span>
                    <div 
                      className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                      onMouseDown={(e) => handleResizeStart('permissions', e)}
                    >
                      <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                    </div>
                  </div>
                  <div style={{ width: `${columnWidths.owner}px` }}>
                    <span>Owner</span>
                  </div>
                </div>
            
            {/* File Rows */}
            {filteredFiles.map((file, index) => (
              <ContextMenu key={index}>
                <ContextMenuTrigger asChild>
                  <div
                    className={`flex gap-2 px-2 py-1.5 hover:bg-muted/50 cursor-pointer border-b border-border/30 ${
                      selectedFiles.has(file.name) ? 'bg-accent' : ''
                    }`}
                    onClick={() => handleFileSelect(file.name)}
                    onDoubleClick={() => handleFileDoubleClick(file)}
                  >
                    <div className="flex items-center gap-2 min-w-0" style={{ width: `${columnWidths.name}px` }}>
                      {getFileIcon(file)}
                      {renamingFile?.name === file.name ? (
                        <Input
                          value={newFileName}
                          onChange={(e) => setNewFileName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameConfirm();
                            if (e.key === 'Escape') handleRenameCancel();
                          }}
                          onBlur={handleRenameConfirm}
                          className="text-sm h-6 px-1"
                          autoFocus
                        />
                      ) : (
                        <span className="text-sm truncate">{file.name}</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" style={{ width: `${columnWidths.size}px` }}>
                      {file.type === 'file' ? formatFileSize(file.size) : '-'}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" style={{ width: `${columnWidths.modified}px` }}>
                      {file.name !== '..' ? formatDate(file.modified) : '-'}
                    </div>
                    <div className="text-sm font-mono text-muted-foreground truncate" style={{ width: `${columnWidths.permissions}px` }}>
                      {file.permissions}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" style={{ width: `${columnWidths.owner}px` }}>
                      {file.owner}:{file.group}
                    </div>
                  </div>
                </ContextMenuTrigger>
                
                <ContextMenuContent className="w-64">
                  {/* File-specific actions */}
                  {file.type === 'file' && (
                    <>
                      <ContextMenuItem onClick={() => handleFileDoubleClick(file)}>
                        <Eye className="mr-2 h-4 w-4" />
                        Open
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleFileDoubleClick(file)}>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  
                  {/* Directory-specific actions */}
                  {file.type === 'directory' && file.name !== '..' && (
                    <>
                      <ContextMenuItem onClick={() => handleFileDoubleClick(file)}>
                        <Folder className="mr-2 h-4 w-4" />
                        Open Folder
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Common actions */}
                  {file.name !== '..' && (
                    <>
                      <ContextMenuItem onClick={() => handleCopyFiles([file])}>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCutFiles([file])}>
                        <Scissors className="mr-2 h-4 w-4" />
                        Cut
                      </ContextMenuItem>
                      {clipboard && (
                        <ContextMenuItem onClick={handlePasteFiles}>
                          <ClipboardPaste className="mr-2 h-4 w-4" />
                          Paste {clipboard.files.length} item(s)
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      
                      <ContextMenuItem onClick={() => handleRenameFile(file)}>
                        <FileEdit className="mr-2 h-4 w-4" />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleDuplicateFile(file)}>
                        <Layers className="mr-2 h-4 w-4" />
                        Duplicate
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Download for files */}
                  {file.type === 'file' && (
                    <>
                      <ContextMenuItem onClick={() => handleDownload(file)}>
                        <Download className="mr-2 h-4 w-4" />
                        Download
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Information and sharing */}
                  <ContextMenuItem onClick={() => handleCopyPath(file)}>
                    <Link className="mr-2 h-4 w-4" />
                    Copy Path
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleFileInfo(file)}>
                    <Info className="mr-2 h-4 w-4" />
                    Properties
                  </ContextMenuItem>

                  {/* Destructive actions */}
                  {file.name !== '..' && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem 
                        className="text-destructive focus:text-destructive"
                        onClick={() => handleDeleteFile(file)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            ))}
              </div>
            </ContextMenuTrigger>
            
            {/* Empty space context menu */}
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={handleNewFile}>
                <File className="mr-2 h-4 w-4" />
                New File
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCreateFolder}>
                <FolderPlus className="mr-2 h-4 w-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              
              {clipboard && (
                <>
                  <ContextMenuItem onClick={handlePasteFiles}>
                    <ClipboardPaste className="mr-2 h-4 w-4" />
                    Paste {clipboard.files.length} item(s)
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              
              <ContextMenuItem onClick={handleUpload}>
                <Upload className="mr-2 h-4 w-4" />
                Upload Files
              </ContextMenuItem>
              <ContextMenuItem onClick={loadFiles}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </ContextMenuItem>
              <ContextMenuSeparator />
              
              <ContextMenuItem onClick={() => setSelectedFiles(new Set())}>
                <X className="mr-2 h-4 w-4" />
                Clear Selection
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </ScrollArea>
      </div>

      {/* Transfer Queue */}
      {showTransfers && transfers.length > 0 && (
        <div className="border-t bg-muted/30 p-3 max-h-32 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">File Transfers</span>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => setShowTransfers(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {transfers.map((transfer) => (
            <div key={transfer.id} className="flex items-center gap-3 p-2 bg-background rounded mb-1">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  {transfer.type === 'upload' ? (
                    <Upload className="h-4 w-4 text-blue-500 flex-shrink-0" />
                  ) : (
                    <Download className="h-4 w-4 text-green-500 flex-shrink-0" />
                  )}
                  <span className="truncate">{transfer.fileName}</span>
                  <Badge variant={transfer.status === 'completed' ? 'default' : 'secondary'} className="flex-shrink-0">
                    {transfer.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatFileSize(transfer.transferred)} / {formatFileSize(transfer.size)}
                  {transfer.status === 'transferring' && transfer.speed > 0 && (
                    <span className="ml-2">{formatFileSize(transfer.speed)}/s</span>
                  )}
                </div>
                <Progress 
                  value={(transfer.transferred / transfer.size) * 100} 
                  className="mt-1 h-1"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* File Editor Dialog */}
      <Dialog open={!!editingFile} onOpenChange={(open) => !open && setEditingFile(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="h-4 w-4" />
              Editing: {editingFile?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 h-[60vh]">
            <Textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              className="flex-1 font-mono text-sm resize-none"
              placeholder="File content..."
            />
            <div className="flex justify-between">
              <div className="text-sm text-muted-foreground">
                {editingFile && `${formatFileSize(editingFile.size)} • ${editingFile.permissions} • ${editingFile.owner}:${editingFile.group}`}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditingFile(null)}>
                  Cancel
                </Button>
                <Button onClick={handleSaveFile}>
                  <Save className="mr-2 h-4 w-4" />
                  Save
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}