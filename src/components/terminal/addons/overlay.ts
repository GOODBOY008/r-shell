// Overlay addon for visual feedback - ported from ttyd
import { ITerminalAddon, Terminal } from '@xterm/xterm';

export class OverlayAddon implements ITerminalAddon {
  private terminal: Terminal | null = null;
  private overlayNode: HTMLElement;
  private overlayTimeout?: number;

  constructor() {
    this.overlayNode = document.createElement('div');
    this.overlayNode.style.cssText = `
      border-radius: 15px;
      font-size: xx-large;
      opacity: 0.75;
      padding: 0.2em 0.5em 0.2em 0.5em;
      position: absolute;
      -webkit-user-select: none;
      -webkit-transition: opacity 180ms ease-in;
      -moz-user-select: none;
      -moz-transition: opacity 180ms ease-in;
    `;

    this.overlayNode.addEventListener(
      'mousedown',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
  }

  activate(terminal: Terminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    if (this.overlayTimeout) {
      clearTimeout(this.overlayTimeout);
    }
  }

  showOverlay(msg: string, timeout = 1500): void {
    if (!this.terminal) return;

    const { overlayNode } = this;
    const screen = this.terminal.element;
    if (!screen) return;

    const options = this.terminal.options;
    const themeBackground = options.theme?.background || '#000';
    const themeForeground = options.theme?.foreground || '#fff';

    overlayNode.style.color = themeForeground;
    overlayNode.style.backgroundColor = themeBackground;
    overlayNode.textContent = msg;
    overlayNode.style.opacity = '0.75';

    if (!overlayNode.parentNode) {
      screen.appendChild(overlayNode);
    }

    const screenSize = screen.getBoundingClientRect();
    const overlaySize = overlayNode.getBoundingClientRect();

    overlayNode.style.top = (screenSize.height - overlaySize.height) / 2 + 'px';
    overlayNode.style.left = (screenSize.width - overlaySize.width) / 2 + 'px';

    if (this.overlayTimeout) {
      clearTimeout(this.overlayTimeout);
    }

    this.overlayTimeout = window.setTimeout(() => {
      overlayNode.style.opacity = '0';
      this.overlayTimeout = window.setTimeout(() => {
        if (overlayNode.parentNode) {
          overlayNode.parentNode.removeChild(overlayNode);
        }
        this.overlayTimeout = undefined;
        overlayNode.style.opacity = '0.75';
      }, 200);
    }, timeout);
  }
}
