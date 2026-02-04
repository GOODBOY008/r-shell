import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, RefreshCw, Download, Search, Filter, X, Lock, Unlock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { toast } from 'sonner';

interface LogViewerProps {
  connectionId?: string;
}

interface LogFile {
  path: string;
  name: string;
}

export function LogViewer({ connectionId }: LogViewerProps) {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedLogPath, setSelectedLogPath] = useState<string>('');
  const [logContent, setLogContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [lineCount, setLineCount] = useState<number>(50);
  const [scrollLocked, setScrollLocked] = useState(true); // Auto-scroll to bottom when locked
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef<number>(0);

  // Fetch available log files
  const fetchLogFiles = async () => {
    if (!connectionId) return;
    
    try {
      const result = await invoke<{ success: boolean; output?: string; error?: string }>(
        'list_log_files',
        { connectionId }
      );
      
      if (result.success && result.output) {
        const files = result.output
          .split('\n')
          .filter(path => path.trim())
          .map(path => ({
            path: path.trim(),
            name: path.split('/').pop() || path
          }));
        setLogFiles(files);
      }
    } catch (error) {
      console.error('Failed to fetch log files:', error);
      toast.error('Failed to Load Log Files', {
        description: error instanceof Error ? error.message : 'Unable to fetch log file list from server.',
      });
    }
  };

  // Fetch log content with smooth update
  const fetchLogContent = useCallback(async (isAutoRefresh = false) => {
    if (!connectionId || !selectedLogPath) return;
    
    if (!isAutoRefresh) {
      setIsLoading(true);
    }
    
    try {
      const result = await invoke<{ success: boolean; output?: string; error?: string }>(
        'tail_log',
        { 
          connectionId,
          logPath: selectedLogPath,
          lines: lineCount
        }
      );
      
      if (result.success && result.output) {
        // Store scroll position before update
        const scrollContainer = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]');
        const wasAtBottom = scrollContainer 
          ? scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 50
          : true;
        
        setLogContent(result.output);
        
        // Restore scroll position or scroll to bottom if locked
        if (scrollLocked || wasAtBottom) {
          setTimeout(() => {
            if (scrollContainer) {
              scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
          }, 10);
        }
      } else {
        setLogContent(`Error: ${result.error || 'Failed to fetch log'}`);
        if (!isAutoRefresh) {
          toast.error('Failed to Load Log Content', {
            description: result.error || 'Unable to fetch log content from server.',
          });
        }
      }
    } catch (error) {
      setLogContent(`Error: ${error}`);
      if (!isAutoRefresh) {
        toast.error('Failed to Load Log Content', {
          description: error instanceof Error ? error.message : 'An unexpected error occurred.',
        });
      }
    } finally {
      if (!isAutoRefresh) {
        setIsLoading(false);
      }
    }
  }, [connectionId, selectedLogPath, lineCount, scrollLocked]);

  // Load log files on mount
  useEffect(() => {
    if (connectionId) {
      fetchLogFiles();
    }
  }, [connectionId]);

  // Auto-refresh log content
  useEffect(() => {
    if (!autoRefresh || !selectedLogPath) return;
    
    const interval = setInterval(() => fetchLogContent(true), 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedLogPath, fetchLogContent]);

  // Memoized log lines to prevent unnecessary re-renders
  const logLines = useMemo(() => {
    return logContent.split('\n');
  }, [logContent]);

  // Filter log lines based on search term
  const filteredLogLines = useMemo(() => {
    if (!searchTerm) return logLines;
    const lowerSearch = searchTerm.toLowerCase();
    return logLines.filter(line => line.toLowerCase().includes(lowerSearch));
  }, [logLines, searchTerm]);

  // Highlight log levels - memoized function
  const highlightLogLine = useCallback((line: string) => {
    const lowerLine = line.toLowerCase();
    if (lowerLine.includes('error') || lowerLine.includes('err')) {
      return 'text-red-400';
    } else if (lowerLine.includes('warn') || lowerLine.includes('warning')) {
      return 'text-yellow-400';
    } else if (lowerLine.includes('info')) {
      return 'text-blue-400';
    } else if (lowerLine.includes('debug')) {
      return 'text-gray-400';
    }
    return 'text-foreground';
  }, []);

  // Detect user scroll to unlock auto-scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 50;
    
    // Auto-lock when user scrolls to bottom, unlock when scrolling up
    if (isAtBottom && !scrollLocked) {
      setScrollLocked(true);
    } else if (!isAtBottom && scrollLocked && target.scrollTop < lastScrollTop.current) {
      setScrollLocked(false);
    }
    
    lastScrollTop.current = target.scrollTop;
  }, [scrollLocked]);

  // Download logs
  const downloadLogs = () => {
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedLogPath.split('/').pop()}_${new Date().toISOString()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col p-3 space-y-3">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4" />
        <h2 className="text-sm font-medium">Log Viewer</h2>
        {selectedLogPath && autoRefresh && (
          <Badge variant="secondary" className="text-xs">
            Auto-refresh
          </Badge>
        )}
      </div>

      {/* Log file selector */}
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-xs">Select Log File</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <div className="flex gap-2">
            <Select value={selectedLogPath} onValueChange={setSelectedLogPath}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Choose a log file..." />
              </SelectTrigger>
              <SelectContent>
                {logFiles.map(file => (
                  <SelectItem key={file.path} value={file.path}>
                    {file.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={fetchLogFiles}>
              <RefreshCw className="w-3 h-3" />
            </Button>
          </div>

          <div className="flex gap-2 items-center">
            <Input
              type="number"
              value={lineCount}
              onChange={(e) => setLineCount(parseInt(e.target.value) || 50)}
              className="w-20 h-8 text-xs"
              min={10}
              max={1000}
            />
            <span className="text-xs text-muted-foreground">lines</span>
            <Button
              size="sm"
              onClick={() => fetchLogContent()}
              disabled={!selectedLogPath || isLoading}
            >
              Load
            </Button>
            <Button
              size="sm"
              variant={autoRefresh ? 'default' : 'outline'}
              onClick={() => setAutoRefresh(!autoRefresh)}
              disabled={!selectedLogPath}
            >
              Auto-refresh
            </Button>
            <Button
              size="sm"
              variant={scrollLocked ? 'default' : 'outline'}
              onClick={() => setScrollLocked(!scrollLocked)}
              disabled={!selectedLogPath}
              title={scrollLocked ? 'Click to unlock scroll (stay at current position)' : 'Click to lock scroll (auto-scroll to bottom)'}
            >
              {scrollLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Search and filters */}
      {selectedLogPath && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
                <Input
                  placeholder="Search logs..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
                {searchTerm && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="absolute right-1 top-1 h-6 w-6 p-0"
                    onClick={() => setSearchTerm('')}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={downloadLogs} disabled={!logContent}>
                <Download className="w-3 h-3 mr-1" />
                Download
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Log content */}
      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardContent className="p-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full" ref={scrollAreaRef}>
            <div 
              className="p-3" 
              ref={contentRef}
              onScroll={handleScroll}
            >
              {!selectedLogPath ? (
                <div className="text-center text-sm text-muted-foreground py-8">
                  Select a log file to view
                </div>
              ) : isLoading ? (
                <div className="text-center text-sm text-muted-foreground py-8">
                  Loading logs...
                </div>
              ) : filteredLogLines.length > 0 ? (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                  {filteredLogLines.map((line, i) => (
                    <div key={`${selectedLogPath}-${i}-${line.substring(0, 20)}`} className={highlightLogLine(line)}>
                      {line || '\n'}
                    </div>
                  ))}
                </pre>
              ) : logContent ? (
                <div className="text-center text-sm text-muted-foreground py-8">
                  No matching log lines
                </div>
              ) : (
                <div className="text-center text-sm text-muted-foreground py-8">
                  No log content
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
