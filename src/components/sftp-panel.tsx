import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Badge } from "./ui/badge";
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
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface SFTPPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: string;
  host?: string;
}

interface FileItem {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: Date;
  permissions: string;
  owner: string;
  group: string;
}

interface TransferItem {
  id: string;
  type: "upload" | "download";
  localPath: string;
  remotePath: string;
  size: number;
  transferred: number;
  status: "queued" | "transferring" | "completed" | "error";
  speed: number;
}

export function SFTPPanel({
  open,
  onOpenChange,
  sessionId,
  host,
}: SFTPPanelProps) {
  const [currentPath, setCurrentPath] = useState("/home");
  const [files, setFiles] = useState<FileItem[]>([
    {
      name: "..",
      type: "directory",
      size: 0,
      modified: new Date(),
      permissions: "drwxr-xr-x",
      owner: "root",
      group: "root",
    },
    {
      name: "documents",
      type: "directory",
      size: 4096,
      modified: new Date(),
      permissions: "drwxr-xr-x",
      owner: "user",
      group: "user",
    },
    {
      name: "config.txt",
      type: "file",
      size: 1024,
      modified: new Date(),
      permissions: "-rw-r--r--",
      owner: "user",
      group: "user",
    },
    {
      name: "script.sh",
      type: "file",
      size: 2048,
      modified: new Date(),
      permissions: "-rwxr-xr-x",
      owner: "user",
      group: "user",
    },
  ]);
  const [transfers, setTransfers] = useState<TransferItem[]>(
    [],
  );
  const [selectedFiles, setSelectedFiles] = useState<
    Set<string>
  >(new Set());

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (
      parseFloat((bytes / Math.pow(k, i)).toFixed(2)) +
      " " +
      sizes[i]
    );
  };

  const getFileIcon = (file: FileItem) => {
    if (file.type === "directory") {
      return <Folder className="h-4 w-4 text-blue-500" />;
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "txt":
      case "md":
      case "log":
        return <FileText className="h-4 w-4 text-gray-500" />;
      case "jpg":
      case "png":
      case "gif":
        return <Image className="h-4 w-4 text-green-500" />;
      case "zip":
      case "tar":
      case "gz":
        return <Archive className="h-4 w-4 text-orange-500" />;
      case "js":
      case "py":
      case "sh":
        return <Code className="h-4 w-4 text-purple-500" />;
      default:
        return <File className="h-4 w-4 text-gray-400" />;
    }
  };

  const handleFileDoubleClick = (file: FileItem) => {
    if (file.type === "directory") {
      if (file.name === "..") {
        const parentPath =
          currentPath.split("/").slice(0, -1).join("/") || "/";
        setCurrentPath(parentPath);
      } else {
        setCurrentPath(`${currentPath}/${file.name}`);
      }
    }
  };

  const handleUpload = () => {
    // Mock upload
    const mockTransfer: TransferItem = {
      id: `upload-${Date.now()}`,
      type: "upload",
      localPath: "/local/file.txt",
      remotePath: `${currentPath}/file.txt`,
      size: 1024000,
      transferred: 0,
      status: "transferring",
      speed: 0,
    };
    setTransfers((prev) => [...prev, mockTransfer]);

    // Simulate transfer progress
    const interval = setInterval(() => {
      setTransfers((prev) =>
        prev.map((t) => {
          if (
            t.id === mockTransfer.id &&
            t.status === "transferring"
          ) {
            const newTransferred = Math.min(
              t.transferred + 50000,
              t.size,
            );
            const speed = 250000; // 250 KB/s
            return {
              ...t,
              transferred: newTransferred,
              speed,
              status:
                newTransferred === t.size
                  ? "completed"
                  : "transferring",
            };
          }
          return t;
        }),
      );
    }, 200);

    setTimeout(() => clearInterval(interval), 5000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            SFTP File Transfer - {host}
          </DialogTitle>
          <DialogDescription>
            Browse and transfer files between your local system
            and the remote server.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 px-6 py-4 flex-1 overflow-hidden">
          {/* Local Files (Left Panel) */}
          <div className="border rounded-lg">
            <div className="p-3 border-b bg-muted/50">
              <div className="flex items-center justify-between">
                <span className="font-medium">Local Files</span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm">
                    <Home className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm">
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Input
                placeholder="C:\Users\Desktop"
                className="mt-2"
                value="/home/user/Desktop"
                readOnly
              />
            </div>
            <ScrollArea className="h-[400px]">
              <div className="p-2">
                {[
                  {
                    name: "document.pdf",
                    type: "file" as const,
                    size: 2048000,
                  },
                  {
                    name: "image.jpg",
                    type: "file" as const,
                    size: 1024000,
                  },
                  {
                    name: "script.py",
                    type: "file" as const,
                    size: 4096,
                  },
                ].map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 cursor-pointer"
                  >
                    {getFileIcon(file)}
                    <div className="flex-1">
                      <div className="text-sm">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Remote Files (Right Panel) */}
          <div className="border rounded-lg">
            <div className="p-3 border-b bg-muted/50">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  Remote Files
                </span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm">
                    <Home className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {}}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem>
                        <Plus className="mr-2 h-4 w-4" />
                        New Folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleUpload}>
                        <Upload className="mr-2 h-4 w-4" />
                        Upload Files
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <Input
                placeholder="Remote path"
                className="mt-2"
                value={currentPath}
                onChange={(e) => setCurrentPath(e.target.value)}
              />
            </div>
            <ScrollArea className="h-[400px]">
              <div className="p-2">
                {files.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 cursor-pointer"
                    onDoubleClick={() =>
                      handleFileDoubleClick(file)
                    }
                  >
                    {getFileIcon(file)}
                    <div className="flex-1">
                      <div className="text-sm">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {file.type === "file"
                          ? formatFileSize(file.size)
                          : "Directory"}{" "}
                        • {file.permissions}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem>
                          <Download className="mr-2 h-4 w-4" />
                          Download
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive">
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>

        {/* Transfer Queue */}
        {transfers.length > 0 && (
          <div className="border-t px-6 py-4 bg-muted/30">
            <h3 className="font-medium mb-2">Transfer Queue</h3>
            <ScrollArea className="h-32">
              {transfers.map((transfer) => (
                <div
                  key={transfer.id}
                  className="flex items-center gap-3 p-2 border rounded mb-2"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      {transfer.type === "upload" ? (
                        <Upload className="h-4 w-4 text-blue-500" />
                      ) : (
                        <Download className="h-4 w-4 text-green-500" />
                      )}
                      <span>
                        {transfer.localPath.split("/").pop()}
                      </span>
                      <Badge
                        variant={
                          transfer.status === "completed"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {transfer.status}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatFileSize(transfer.transferred)} /{" "}
                      {formatFileSize(transfer.size)}
                      {transfer.status === "transferring" && (
                        <span className="ml-2">
                          {formatFileSize(transfer.speed)}/s
                        </span>
                      )}
                    </div>
                    <Progress
                      value={
                        (transfer.transferred / transfer.size) *
                        100
                      }
                      className="mt-2 h-2"
                    />
                  </div>
                </div>
              ))}
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}