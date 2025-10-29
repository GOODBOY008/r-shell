import React, { useState, useEffect, useRef } from 'react';
import { ScrollArea } from './ui/scroll-area';

interface TerminalLine {
  id: string;
  content: string;
  type: 'output' | 'input' | 'error';
  timestamp: Date;
}

interface TerminalProps {
  sessionId: string;
  sessionName: string;
  host?: string;
  username?: string;
}

const mockFileSystem = [
  'Downloads', 'Music', 'Pictures', 'Public', 'snap', 'Tasks', 'Templates', 'Videos'
];

const mockCommands = {
  'ls': () => `drwxr-xr-x 2 user01 user01 4096 Sep  2 13:55 ${mockFileSystem.join('\ndrwxr-xr-x 2 user01 user01 4096 Sep  2 13:55 ')}`,
  'pwd': () => '/home/user01',
  'whoami': () => 'user01',
  'date': () => new Date().toString(),
  'uname -a': () => 'Linux Virtual-Machine 5.15.0-72-generic #79-Ubuntu SMP Wed Apr 19 08:22:18 UTC 2023 x86_64 x86_64 x86_64 GNU/Linux',
  'ps': () => `  PID TTY          TIME CMD
 1234 pts/0    00:00:01 bash
 5678 pts/0    00:00:00 ps`,
  'df -h': () => `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        20G  8.5G   11G  45% /
tmpfs           2.0G     0  2.0G   0% /dev/shm`,
  'free -h': () => `              total        used        free      shared  buff/cache   available
Mem:           3.8G        1.2G        1.1G        45M        1.5G        2.3G
Swap:          2.0G          0B        2.0G`,
  'uptime': () => `13:55:42 up 2 days, 14:26,  1 user,  load average: 0.08, 0.12, 0.09`,
  'clear': () => 'CLEAR_SCREEN'
};

export function Terminal({ sessionId, sessionName, host = 'localhost', username = 'user01' }: TerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([
    {
      id: '1',
      content: `Welcome to ${sessionName}`,
      type: 'output',
      timestamp: new Date()
    },
    {
      id: '2',
      content: `Last login: ${new Date().toLocaleString()}`,
      type: 'output',
      timestamp: new Date()
    },
    {
      id: '3',
      content: `Connected to ${host}. File browser is available below.`,
      type: 'output',
      timestamp: new Date()
    }
  ]);
  
  const [currentInput, setCurrentInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [currentPath, setCurrentPath] = useState('/home/user01');
  
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const prompt = `${username}@${host.split('.')[0]}:${currentPath.split('/').pop() || '/'}$ `;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    // Focus input when component mounts or sessionId changes
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, [sessionId]);

  const executeCommand = (command: string) => {
    const trimmedCommand = command.trim();
    
    // Add command to history
    if (trimmedCommand && !commandHistory.includes(trimmedCommand)) {
      setCommandHistory(prev => [...prev, trimmedCommand]);
    }
    
    // Add input line
    const inputLine: TerminalLine = {
      id: Date.now().toString() + '-input',
      content: prompt + trimmedCommand,
      type: 'input',
      timestamp: new Date()
    };
    
    let outputLines: TerminalLine[] = [];
    
    if (trimmedCommand === 'clear') {
      setLines([]);
      return;
    }
    
    // Process command
    if (trimmedCommand in mockCommands) {
      const result = mockCommands[trimmedCommand as keyof typeof mockCommands]();
      if (result === 'CLEAR_SCREEN') {
        setLines([]);
        return;
      }
      if (result === 'SHOW_FILE_BROWSER') {
        setShowFileBrowser(true);
        outputLines = [{
          id: Date.now().toString() + '-output',
          content: 'Opening file browser...',
          type: 'output' as const,
          timestamp: new Date()
        }];
      } else {
        outputLines = result.split('\n').map((line, index) => ({
          id: Date.now().toString() + '-output-' + index,
          content: line,
          type: 'output' as const,
          timestamp: new Date()
        }));
      }
    } else if (trimmedCommand.startsWith('cd ')) {
      const path = trimmedCommand.substring(3).trim();
      if (path === '..') {
        const pathParts = currentPath.split('/');
        pathParts.pop();
        setCurrentPath(pathParts.join('/') || '/');
      } else if (path === '~' || path === '') {
        setCurrentPath('/home/user01');
      } else if (mockFileSystem.includes(path)) {
        setCurrentPath(`${currentPath}/${path}`);
      } else {
        outputLines = [{
          id: Date.now().toString() + '-error',
          content: `cd: ${path}: No such file or directory`,
          type: 'error',
          timestamp: new Date()
        }];
      }
    } else if (trimmedCommand === '') {
      // Empty command, just show prompt
    } else {
      outputLines = [{
        id: Date.now().toString() + '-error',
        content: `Command '${trimmedCommand}' not found`,
        type: 'error',
        timestamp: new Date()
      }];
    }
    
    setLines(prev => [...prev, inputLine, ...outputLines]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand(currentInput);
      setCurrentInput('');
      setHistoryIndex(-1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setCurrentInput(commandHistory[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= commandHistory.length) {
          setHistoryIndex(-1);
          setCurrentInput('');
        } else {
          setHistoryIndex(newIndex);
          setCurrentInput(commandHistory[newIndex]);
        }
      }
    }
  };

  return (
    <div className="h-full bg-gray-900 text-green-400 font-mono text-sm flex flex-col">
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-4 space-y-1">
          {lines.map((line) => (
            <div
              key={line.id}
              className={`${
                line.type === 'error' ? 'text-red-400' : 
                line.type === 'input' ? 'text-white' : 'text-green-400'
              }`}
            >
              {line.content}
            </div>
          ))}
          
          {/* Current input line */}
          <div className="flex items-center text-white">
            <span className="text-green-400">{prompt}</span>
            <input
              ref={inputRef}
              type="text"
              value={currentInput}
              onChange={(e) => setCurrentInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent border-none outline-none text-white"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="animate-pulse">█</span>
          </div>
          
          {/* Helpful commands hint */}
          {lines.length <= 4 && (
            <div className="mt-4 text-gray-500 text-xs">
              <div>Available commands: ls, pwd, whoami, date, ps, df, free, uptime, clear</div>
              <div>Navigation: cd [directory], cd .. (go back), cd ~ (go home)</div>
              <div>File operations are available in the file browser panel below</div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}