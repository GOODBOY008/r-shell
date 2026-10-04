import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  Settings,
  Terminal as TerminalIcon,
  Shield,
  Palette,
  Keyboard,
  Network,
  Monitor,
  Code2,
  Search,
  X,
} from 'lucide-react';
import {
  TerminalAppearanceSettings,
  defaultAppearanceSettings,
  loadAppearanceSettings,
  saveAppearanceSettings,
} from '../lib/terminal-config';
import {
  APP_SETTINGS_CHANGED_EVENT,
  APP_SETTINGS_STORAGE_KEY,
  stripRemovedSettingsKeys,
} from '../lib/keyboard-shortcuts';
import {
  findConflicts,
  loadShortcutOverrides,
  type ShortcutCommandId,
  type ShortcutOverrides,
} from '../lib/shortcut-registry';
import { applyTheme, type ThemeMode } from '../lib/utils';
import {
  loadEditorConfig,
  saveEditorConfig,
  dispatchEditorConfigChanged,
  DEFAULT_EDITOR_CONFIG,
  type EditorConfig,
} from '@/lib/editor-config';
import { normalizeUpdateProxy } from '@/lib/update-proxy';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import {
  DEFAULT_UPDATE_CONTEXT,
  isCurrentChannelEligible,
  type UpdateContext,
} from '@/lib/update-channel';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import {
  DEFAULT_SETTINGS,
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
  type SettingsState,
} from './settings/shared';
import { TerminalSection } from './settings/terminal-section';
import { EditorSection } from './settings/editor-section';
import { ConnectionSection } from './settings/connection-section';
import { SecuritySection } from './settings/security-section';
import { InterfaceSection } from './settings/interface-section';
import { KeyboardSection } from './settings/keyboard-section';
import { AdvancedSection } from './settings/advanced-section';
import { getLanguagePreference, changeLanguage } from '@/lib/i18n';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckForUpdates?: () => void;
}

const SECTION_ICONS: Record<SettingsSectionId, typeof TerminalIcon> = {
  terminal: TerminalIcon,
  editor: Code2,
  connection: Network,
  security: Shield,
  interface: Palette,
  keyboard: Keyboard,
  advanced: Monitor,
};

/**
 * Settings dialog (ZCode/VS Code style): a left navigation rail picks one of
 * the seven section panes, a global search in the header stacks every section
 * and filters rows by label/description/English keywords, and the classic
 * Save / Reset / Cancel footer stays — nothing auto-saves. All state lives in
 * this shell; the section components under `./settings/` are controlled
 * views. Keyboard bindings are edited as sparse overrides (see
 * `shortcut-registry`) and Save is blocked while any conflict exists, since
 * the first-match-wins engine would silently shadow a command otherwise.
 */
