import { useEffect, useState } from 'react';
import { Toaster as Sonner, ToasterProps } from 'sonner';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';
import { isDarkMode } from '@/lib/utils';

/**
 * Resolve the toast theme from the app's own theme switch, not the OS.
 *
 * There is no next-themes provider mounted — `applyTheme` (lib/utils) toggles
 * a `dark` class on <html> — so deriving sonner's theme from
 * prefers-color-scheme would render dark toasts inside a light app whenever
 * the user forces a theme against the OS setting. Observing the class keeps
 * the Toaster in sync with live theme changes too.
 */
function useAppTheme(): ToasterProps['theme'] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (isDarkMode() ? 'dark' : 'light'));

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(isDarkMode() ? 'dark' : 'light'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

const toastIcon = (Icon: typeof Check) => <Icon size={16} strokeWidth={2} />;

/**
 * App-wide toast surface, styled after VS Code notifications (see the
 * `.toaster` skin in index.css — sonner injects its stylesheet unlayered,
 * which outranks Tailwind utilities, so the visual customization lives there
 * and in the CSS variables below rather than in toastOptions.classNames).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: toastIcon(Check),
        error: toastIcon(X),
        warning: toastIcon(AlertTriangle),
        info: toastIcon(Info),
        loading: <Loader2 size={16} strokeWidth={2} className="animate-spin" />,
      }}
      style={
        {
          // Sonner's own rules consume these — the token-to-sonner bridge.
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': '6px',
          // VS Code's default notification width.
          '--width': '420px',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
