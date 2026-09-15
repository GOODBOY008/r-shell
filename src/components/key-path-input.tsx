import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { pickPrivateKeyFile } from '@/lib/key-file-picker';

interface KeyPathInputProps {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

/**
 * Text field for a private-key path with a button that opens the OS file
 * picker. Typing stays possible; the picker just fills the field.
 */
export function KeyPathInput({ id, value, placeholder, onChange }: KeyPathInputProps) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);

  const browse = async () => {
    setPicking(true);
    try {
      const picked = await pickPrivateKeyFile(value, t('connectionDialog.button.browseKeyTitle'));
      if (picked) onChange(picked);
    } catch (error) {
      console.error('Key file picker failed:', error);
      toast.error(t('connectionDialog.toast.keyPickerFailed'), { description: String(error) });
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Input
        id={id}
        className="flex-1"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={t('connectionDialog.button.browseKey')}
        title={t('connectionDialog.button.browseKey')}
        disabled={picking}
        onClick={browse}
      >
        <FolderOpen className="h-4 w-4" />
      </Button>
    </div>
  );
}
