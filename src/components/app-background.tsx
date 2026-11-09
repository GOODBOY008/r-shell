import type { TerminalAppearanceSettings } from '@/lib/terminal-config';

interface AppBackgroundProps {
  appearance: TerminalAppearanceSettings;
}

/**
 * One continuous background image behind the whole app shell.
 *
 * It used to be rendered inside every terminal pane, so each split showed its
 * own copy of the same image and re-cropped it on resize. It now spans the
 * window once; the shell marks itself with `data-wallpaper` so panels become
 * translucent and the image stays visible across the sidebars and file panels
 * as well.
 */
export function AppBackground({ appearance }: AppBackgroundProps) {
  if (!appearance.backgroundImage) return null;

  return (
    <div
      data-testid="app-background"
      aria-hidden="true"
      className="pointer-events-none absolute z-0"
      style={{
        // Overscan by the blur radius so the blurred edges do not reveal the
        // shell background underneath.
        inset: appearance.backgroundImageBlur > 0 ? `-${appearance.backgroundImageBlur}px` : 0,
        backgroundImage: `url(${appearance.backgroundImage})`,
        backgroundSize: appearance.backgroundImagePosition === 'tile' ? 'auto' : appearance.backgroundImagePosition,
        backgroundPosition: 'center',
        backgroundRepeat: appearance.backgroundImagePosition === 'tile' ? 'repeat' : 'no-repeat',
        opacity: appearance.backgroundImageOpacity / 100,
        filter: appearance.backgroundImageBlur > 0 ? `blur(${appearance.backgroundImageBlur}px)` : 'none',
      }}
    />
  );
}