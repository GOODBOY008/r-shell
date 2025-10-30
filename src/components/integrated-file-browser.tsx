import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

// Cache to store state per session
const sessionStateCache = new Map<string, {
  currentPath: string;
  files: FileItem[];
  selectedFiles: Set<string>;
  searchTerm: string;
}>();

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

  // Restore or initialize state when session changes
  useEffect(() => {
    if (sessionId) {
      const cached = sessionStateCache.get(sessionId);
      if (cached) {
        // Restore previous state
        setCurrentPath(cached.currentPath);
        setFiles(cached.files);
        setSelectedFiles(cached.selectedFiles);
        setSearchTerm(cached.searchTerm);
      } else {
        // Initialize new session state
        setCurrentPath('/home');
        setFiles([]);
        setSelectedFiles(new Set());
        setSearchTerm('');
      }
    }
  }, [sessionId]);

  // Save state to cache when it changes
  useEffect(() => {
    if (sessionId) {
      sessionStateCache.set(sessionId, {
        currentPath,
        files,
        selectedFiles,
        searchTerm
      });
    }
  }, [sessionId, currentPath, files, selectedFiles, searchTerm]);

  useEffect(() => {
    if (isConnected && sessionId) {
      console.log('useEffect triggered - loading files', { currentPath, sessionId, isConnected });
      loadFiles();
    }
  }, [currentPath, isConnected, sessionId]);

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
    if (!sessionId || !isConnected) {
      setFiles([]);
      return;
    }
    
    setIsLoading(true);
    try {
      const output = await invoke<string>(
        'list_files',
        { sessionId: sessionId, path: currentPath }
      );
      
      if (output) {
        // Parse ls -la --time-style=long-iso output to FileItem format
        // Format: perms links owner group size date time filename
        // Example: drwxr-xr-x  5 root root 72 2025-09-17 03:38 giga-sls
        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        
        console.log('Parsing files from output:', output);
        console.log('Found lines:', lines.length);
        
        const parsedFiles: FileItem[] = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          
          console.log('Parsing line:', line);
          console.log('Parts:', parts);
          
          if (parts.length < 8) {
            console.log('Skipping line - not enough parts:', parts.length);
            return null;
          }
          
          const permissions = parts[0];
          const owner = parts[2];
          const group = parts[3];
          const size = parseInt(parts[4]) || 0;
          // parts[5] is date, parts[6] is time, parts[7+] is filename
          const name = parts.slice(7).join(' ');
          const type = permissions.startsWith('d') ? 'directory' : 'file';
          
          console.log('Parsed file:', { name, type, permissions, owner, group, size });
          
          // Skip . and .. entries
          if (name === '.' || name === '..') {
            console.log('Skipping . or ..');
            return null;
          }
          
          return {
            name,
            type,
            size,
            modified: new Date(),
            permissions,
            owner,
            group,
            path: currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
          } as FileItem;
        }).filter(f => f !== null) as FileItem[];
        
        // Add parent directory navigation
        if (currentPath !== '/') {
          parsedFiles.unshift({
            name: '..',
            type: 'directory',
            size: 0,
            modified: new Date(),
            permissions: 'drwxr-xr-x',
            owner: '-',
            group: '-',
            path: currentPath.split('/').slice(0, -1).join('/') || '/'
          });
        }
        
        setFiles(parsedFiles);
      }
    } catch (error) {
      console.error('Failed to load files:', error);
      toast.error('Failed to load files');
      setFiles([]);
    } finally {
      setIsLoading(false);
    }
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
    console.log('handleFileDoubleClick called', { file, currentPath, sessionId });
    
    if (file.type === 'directory') {
      console.log('Navigating to directory:', file.path);
      setCurrentPath(file.path);
    } else {
      // Open file for viewing/editing
      console.log('Opening file for viewing');
      setEditingFile(file);
      setIsLoading(true);
      try {
        const content = await invoke<string>('read_file_content', {
          sessionId,
          path: file.path
        });
        setFileContent(content);
      } catch (error) {
        console.error('Failed to read file:', error);
        toast.error('Failed to read file content');
        setFileContent(`# ${file.name}\n\nError loading file content: ${error}`);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleFileSelect = (fileName: string, event: React.MouseEvent) => {
    // Only select/deselect if Ctrl (Windows/Linux) or Cmd (Mac) is pressed
    if (event.ctrlKey || event.metaKey) {
      event.stopPropagation();
      const newSelected = new Set(selectedFiles);
      if (newSelected.has(fileName)) {
        newSelected.delete(fileName);
      } else {
        newSelected.add(fileName);
      }
      setSelectedFiles(newSelected);
    }
    // If not holding Ctrl/Cmd, do nothing (allow double-click to handle navigation)
  };

  const handleFileClick = (file: FileItem, event: React.MouseEvent) => {
    console.log('handleFileClick called', { file, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    
    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd + Click: toggle selection
      handleFileSelect(file.name, event);
    } else {
      // Regular click on directory: navigate into it
      if (file.type === 'directory') {
        console.log('Click - navigating to directory:', file.path);
        setCurrentPath(file.path);
      }
      // Regular click on file: do nothing (or optionally preview)
    }
  };

  const handleUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;

      const fileArray = Array.from(files);
      toast.success(`Uploading ${fileArray.length} file${fileArray.length > 1 ? 's' : ''}`);
      
      for (let i = 0; i < fileArray.length; i++) {
        const file = fileArray[i];
        const transferId = `upload-${Date.now()}-${i}`;
        
        const mockTransfer: TransferItem = {
          id: transferId,
          type: 'upload',
          fileName: file.name,
          size: file.size,
          transferred: 0,
          status: 'transferring',
          speed: 0
        };
        
        setTransfers(prev => [...prev, mockTransfer]);
        setShowTransfers(true);
        
        try {
          // Read file content
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          
          // Upload using SFTP
          const remotePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
          
          const result = await invoke<{ success: boolean; bytesTransferred?: number; error?: string }>(
            'sftp_upload_file',
            {
              request: {
                session_id: sessionId,
                local_path: '',
                remote_path: remotePath,
                data: Array.from(uint8Array)
              }
            }
          );
          
          if (result.success) {
            setTransfers(prev => prev.map(t => 
              t.id === transferId ? { ...t, status: 'completed' as const, transferred: file.size } : t
            ));
            
            if (i === fileArray.length - 1) {
              toast.success(`Successfully uploaded ${fileArray.length} file${fileArray.length > 1 ? 's' : ''}`);
              loadFiles();
            }
          } else {
            setTransfers(prev => prev.map(t => 
              t.id === transferId ? { ...t, status: 'error' as const } : t
            ));
            toast.error(`Failed to upload ${file.name}`);
          }
        } catch (error) {
          console.error('Upload error:', error);
          setTransfers(prev => prev.map(t => 
            t.id === transferId ? { ...t, status: 'error' as const } : t
          ));
          toast.error(`Failed to upload ${file.name}`);
        }
      }
    };
    input.click();
  };

  const handleDownload = async (file: FileItem) => {
    const transferId = `download-${Date.now()}`;
    
    const mockTransfer: TransferItem = {
      id: transferId,
      type: 'download',
      fileName: file.name,
      size: file.size,
      transferred: 0,
      status: 'transferring',
      speed: 0
    };
    
    setTransfers(prev => [...prev, mockTransfer]);
    setShowTransfers(true);
    
    try {
      const remotePath = file.path;
      
      // Download using SFTP
      const result = await invoke<{ success: boolean; data?: number[]; error?: string }>(
        'sftp_download_file',
        {
          request: {
            session_id: sessionId,
            local_path: '',
            remote_path: remotePath
          }
        }
      );
      
      if (result.success && result.data) {
        // Convert data to blob and download
        const uint8Array = new Uint8Array(result.data);
        const blob = new Blob([uint8Array]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        setTransfers(prev => prev.map(t => 
          t.id === transferId ? { ...t, status: 'completed' as const, transferred: file.size } : t
        ));
        toast.success(`${file.name} downloaded successfully`);
      } else {
        setTransfers(prev => prev.map(t => 
          t.id === transferId ? { ...t, status: 'error' as const } : t
        ));
        toast.error(`Failed to download ${file.name}`);
      }
    } catch (error) {
      console.error('Download error:', error);
      setTransfers(prev => prev.map(t => 
        t.id === transferId ? { ...t, status: 'error' as const } : t
      ));
      toast.error(`Failed to download ${file.name}`);
    }
  };

  const handleCreateFolder = async () => {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
      try {
        const folderPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        await invoke<boolean>('create_directory', {
          sessionId,
          path: folderPath
        });
        toast.success(`Folder "${folderName}" created`);
        loadFiles();
      } catch (error) {
        console.error('Failed to create folder:', error);
        toast.error('Failed to create folder');
      }
    }
  };

  const handleDeleteFile = async (file: FileItem) => {
    if (confirm(`Are you sure you want to delete "${file.name}"?`)) {
      try {
        const filePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        await invoke<boolean>('delete_file', {
          sessionId,
          path: filePath,
          isDirectory: file.type === 'directory'
        });
        toast.success(`${file.name} deleted`);
        loadFiles();
      } catch (error) {
        console.error('Failed to delete file:', error);
        toast.error('Failed to delete file');
      }
    }
  };

  const handleSaveFile = async () => {
    if (editingFile) {
      try {
        const filePath = currentPath === '/' ? `/${editingFile.name}` : `${currentPath}/${editingFile.name}`;
        await invoke<boolean>('create_file', {
          sessionId,
          path: filePath,
          content: fileContent
        });
        toast.success(`${editingFile.name} saved successfully`);
        setEditingFile(null);
        setFileContent('');
        loadFiles();
      } catch (error) {
        console.error('Failed to save file:', error);
        toast.error('Failed to save file');
      }
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

  const handlePasteFiles = async () => {
    if (clipboard) {
      try {
        for (const file of clipboard.files) {
          const destPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
          
          if (clipboard.operation === 'copy') {
            await invoke<boolean>('copy_file', {
              sessionId,
              sourcePath: file.path,
              destPath
            });
          } else {
            await invoke<boolean>('rename_file', {
              sessionId,
              oldPath: file.path,
              newPath: destPath
            });
          }
        }
        
        const operation = clipboard.operation === 'copy' ? 'copied' : 'moved';
        toast.success(`${clipboard.files.length} item(s) ${operation} successfully`);
        setClipboard(null);
        loadFiles();
      } catch (error) {
        console.error('Failed to paste files:', error);
        toast.error('Failed to paste files');
      }
    }
  };

  const handleRenameFile = (file: FileItem) => {
    setRenamingFile(file);
    setNewFileName(file.name);
  };

  const handleRenameConfirm = async () => {
    if (renamingFile && newFileName.trim()) {
      try {
        const oldPath = currentPath === '/' ? `/${renamingFile.name}` : `${currentPath}/${renamingFile.name}`;
        const newPath = currentPath === '/' ? `/${newFileName}` : `${currentPath}/${newFileName}`;
        
        await invoke<boolean>('rename_file', {
          sessionId,
          oldPath,
          newPath
        });
        
        toast.success(`"${renamingFile.name}" renamed to "${newFileName}"`);
        setRenamingFile(null);
        setNewFileName('');
        loadFiles();
      } catch (error) {
        console.error('Failed to rename file:', error);
        toast.error('Failed to rename file');
      }
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

  const handleNewFile = async () => {
    const fileName = prompt('Enter file name:');
    if (fileName) {
      try {
        const filePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
        await invoke<boolean>('create_file', {
          sessionId,
          path: filePath,
          content: ''
        });
        toast.success(`File "${fileName}" created`);
        loadFiles();
      } catch (error) {
        console.error('Failed to create file:', error);
        toast.error('Failed to create file');
      }
    }
  };

  const handleDuplicateFile = async (file: FileItem) => {
    const newName = `${file.name}_copy`;
    try {
      const sourcePath = file.path;
      const destPath = currentPath === '/' ? `/${newName}` : `${currentPath}/${newName}`;
      
      await invoke<boolean>('copy_file', {
        sessionId,
        sourcePath,
        destPath
      });
      
      toast.success(`"${file.name}" duplicated as "${newName}"`);
      loadFiles();
    } catch (error) {
      console.error('Failed to duplicate file:', error);
      toast.error('Failed to duplicate file');
    }
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

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    setDragCounter(0);

    const droppedFiles = Array.from(e.dataTransfer.files);
    
    if (droppedFiles.length === 0) return;

    toast.success(`Uploading ${droppedFiles.length} file${droppedFiles.length > 1 ? 's' : ''} to ${currentPath}`);
    
    // Process each dropped file
    for (let index = 0; index < droppedFiles.length; index++) {
      const file = droppedFiles[index];
      const transferId = `upload-${Date.now()}-${index}`;
      
      const mockTransfer: TransferItem = {
        id: transferId,
        type: 'upload',
        fileName: file.name,
        size: file.size,
        transferred: 0,
        status: 'transferring',
        speed: 0
      };
      
      setTransfers(prev => [...prev, mockTransfer]);
      setShowTransfers(true);
      
      try {
        // Read file content
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Upload using SFTP
        const remotePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        
        const result = await invoke<{ success: boolean; bytesTransferred?: number; error?: string }>(
          'sftp_upload_file',
          {
            request: {
              session_id: sessionId,
              local_path: '',
              remote_path: remotePath,
              data: Array.from(uint8Array)
            }
          }
        );
        
        if (result.success) {
          setTransfers(prev => prev.map(t => 
            t.id === transferId ? { ...t, status: 'completed' as const, transferred: file.size } : t
          ));
          
          // Show success message for last file
          if (index === droppedFiles.length - 1) {
            toast.success(`Successfully uploaded ${droppedFiles.length} file${droppedFiles.length > 1 ? 's' : ''}`);
            loadFiles(); // Refresh file list
          }
        } else {
          setTransfers(prev => prev.map(t => 
            t.id === transferId ? { ...t, status: 'error' as const } : t
          ));
          toast.error(`Failed to upload ${file.name}`);
        }
      } catch (error) {
        console.error('Upload error:', error);
        setTransfers(prev => prev.map(t => 
          t.id === transferId ? { ...t, status: 'error' as const } : t
        ));
        toast.error(`Failed to upload ${file.name}`);
      }
    }
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
                    onClick={(e) => handleFileClick(file, e)}
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