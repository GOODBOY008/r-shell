import React from "react";
import { useTranslation } from 'react-i18next';
import { Button } from "./ui/button";
import { ArrowRight, ArrowLeft } from "lucide-react";

interface TransferControlsProps {
  localSelectionCount: number;
  remoteSelectionCount: number;
  onUpload: () => void;
  onDownload: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

export function TransferControls({
  localSelectionCount,
  remoteSelectionCount,
  onUpload,
  onDownload,
  disabled = false,
  children,
}: TransferControlsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 w-10 shrink-0 bg-muted/20">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={t('transferControls.uploadSelected', { count: localSelectionCount })}
        disabled={disabled || localSelectionCount === 0}
        onClick={onUpload}
      >
        <ArrowRight className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={t('transferControls.downloadSelected', { count: remoteSelectionCount })}
        disabled={disabled || remoteSelectionCount === 0}
        onClick={onDownload}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      {children}
    </div>
  );
}
