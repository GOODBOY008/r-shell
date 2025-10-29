import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface ConnectionDetailsProps {
  session?: {
    id: string;
    name: string;
    protocol: string;
    host?: string;
    username?: string;
    port?: number;
    status: 'connected' | 'connecting' | 'disconnected';
  };
}

export function ConnectionDetails({ session }: ConnectionDetailsProps) {
  if (!session) {
    return (
      <Card className="w-80">
        <CardHeader>
          <CardTitle className="text-sm">Connection Details</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No session selected</p>
        </CardContent>
      </Card>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected': return 'bg-green-500';
      case 'connecting': return 'bg-yellow-500';
      case 'disconnected': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <Card className="w-80">
      <CardHeader>
        <CardTitle className="text-sm">Connection Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Name</span>
            <span className="text-sm">{session.name}</span>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Type</span>
            <Badge variant="outline">{session.protocol}</Badge>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Status</span>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${getStatusColor(session.status)}`} />
              <span className="text-sm capitalize">{session.status}</span>
            </div>
          </div>
        </div>
        
        {session.host && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Host</span>
                <span className="text-sm">{session.host}</span>
              </div>
              
              {session.username && (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Username</span>
                  <span className="text-sm">{session.username}</span>
                </div>
              )}
              
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Port</span>
                <span className="text-sm">{session.port || (session.protocol === 'SSH' ? 22 : 23)}</span>
              </div>
            </div>
          </>
        )}
        
        <Separator />
        
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Sub items</span>
            <span className="text-sm">2</span>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Protocol</span>
            <span className="text-sm">{session.protocol}</span>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Description</span>
            <span className="text-sm text-muted-foreground">-</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}