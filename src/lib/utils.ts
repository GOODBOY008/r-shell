import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ThemeMode = 'dark' | 'light' | 'auto';

/**
 * Apply theme to the document
 */
export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  
  if (theme === 'auto') {
    // Use system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

/**
 * Get saved theme from localStorage
 */
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
    // Ignore parsing errors
  }
  return 'dark'; // Default theme
}

/**
 * Initialize theme on app startup
 */
export function initializeTheme(): void {
  const theme = getSavedTheme();
  applyTheme(theme);
  
  // Listen for system theme changes when in 'auto' mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const currentTheme = getSavedTheme();
    if (currentTheme === 'auto') {
      document.documentElement.classList.toggle('dark', e.matches);
    }
  });
}
