import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

// Test credentials - Replace with your own test server credentials
const TEST_HOST = 'localhost'; // Replace with your test SSH server
const TEST_USERNAME = 'testuser'; // Replace with your test username
const TEST_PASSWORD = 'testpass'; // Replace with your test password

describe('SSH Connection Tests', () => {
  let connectionId: string;

  beforeAll(() => {
    connectionId = `test-connection-${Date.now()}`;
  });

  afterAll(async () => {
    // Clean up: disconnect the test connection
    if (connectionId) {
      try {
        await invoke('ssh_disconnect', { connection_id: connectionId });
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }
  });

  it('should successfully connect to SSH server', async () => {
    const result = await invoke<{ success: boolean; error?: string }>(
      'ssh_connect',
      {
        request: {
          connection_id: connectionId,
          host: TEST_HOST,
          port: 22,
          username: TEST_USERNAME,
          auth_method: 'password',
          password: TEST_PASSWORD,
          key_path: null,
          passphrase: null,
        }
      }
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  }, 10000); // 10 second timeout for connection

  it('should execute a simple command', async () => {
    const result = await invoke<{ success: boolean; output?: string; error?: string }>(
      'ssh_execute_command',
      {
        connection_id: connectionId,
        command: 'echo "Hello from test"',
      }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello from test');
  }, 5000);

  it('should get system stats', async () => {
    const result = await invoke<{ success: boolean; output?: string; error?: string }>(
      'get_system_stats',
      { connection_id: connectionId }
    );

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    
    if (result.output) {
      const stats = JSON.parse(result.output);
      expect(stats).toHaveProperty('cpu');
      expect(stats).toHaveProperty('memory');
      expect(stats).toHaveProperty('disk');
      expect(stats).toHaveProperty('uptime');
    }
  }, 5000);

  it('should get process list', async () => {
    const result = await invoke<{ 
      success: boolean; 
      processes?: Array<{
        pid: number;
        user: string;
        cpu: number;
        mem: number;
        command: string;
      }>; 
      error?: string 
    }>('get_processes', { connection_id: connectionId });

    expect(result.success).toBe(true);
    expect(result.processes).toBeDefined();
    expect(Array.isArray(result.processes)).toBe(true);
    
    if (result.processes && result.processes.length > 0) {
      const process = result.processes[0];
      expect(process).toHaveProperty('pid');
      expect(process).toHaveProperty('user');
      expect(process).toHaveProperty('cpu');
      expect(process).toHaveProperty('mem');
      expect(process).toHaveProperty('command');
    }
  }, 5000);

  it('should list files in home directory', async () => {
    const result = await invoke<{ 
      success: boolean; 
      files?: Array<{
        name: string;
        size: number;
        is_dir: boolean;
        modified: string;
        permissions: string;
      }>; 
      error?: string 
    }>('list_files', {
      connection_id: connectionId,
      path: '~'
    });

    expect(result.success).toBe(true);
    expect(result.files).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
  }, 5000);

  it('should fail with invalid credentials', async () => {
    const badConnectionId = `bad-connection-${Date.now()}`;
    const result = await invoke<{ success: boolean; error?: string }>(
      'ssh_connect',
      {
        request: {
          connection_id: badConnectionId,
          host: TEST_HOST,
          port: 22,
          username: TEST_USERNAME,
          auth_method: 'password',
          password: 'wrongpassword',
          key_path: null,
          passphrase: null,
        }
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, 10000);

  it('should disconnect successfully', async () => {
    const result = await invoke<{ success: boolean; error?: string }>(
      'ssh_disconnect',
      { connection_id: connectionId }
    );

    expect(result.success).toBe(true);
  }, 5000);
});
