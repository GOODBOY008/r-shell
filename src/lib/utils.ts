import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ThemeMode = 'dark' | 'light' | 'auto';

export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

export function getSavedTheme(): ThemeMode {
  try {
    const settings = localStorage.getItem('sshClientSettings');
    if (settings) {
      const parsed = JSON.parse(settings);
      if (parsed.theme === 'dark' || parsed.theme === 'light' || parsed.theme === 'auto') {
        return parsed.theme;
      }
    }
  } catch {
    // Ignore invalid JSON in localStorage
  }
  return 'dark';
}

export function initializeTheme(): void {
  const theme = getSavedTheme();
  applyTheme(theme);
  
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const currentTheme = getSavedTheme();
    if (currentTheme === 'auto') {
      document.documentElement.classList.toggle('dark', e.matches);
    }
  });
}

export function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function getAppTheme(): 'dark' | 'light' {
  return isDarkMode() ? 'dark' : 'light';
}
