import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Fallback UI to render when an error is caught. If not provided, a default error card is shown. */
  fallback?: React.ReactNode;
  /** Optional label shown in the default error card (e.g. "System Monitor"). */
  label?: string;
  /** Called when the user clicks "Retry". If not provided, the boundary resets itself. */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Generic React Error Boundary.
 *
 * Catches rendering errors in its subtree and displays a recoverable fallback
 * instead of crashing the entire application with a white screen.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ` — ${this.props.label}` : ''}]`, error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center gap-3 p-4 text-center h-full min-h-[120px]">
          <AlertTriangle className="w-8 h-8 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {this.props.label ? `${this.props.label} encountered an error` : 'Something went wrong'}
            </p>
            <p className="text-xs text-muted-foreground max-w-[300px] break-words">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={this.handleReset} className="gap-1.5">
            <RefreshCw className="w-3 h-3" />
            Retry
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
