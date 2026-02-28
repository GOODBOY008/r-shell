/**
 * Connection Profile Management
 * Handles saving, loading, and managing SSH connection profiles
 */

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password?: string; // Note: In production, use encrypted storage
  privateKey?: string;
  createdAt: string;
  updatedAt: string;
  favorite?: boolean;
  color?: string; // Optional color tag
  tags?: string[]; // Optional tags for organization
}

const STORAGE_KEY = 'r-shell-connection-profiles';

export class ConnectionProfileManager {
  /**
   * Get all saved connection profiles
   */
  static getProfiles(): ConnectionProfile[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ConnectionProfile[];
    } catch (error) {
      console.error('Failed to load connection profiles:', error);
      return [];
    }
  }

  /**
   * Get a single profile by ID
   */
  static getProfile(id: string): ConnectionProfile | undefined {
    const profiles = this.getProfiles();
    return profiles.find(p => p.id === id);
  }

  /**
   * Save a new connection profile
   */
  static saveProfile(profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>): ConnectionProfile {
    const profiles = this.getProfiles();
    
    const newProfile: ConnectionProfile = {
      ...profile,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    profiles.push(newProfile);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
    
    return newProfile;
  }

  /**
   * Update an existing profile
   */
  static updateProfile(id: string, updates: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>): ConnectionProfile | null {
    const profiles = this.getProfiles();
    const index = profiles.findIndex(p => p.id === id);
    
    if (index === -1) return null;
    
    profiles[index] = {
      ...profiles[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
    return profiles[index];
  }

  /**
   * Delete a profile
   */
  static deleteProfile(id: string): boolean {
    const profiles = this.getProfiles();
    const filtered = profiles.filter(p => p.id !== id);
    
    if (filtered.length === profiles.length) return false;
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    return true;
  }

  /**
   * Export profiles as JSON
   */
  static exportProfiles(): string {
    const profiles = this.getProfiles();
    return JSON.stringify(profiles, null, 2);
  }

  /**
   * Import profiles from JSON
   */
  static importProfiles(json: string, merge: boolean = false): number {
    try {
      const imported = JSON.parse(json) as ConnectionProfile[];
      
      if (!Array.isArray(imported)) {
        throw new Error('Invalid JSON format');
      }
      
      const profiles = merge ? this.getProfiles() : [];
      
      // Add imported profiles with new IDs to avoid conflicts
      imported.forEach(profile => {
        profiles.push({
          ...profile,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
      
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
      return imported.length;
    } catch (error) {
      console.error('Failed to import profiles:', error);
      throw error;
    }
  }

  /**
   * Get favorite profiles
   */
  static getFavorites(): ConnectionProfile[] {
    return this.getProfiles().filter(p => p.favorite);
  }

  /**
   * Get profiles by tag
   */
  static getProfilesByTag(tag: string): ConnectionProfile[] {
    return this.getProfiles().filter(p => p.tags?.includes(tag));
  }

  /**
   * Get all unique tags
   */
  static getAllTags(): string[] {
    const profiles = this.getProfiles();
    const tags = new Set<string>();
    
    profiles.forEach(p => {
      p.tags?.forEach(tag => tags.add(tag));
    });
    
    return Array.from(tags).sort();
  }

  /**
   * Clear all profiles (use with caution!)
   */
  static clearAll(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}
