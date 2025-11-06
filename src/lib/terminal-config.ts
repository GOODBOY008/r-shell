// Terminal configuration and utilities
import { ITerminalOptions, ITheme } from '@xterm/xterm';

export interface TerminalConfig {
  rendererType: 'webgl' | 'canvas' | 'dom';
  enableFlowControl: boolean;
  enableUnicode: boolean;
  enableSixel: boolean;
  flowControl: {
    limit: number;
    highWater: number;
    lowWater: number;
  };
}

export interface TerminalAppearanceSettings {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  theme: string;
  scrollback: number;
  allowTransparency: boolean;
  opacity: number;
}

export const defaultTerminalTheme: ITheme = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#aeafad',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

// Popular terminal theme presets
export const terminalThemes: Record<string, ITheme> = {
  'vs-code-dark': defaultTerminalTheme,
  
  'monokai': {
    foreground: '#f8f8f2',
    background: '#272822',
    cursor: '#f8f8f0',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  
  'solarized-dark': {
    foreground: '#839496',
    background: '#002b36',
    cursor: '#839496',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  
  'solarized-light': {
    foreground: '#657b83',
    background: '#fdf6e3',
    cursor: '#657b83',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  
  'dracula': {
    foreground: '#f8f8f2',
    background: '#282a36',
    cursor: '#f8f8f2',
    black: '#000000',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#bfbfbf',
    brightBlack: '#4d4d4d',
    brightRed: '#ff6e67',
    brightGreen: '#5af78e',
    brightYellow: '#f4f99d',
    brightBlue: '#caa9fa',
    brightMagenta: '#ff92d0',
    brightCyan: '#9aedfe',
    brightWhite: '#e6e6e6',
  },
  
  'one-dark': {
    foreground: '#abb2bf',
    background: '#282c34',
    cursor: '#528bff',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  
  'nord': {
    foreground: '#d8dee9',
    background: '#2e3440',
    cursor: '#d8dee9',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  
  'gruvbox-dark': {
    foreground: '#ebdbb2',
    background: '#282828',
    cursor: '#ebdbb2',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  
  'tokyo-night': {
    foreground: '#a9b1d6',
    background: '#1a1b26',
    cursor: '#c0caf5',
    black: '#32344a',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#ad8ee6',
    cyan: '#449dab',
    white: '#787c99',
    brightBlack: '#444b6a',
    brightRed: '#ff7a93',
    brightGreen: '#b9f27c',
    brightYellow: '#ff9e64',
    brightBlue: '#7da6ff',
    brightMagenta: '#bb9af7',
    brightCyan: '#0db9d7',
    brightWhite: '#acb0d0',
  },
  
  'matrix': {
    foreground: '#00ff00',
    background: '#000000',
    cursor: '#00ff00',
    black: '#000000',
    red: '#008800',
    green: '#00ff00',
    yellow: '#88ff00',
    blue: '#00ff88',
    magenta: '#00ff00',
    cyan: '#00ffff',
    white: '#00ff00',
    brightBlack: '#008800',
    brightRed: '#00aa00',
    brightGreen: '#00ff00',
    brightYellow: '#88ff00',
    brightBlue: '#00ff88',
    brightMagenta: '#00ff00',
    brightCyan: '#00ffff',
    brightWhite: '#88ff88',
  },
};

export const defaultAppearanceSettings: TerminalAppearanceSettings = {
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'block',
  cursorBlink: true,
  theme: 'vs-code-dark',
  scrollback: 10000,
  allowTransparency: false,
  opacity: 100,
};

export const defaultTerminalOptions: ITerminalOptions = {
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  theme: defaultTerminalTheme,
  allowProposedApi: true,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 8,
  allowTransparency: false,
  smoothScrollDuration: 0,
  fastScrollModifier: 'shift',
  fastScrollSensitivity: 5,
  scrollSensitivity: 1,
};

export function getTerminalOptions(appearance: TerminalAppearanceSettings): ITerminalOptions {
  const theme = terminalThemes[appearance.theme] || defaultTerminalTheme;
  
  return {
    ...defaultTerminalOptions,
    fontSize: appearance.fontSize,
    fontFamily: appearance.fontFamily,
    lineHeight: appearance.lineHeight,
    letterSpacing: appearance.letterSpacing,
    cursorStyle: appearance.cursorStyle,
    cursorBlink: appearance.cursorBlink,
    scrollback: appearance.scrollback,
    allowTransparency: appearance.allowTransparency,
    theme: appearance.allowTransparency ? {
      ...theme,
      background: undefined, // Allow transparency
    } : theme,
  };
}

export function loadAppearanceSettings(): TerminalAppearanceSettings {
  try {
    const saved = localStorage.getItem('terminalAppearance');
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaultAppearanceSettings, ...parsed };
    }
  } catch (e) {
    console.error('Failed to load terminal appearance settings:', e);
  }
  return defaultAppearanceSettings;
}

export function saveAppearanceSettings(settings: TerminalAppearanceSettings): void {
  try {
    localStorage.setItem('terminalAppearance', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save terminal appearance settings:', e);
  }
}

export const defaultConfig: TerminalConfig = {
  rendererType: 'webgl',
  enableFlowControl: true,
  enableUnicode: true,
  enableSixel: false,
  flowControl: {
    limit: 200000,
    highWater: 10,
    lowWater: 4,
  },
};

export function parseAnsiCodes(text: string): string {
  // Basic ANSI code handling
  return text;
}

export function measureText(text: string, fontSize: number, fontFamily: string): number {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return text.length * fontSize * 0.6;
  
  context.font = `${fontSize}px ${fontFamily}`;
  return context.measureText(text).width;
}

export function getOptimalFontSize(containerWidth: number, cols: number): number {
  const charWidth = containerWidth / cols;
  // Monospace fonts typically have width = fontSize * 0.6
  return Math.floor(charWidth / 0.6);
}
