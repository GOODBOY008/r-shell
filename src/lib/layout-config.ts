/**
 * Layout Configuration and Management
 * Provides VS Code-like layout functionality
 */

export interface LayoutConfig {
  leftSidebarVisible: boolean;
  leftSidebarSize: number;
  rightSidebarVisible: boolean;
  rightSidebarSize: number;
  bottomPanelVisible: boolean;
  bottomPanelSize: number;
  zenMode: boolean;
}

export interface LayoutPreset {
  name: string;
  description: string;
  config: LayoutConfig;
}

const DEFAULT_LAYOUT: LayoutConfig = {
  leftSidebarVisible: true,
  leftSidebarSize: 15,
  rightSidebarVisible: true,
  rightSidebarSize: 20,
  bottomPanelVisible: true,
  bottomPanelSize: 30,
  zenMode: false,
};

const LAYOUT_STORAGE_KEY = 'r-shell-layout-config';

export class LayoutManager {
  /**
   * Load layout configuration from localStorage
   */
  static loadLayout(): LayoutConfig {
    try {
      const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (stored) {
        const config = JSON.parse(stored);
        return { ...DEFAULT_LAYOUT, ...config };
      }
    } catch (error) {
      console.error('Failed to load layout config:', error);
    }
    return DEFAULT_LAYOUT;
  }

  /**
   * Save layout configuration to localStorage
   */
  static saveLayout(config: LayoutConfig): void {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
      console.error('Failed to save layout config:', error);
    }
  }

  /**
   * Reset layout to default
   */
  static resetLayout(): LayoutConfig {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    return DEFAULT_LAYOUT;
  }

  /**
   * Get predefined layout presets
   */
  static getPresets(): LayoutPreset[] {
    return [
      {
        name: 'Default',
        description: 'Standard three-panel layout',
        config: DEFAULT_LAYOUT,
      },
      {
        name: 'Minimal',
        description: 'Terminal only, all panels hidden',
        config: {
          leftSidebarVisible: false,
          leftSidebarSize: 15,
          rightSidebarVisible: false,
          rightSidebarSize: 20,
          bottomPanelVisible: false,
          bottomPanelSize: 30,
          zenMode: false,
        },
      },
      {
        name: 'Focus Mode',
        description: 'Terminal with session manager only',
        config: {
          leftSidebarVisible: true,
          leftSidebarSize: 15,
          rightSidebarVisible: false,
          rightSidebarSize: 20,
          bottomPanelVisible: false,
          bottomPanelSize: 30,
          zenMode: false,
        },
      },
      {
        name: 'Full Stack',
        description: 'All panels visible for maximum visibility',
        config: {
          leftSidebarVisible: true,
          leftSidebarSize: 15,
          rightSidebarVisible: true,
          rightSidebarSize: 20,
          bottomPanelVisible: true,
          bottomPanelSize: 35,
          zenMode: false,
        },
      },
      {
        name: 'Zen Mode',
        description: 'Distraction-free terminal experience',
        config: {
          leftSidebarVisible: false,
          leftSidebarSize: 15,
          rightSidebarVisible: false,
          rightSidebarSize: 20,
          bottomPanelVisible: false,
          bottomPanelSize: 30,
          zenMode: true,
        },
      },
    ];
  }

  /**
   * Apply a preset layout
   */
  static applyPreset(presetName: string): LayoutConfig {
    const preset = this.getPresets().find(p => p.name === presetName);
    if (preset) {
      this.saveLayout(preset.config);
      return preset.config;
    }
    return DEFAULT_LAYOUT;
  }
}
