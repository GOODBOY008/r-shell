import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Monitor, Server, HardDrive } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface SessionNode {
  id: string;
  name: string;
  type: 'folder' | 'session';
  protocol?: string;
  host?: string;
  username?: string;
  children?: SessionNode[];
  isExpanded?: boolean;
}

interface SessionManagerProps {
  onSessionSelect: (session: SessionNode) => void;
  selectedSessionId: string | null;
}

const mockSessions: SessionNode[] = [
  {
    id: 'all',
    name: 'All Sessions',
    type: 'folder',
    isExpanded: true,
    children: [
      {
        id: 'personal',
        name: 'Personal',
        type: 'folder',
        isExpanded: true,
        children: [
          { id: 'local', name: 'Local', type: 'session', protocol: 'SSH', host: 'localhost', username: 'user' },
          { id: 'cmd', name: 'CMD', type: 'session', protocol: 'CMD' },
          { id: 'linux-shell', name: 'Linux Shell', type: 'session', protocol: 'SSH', host: 'linux-server', username: 'root' },
          { id: 'local-shell', name: 'Local Shell', type: 'session', protocol: 'Shell' },
          { id: 'powershell', name: 'PowerShell', type: 'session', protocol: 'PowerShell' },
          { id: 'wsl', name: 'WSL', type: 'session', protocol: 'WSL' }
        ]
      },
      {
        id: 'work',
        name: 'Work',
        type: 'folder',
        isExpanded: true,
        children: [
          { id: 'site-a', name: 'Site A', type: 'session', protocol: 'SSH', host: 'server-a.company.com', username: 'admin' },
          { id: 'rsca-01', name: 'rscA-01', type: 'session', protocol: 'SSH', host: '192.168.1.101', username: 'user01' },
          { id: 'rsca-02', name: 'rscA-02', type: 'session', protocol: 'SSH', host: '192.168.1.102', username: 'user01' },
          { id: 'rsca-03', name: 'rscA-03', type: 'session', protocol: 'SSH', host: '192.168.1.103', username: 'user01' },
          { id: 'site-b', name: 'Site B', type: 'session', protocol: 'SSH', host: 'server-b.company.com', username: 'admin' },
          { id: 'rscb-01', name: 'rscB-01', type: 'session', protocol: 'SSH', host: '192.168.2.101', username: 'user01' }
        ]
      }
    ]
  }
];

export function SessionManager({ onSessionSelect, selectedSessionId }: SessionManagerProps) {
  const [sessions, setSessions] = useState<SessionNode[]>(mockSessions);
  
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
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected': return 'bg-green-500';
      case 'connecting': return 'bg-yellow-500';
      case 'disconnected': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

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
    
    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-2 px-2 py-1 hover:bg-accent cursor-pointer ${
            isSelected ? 'bg-accent' : ''
          }`}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => {
            if (node.type === 'folder') {
              toggleExpanded(node.id);
            } else {
              onSessionSelect(node);
            }
          }}
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
          
          {getIcon(node)}
          <span className="text-sm">{node.name}</span>
        </div>
        
        {node.type === 'folder' && node.isExpanded && node.children && (
          <div>
            {node.children.map(child => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-card border-r border-border h-full flex flex-col">
      {/* Session Browser */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="p-3 border-b border-border">
          <h3 className="font-medium">Session Manager</h3>
        </div>
        <div className="flex-1 overflow-auto">
          {sessions.map(session => renderNode(session))}
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
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-xs">Connected</span>
                  </div>
                </div>
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
                        {selectedSession.protocol === 'SSH' ? 22 : 23}
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
  );
}