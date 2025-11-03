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
