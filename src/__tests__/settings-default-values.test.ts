import { beforeEach, describe, expect, it } from 'vitest';
import { defaultAppearanceSettings, loadAppearanceSettings, saveAppearanceSettings } from '../lib/terminal-config';
import { DEFAULT_EDITOR_CONFIG, loadEditorConfig, saveEditorConfig } from '../lib/editor-config';
import { AUTO, getLanguagePreference } from '../lib/i18n';

beforeEach(() => localStorage.clear());

describe.each([
  ['terminalAppearance', defaultAppearanceSettings, loadAppearanceSettings],
  ['rshell-editor-config', DEFAULT_EDITOR_CONFIG, loadEditorConfig],
] as const)('%s defaults', (key, defaults, load) => {
  it.each([null, [], 'invalid', 42].map(value => [value]))('ignores a non-object settings blob: %j', value => {
    localStorage.setItem(key, JSON.stringify(value));
    expect(load()).toEqual(defaults);
  });

  it.each([null, '', '   ', [], {}].map(value => [value]))('repairs invalid values in every field: %j', value => {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.keys(defaults).map(name => [name, value]))));
    expect(load()).toEqual(defaults);
  });

  it('repairs invalid numeric values, enums, and boolean types', () => {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(defaults).map(([name, value]) => [
      name, typeof value === 'number' ? -99999 : typeof value === 'boolean' ? 'false' : null,
    ]))));
    expect(load()).toEqual(defaults);
  });
});

it('rejects unsupported choices and out-of-range terminal/editor numbers', () => {
  localStorage.setItem('terminalAppearance', JSON.stringify({
    theme: 'unknown', cursorStyle: 'circle', backgroundImagePosition: 'stretch',
    fontSize: 3.5, lineHeight: 3, letterSpacing: -4, opacity: 0, backgroundImageOpacity: 0, backgroundImageBlur: -1,
  }));
  localStorage.setItem('rshell-editor-config', JSON.stringify({ theme: 'unknown', fontSize: 4, tabSize: 3 }));
  expect(loadAppearanceSettings()).toEqual(defaultAppearanceSettings);
  expect(loadEditorConfig()).toEqual(DEFAULT_EDITOR_CONFIG);
});

it('preserves deliberate false values, zero values, optional blanks, and custom fonts', () => {
  const terminal = {
    ...defaultAppearanceSettings, fontFamily: '"My Custom Mono", monospace', cursorBlink: false,
    allowTransparency: false, letterSpacing: 0, backgroundImage: '', backgroundImageBlur: 0,
  };
  const editor = {
    ...DEFAULT_EDITOR_CONFIG, fontFamily: '"My Custom Mono", monospace', lineNumbers: false,
    wordWrap: false, highlightActiveLine: false, foldGutter: false, bracketMatching: false, matchBrackets: false,
  };
  saveAppearanceSettings(terminal);
  saveEditorConfig(editor);
  expect(loadAppearanceSettings()).toEqual(terminal);
  expect(loadEditorConfig()).toEqual(editor);
});

it('canonicalizes equivalent CSS font stacks without dropping fallbacks', () => {
  localStorage.setItem('terminalAppearance', JSON.stringify({ fontFamily: "Menlo, Monaco, 'Courier New', monospace" }));
  localStorage.setItem('rshell-editor-config', JSON.stringify({ fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace' }));
  expect(loadAppearanceSettings().fontFamily).toBe(defaultAppearanceSettings.fontFamily);
  expect(loadEditorConfig().fontFamily).toBe(DEFAULT_EDITOR_CONFIG.fontFamily);
});

it('normalizes imported appearance/editor settings before persisting them', () => {
  saveAppearanceSettings({ ...defaultAppearanceSettings, fontFamily: '', theme: '', cursorStyle: null! });
  saveEditorConfig({ ...DEFAULT_EDITOR_CONFIG, fontFamily: '', theme: '', tabSize: 3 });
  expect(JSON.parse(localStorage.getItem('terminalAppearance')!)).toEqual(defaultAppearanceSettings);
  expect(JSON.parse(localStorage.getItem('rshell-editor-config')!)).toEqual(DEFAULT_EDITOR_CONFIG);
});

it.each([29, 30, 31, 32])('preserves the editor toolbar font size %ipx on load and save', fontSize => {
  localStorage.setItem('rshell-editor-config', JSON.stringify({ ...DEFAULT_EDITOR_CONFIG, fontSize }));
  expect(loadEditorConfig().fontSize).toBe(fontSize);
  saveEditorConfig({ ...DEFAULT_EDITOR_CONFIG, fontSize });
  expect(JSON.parse(localStorage.getItem('rshell-editor-config')!).fontSize).toBe(fontSize);
});

it.each(['', '   ', 'unknown'])('falls back to the system language for an invalid preference: %j', value => {
  localStorage.setItem('r-shell-language', value);
  expect(getLanguagePreference()).toBe(AUTO);
});

it.each([
  ['zh-Hans', 'zh-CN'],
  ['en-US', 'en'],
  ['pl-PL', 'pl'],
  ['pt', 'pt-BR'],
  [' PT_br ', 'pt-BR'],
])('normalizes the supported locale alias %s', (value, expected) => {
  localStorage.setItem('r-shell-language', value);
  expect(getLanguagePreference()).toBe(expected);
});
