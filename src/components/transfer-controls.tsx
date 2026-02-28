import React from "react";
import { Button } from "./ui/button";
import { ArrowRight, ArrowLeft } from "lucide-react";

interface TransferControlsProps {
  localSelectionCount: number;
  remoteSelectionCount: number;
  onUpload: () => void;
  onDownload: () => void;
  disabled?: boolean;
}

export function TransferControls({
  localSelectionCount,
  remoteSelectionCount,
  onUpload,
  onDownload,
  disabled = false,
}: TransferControlsProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 w-10 shrink-0 bg-muted/20">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={`Upload ${localSelectionCount} file(s) to remote`}
        disabled={disabled || localSelectionCount === 0}
        onClick={onUpload}
      >
        <ArrowRight className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={`Download ${remoteSelectionCount} file(s) to local`}
        disabled={disabled || remoteSelectionCount === 0}
        onClick={onDownload}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
    </div>
  );
}
