import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, Plus, Trash2 } from 'lucide-react';
import type { SshIdentityOptions, SshJumpHost } from '@/lib/ssh-options';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { PasswordInput } from './ui/password-input';
import { KeyPathInput } from './key-path-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function SshIdentityEditor({
  value,
  onChange,
}: {
  value: SshIdentityOptions;
  onChange: (value: Partial<SshIdentityOptions>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t('openSsh.fields.identityFiles')}</Label>
        <Select
          value={
            value.identityFiles === undefined
              ? 'default'
              : value.identityFiles.length === 0
                ? 'none'
                : 'custom'
          }
          onValueChange={(mode) =>
            onChange({
              identityFiles: mode === 'default' ? undefined : mode === 'none' ? [] : [''],
            })
          }
        >
          <SelectTrigger aria-label={t('openSsh.fields.identityFiles')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t('openSsh.editor.defaultKeys')}</SelectItem>
            <SelectItem value="custom">{t('openSsh.editor.customKeys')}</SelectItem>
            <SelectItem value="none">{t('openSsh.editor.noKeys')}</SelectItem>
          </SelectContent>
        </Select>
        {!!value.identityFiles?.length && (
          <Textarea
            aria-label={t('openSsh.editor.keyPaths')}
            value={value.identityFiles.join('\n')}
            onChange={(e) => onChange({ identityFiles: e.target.value.split('\n') })}
            placeholder={t('openSsh.editor.keyPaths')}
          />
        )}
        <p className="text-xs text-muted-foreground">{t('openSsh.editor.keysHint')}</p>
      </div>
      <div className="space-y-2">
        <Label>{t('openSsh.fields.identityAgent')}</Label>
        <Input
          aria-label={t('openSsh.fields.identityAgent')}
          value={value.identityAgent ?? ''}
          placeholder={t('openSsh.editor.agentHint')}
          onChange={(e) => onChange({ identityAgent: e.target.value || undefined })}
        />
      </div>
      <label className="flex items-center justify-between gap-3">
        <span>{t('openSsh.fields.identitiesOnly')}</span>
        <Switch
          checked={value.identitiesOnly ?? false}
          onCheckedChange={(identitiesOnly) => onChange({ identitiesOnly })}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t('openSsh.editor.identitiesHint')}</p>
    </div>
  );
}

export function SshJumpHostsEditor({
  value,
  onChange,
}: {
  value: SshJumpHost[];
  onChange: (value: SshJumpHost[]) => void;
}) {
  const { t } = useTranslation();
  const update = (index: number, change: Partial<SshJumpHost>) =>
    onChange(value.map((h, i) => (i === index ? { ...h, ...change } : h)));
  const move = (index: number, delta: number) => {
    const next = [...value];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('openSsh.editor.chainHint')}</p>
      {value.map((hop, index) => (
        <div key={index} className="border rounded-md p-4 space-y-3">
          <div className="flex items-center gap-2">
            <h4 className="font-medium flex-1">{t('openSsh.editor.hop', { number: index + 1 })}</h4>
            <Button
              size="icon"
              variant="ghost"
              disabled={index === 0}
              aria-label={t('openSsh.editor.moveUp')}
              onClick={() => move(index, -1)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={index === value.length - 1}
              aria-label={t('openSsh.editor.moveDown')}
              onClick={() => move(index, 1)}
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('openSsh.editor.removeHop')}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div>
              <Label>{t('openSsh.fields.host')}</Label>
              <Input
                aria-label={t('openSsh.fields.host')}
                value={hop.host}
                onChange={(e) => update(index, { host: e.target.value })}
              />
            </div>
            <div>
              <Label>{t('openSsh.fields.port')}</Label>
              <Input
                aria-label={t('openSsh.fields.port')}
                type="number"
                min={1}
                max={65535}
                value={hop.port}
                onChange={(e) => update(index, { port: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <Label>{t('openSsh.fields.username')}</Label>
            <Input
              aria-label={t('openSsh.fields.username')}
              value={hop.username}
              onChange={(e) => update(index, { username: e.target.value })}
            />
          </div>
          <Select
            value={hop.authMethod}
            onValueChange={(authMethod) =>
              update(index, { authMethod: authMethod as SshJumpHost['authMethod'] })
            }
          >
            <SelectTrigger aria-label={t('openSsh.fields.authMethod')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('openSsh.editor.auto')}</SelectItem>
              <SelectItem value="password">{t('connectionDialog.authMethod.password')}</SelectItem>
              <SelectItem value="publickey">
                {t('connectionDialog.authMethod.publicKey')}
              </SelectItem>
            </SelectContent>
          </Select>
          {hop.authMethod === 'auto' && (
            <SshIdentityEditor value={hop} onChange={(change) => update(index, change)} />
          )}
          {hop.authMethod === 'password' && (
            <PasswordInput
              aria-label={t('connectionDialog.label.password')}
              placeholder={t('connectionDialog.placeholder.password')}
              value={hop.password ?? ''}
              onChange={(e) => update(index, { password: e.target.value })}
            />
          )}
          {hop.authMethod === 'publickey' && (
            <>
              <KeyPathInput
                id={`hop-key-${index}`}
                value={hop.privateKeyPath ?? ''}
                onChange={(privateKeyPath) => update(index, { privateKeyPath })}
              />
              <PasswordInput
                aria-label={t('connectionDialog.label.passphrase')}
                placeholder={t('connectionDialog.placeholder.passphrase')}
                value={hop.passphrase ?? ''}
                onChange={(e) => update(index, { passphrase: e.target.value })}
              />
            </>
          )}
          <div>
            <Label>{t('openSsh.fields.connectTimeout')}</Label>
            <Input
              type="number"
              min={1}
              aria-label={t('openSsh.fields.connectTimeout')}
              placeholder={t('openSsh.editor.appDefault')}
              value={hop.connectTimeout ?? ''}
              onChange={(e) =>
                update(index, {
                  connectTimeout: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </div>
      ))}
      <Button
        variant="outline"
        disabled={value.length >= 8}
        onClick={() =>
          onChange([...value, { host: '', port: 22, username: '', authMethod: 'auto' }])
        }
      >
        <Plus className="size-4" />
        {t('openSsh.editor.addHop')}
      </Button>
    </div>
  );
}