export function SettingsModal({ open, onOpenChange, onCheckForUpdates }: SettingsModalProps) {
  const { t } = useTranslation();
  // Mirrors formatKeyboardShortcut's platform check: labels must show the
  // keys this machine actually uses (⌘N vs Ctrl+N, ⌃Tab vs Ctrl+Tab).
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  const [languagePref, setLanguagePref] = useState<string>(() => getLanguagePreference());
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearanceSettings>(defaultAppearanceSettings);
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(DEFAULT_EDITOR_CONFIG);
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [shortcutOverrides, setShortcutOverrides] = useState<ShortcutOverrides>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('terminal');

  // True once the user has manually changed the autostart toggle (or reset
  // settings) while the modal is open — the OS state query must not clobber it.
  const autostartTouchedRef = useRef(false);

  // Backend facts for the update group: Homebrew detection hides the channel/
  // auto-check/proxy controls (brew owns updates), platform/arch/macOS major
  // gate the `current` channel. Null in browser dev mode → gating stays off.
  const [updateContext, setUpdateContext] = useState<UpdateContext | null>(null);

  const currentChannelEligible = isCurrentChannelEligible(updateContext ?? DEFAULT_UPDATE_CONTEXT);

  // Running app version for the update group; null in browser dev mode → dash.
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Live conflict analysis of the edited bindings — blocks Save while any
  // exist (duplicate / reserved / macOS menu-owned chords).
  const hasShortcutConflicts = useMemo(
    () => findConflicts(shortcutOverrides, isMac).length > 0,
    [shortcutOverrides, isMac],
  );

  const searching = searchQuery.trim().length > 0;

  // Load settings when modal opens
  useEffect(() => {
    if (open) {
      const appearance = loadAppearanceSettings();
      setTerminalAppearance(appearance);
      setEditorConfig(loadEditorConfig());
      setShortcutOverrides(loadShortcutOverrides());
      setSearchQuery('');

      // Load other settings from localStorage
      try {
        const savedSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
        if (savedSettings) {
          const parsed = JSON.parse(savedSettings) as Record<string, unknown>;
          // Drop fields whose controls no longer exist so saving this session
          // writes a clean blob instead of resurrecting the removed keys.
          stripRemovedSettingsKeys(parsed);
          setSettings(prev => ({ ...prev, ...parsed }));
        }
      } catch {
        // Ignore parsing errors
      }

      // Load the real autostart state from the OS so the toggle reflects
      // the actual launch-at-login configuration, not a cached value.
      // Skip in browser dev mode where the Tauri backend is absent.
      if (isTauri()) {
        invoke<UpdateContext>('get_update_context')
          .then(setUpdateContext)
          .catch(() => setUpdateContext(null));

        // Current app version shown in the update group (each open re-reads)
        getVersion()
          .then(setAppVersion)
          .catch(() => setAppVersion(null));

        // Each open re-reads the OS state; discard any prior touch flag
        autostartTouchedRef.current = false;
        isAutostartEnabled()
          .then((enabled) => {
            // A manual toggle made while the query was in flight wins
            if (!autostartTouchedRef.current) {
              setSettings(prev => ({ ...prev, autostart: enabled }));
            }
          })
          .catch(() => {
            // Plugin unavailable — keep stored/default value
          });
      }
    }
  }, [open]);

  const updateTerminalAppearance = <K extends keyof TerminalAppearanceSettings>(
    key: K,
    value: TerminalAppearanceSettings[K]
  ) => {
    setTerminalAppearance(prev => ({ ...prev, [key]: value }));
  };

  const updateSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  /** Edit one sparse shortcut override; `null` resets the command to default. */
  const handleOverrideChange = (id: ShortcutCommandId, chord: string | null) => {
    setShortcutOverrides(prev => {
      if (chord === null) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: chord };
    });
  };

  const reloadImportedStores = () => {
    setTerminalAppearance(loadAppearanceSettings());
    setEditorConfig(loadEditorConfig());
    setShortcutOverrides(loadShortcutOverrides());
  };

  const handleSave = (): boolean => {
    // Conflicts are also surfaced by the disabled Save button; keep the
    // guard here so programmatic callers (Check Now) can't bypass it.
    if (hasShortcutConflicts) {
      return false;
    }

    let updateProxy: string | undefined;
    try {
      updateProxy = normalizeUpdateProxy(settings.updateProxy);
    } catch {
      toast.error(t('settings.advanced.updateProxyInvalid'));
      return false;
    }

    // Apply the launch-at-login preference to the OS (best effort — revert
    // the toggle and warn if the plugin call fails so the UI stays truthful).
    // Skipped in browser dev mode where the Tauri backend is absent.
    void (async () => {
      if (!isTauri()) return;
      // Only touch the OS when the user moved the toggle (or Reset) this
      // session. An untouched toggle must not fire plugin calls on every
      // save: on Windows, auto-launch's disable() deletes the HKCU Run value
      // and surfaces ERROR_FILE_NOT_FOUND ("os error 2") when it doesn't
      // exist — an error toast on every single save for anyone who never
      // enabled autostart (#196).
      if (!autostartTouchedRef.current) return;
      try {
        const enabled = await isAutostartEnabled().catch(() => undefined);
        if (settings.autostart) {
          // Idempotent in both directions: skip when the OS already matches
          // the desired state.
          if (enabled !== true) {
            await enableAutostart();
          }
        } else if (enabled !== false) {
          await disableAutostart();
        }
        autostartTouchedRef.current = false;
      } catch (error) {
        const actual = await isAutostartEnabled().catch(() => undefined);
        const corrected = actual ?? !settings.autostart;
        setSettings(prev => ({ ...prev, autostart: corrected }));
        // Keep the persisted config truthful when the OS update failed
        try {
          const saved = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
          stripRemovedSettingsKeys(saved);
          localStorage.setItem(
            APP_SETTINGS_STORAGE_KEY,
            JSON.stringify({ ...saved, autostart: corrected }),
          );
          window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
        } catch {
          // Ignore storage errors — the toggle and toast already reflect reality
        }
        toast.error(t('settings.interface.autostartFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    // Save terminal appearance settings
    saveAppearanceSettings(terminalAppearance);

    // Save editor config and notify live editors
    saveEditorConfig(editorConfig);
    dispatchEditorConfigChanged();

    // Apply the theme immediately
    applyTheme(settings.theme);

    // Save other settings to localStorage. Shortcut bindings persist as the
    // sparse overrides map — commands at their default are absent.
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...settings,
      updateProxy: updateProxy ?? '',
      // A stored `current` preference that no longer qualifies (e.g. the app
      // moved to a Homebrew install or an older macOS) falls back to stable.
      updateChannel: settings.updateChannel === 'current' && currentChannelEligible ? 'current' : 'stable',
      shortcutBindings: shortcutOverrides,
    }));
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    onOpenChange(false);
    return true;
  };

  const handleReset = () => {
    if (confirm(t('settings.resetConfirm'))) {
      // Reset terminal appearance, editor config, and shortcut overrides
      setTerminalAppearance(defaultAppearanceSettings);
      setEditorConfig(DEFAULT_EDITOR_CONFIG);
      setShortcutOverrides({});
      setSettings(DEFAULT_SETTINGS);

      // Resetting is a deliberate change — don't let a pending OS query undo it
      if (settings.autostart) {
        autostartTouchedRef.current = true;
      }

      // Apply default theme
      applyTheme(DEFAULT_SETTINGS.theme);
    }
  };

  const renderSection = (section: SettingsSectionId) => {
    switch (section) {
      case 'terminal':
        return (
          <TerminalSection
            appearance={terminalAppearance}
            onChange={updateTerminalAppearance}
            query={searchQuery}
          />
        );
      case 'editor':
        return (
          <EditorSection
            config={editorConfig}
            onChange={setEditorConfig}
            query={searchQuery}
          />
        );
      case 'connection':
        return (
          <ConnectionSection
            defaultProtocol={settings.defaultProtocol}
            connectionTimeout={settings.connectionTimeout}
            keepAliveInterval={settings.keepAliveInterval}
            autoReconnect={settings.autoReconnect}
            restoreSessionsOnStartup={settings.restoreSessionsOnStartup}
            onChange={(key, value) => updateSetting(key, value as SettingsState[typeof key])}
            query={searchQuery}
          />
        );
      case 'security':
        return (
          <SecuritySection
            hostKeyVerification={settings.hostKeyVerification}
            allowPasswordSaving={settings.allowPasswordSaving}
            onChange={updateSetting}
            query={searchQuery}
          />
        );
      case 'interface':
        return (
          <InterfaceSection
            theme={settings.theme}
            languagePref={languagePref}
            autostart={settings.autostart}
            onThemeChange={(value) => {
              updateSetting('theme', value as ThemeMode);
              // Apply theme immediately for instant preview
              applyTheme(value as ThemeMode);
            }}
            onLanguageChange={(value) => {
              setLanguagePref(value);
              void changeLanguage(value);
            }}
            onAutostartChange={(checked) => {
              autostartTouchedRef.current = true;
              updateSetting('autostart', checked);
            }}
            query={searchQuery}
          />
        );
      case 'keyboard':
        return (
          <KeyboardSection
            overrides={shortcutOverrides}
            onOverrideChange={handleOverrideChange}
            query={searchQuery}
          />
        );
      case 'advanced':
        return (
          <AdvancedSection
            appVersion={appVersion}
            updateContext={updateContext}
            checkUpdates={settings.checkUpdates}
            updateChannel={settings.updateChannel}
            updateProxy={settings.updateProxy}
            onChange={(key, value) => updateSetting(key, value as SettingsState[typeof key])}
            onSaveAndCheckForUpdates={() => {
              if (handleSave()) {
                onCheckForUpdates?.();
              }
            }}
            onConfigImported={reloadImportedStores}
            query={searchQuery}
          />
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center justify-between gap-4">
            <DialogTitle className="flex items-center gap-2">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Settings className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div>{t('settings.title')}</div>
                <DialogDescription className="mt-1">
                  {t('settings.description')}
                </DialogDescription>
              </div>
            </DialogTitle>
            {/* Global search: filters rows across every section; a non-empty
                query stacks all sections and hides the navigation rail. */}
            <div className="relative w-72 shrink-0 self-center">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('settings.search.placeholder')}
                aria-label={t('settings.search.placeholder')}
                className="pl-8 pr-8"
              />
              {searching && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label={t('common.cancel')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 flex overflow-hidden">
          {!searching && (
            <nav
              aria-label={t('settings.title')}
              className="w-52 shrink-0 border-r border-border overflow-y-auto py-3 px-2 space-y-1"
            >
              {SETTINGS_SECTION_IDS.map(section => {
                const Icon = SECTION_ICONS[section];
                const isActive = section === activeSection;
                return (
                  <button
                    key={section}
                    type="button"
                    onClick={() => setActiveSection(section)}
                    aria-current={isActive ? 'true' : undefined}
                    className={
                      'w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors ' +
                      (isActive
                        ? 'bg-primary/15 text-primary font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60')
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{t(`settings.tab.${section}`)}</span>
                  </button>
                );
              })}
            </nav>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {searching
              ? SETTINGS_SECTION_IDS.map(section => (
                  <div key={section}>{renderSection(section)}</div>
                ))
              : renderSection(activeSection)}
            {searching && (
              <p className="text-sm text-muted-foreground text-center pt-2">
                {t('settings.search.showingResults', { query: searchQuery.trim() })}
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-between px-6 py-4 border-t border-border bg-muted/30">
          <Button variant="ghost" onClick={handleReset}>
            {t('settings.button.resetToDefaults')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={hasShortcutConflicts}
              title={hasShortcutConflicts ? t('settings.shortcuts.conflictSaveBlocked') : undefined}
              className="min-w-[120px]"
            >
              {t('settings.button.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
