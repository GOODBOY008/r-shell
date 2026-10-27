import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMonitor } from '../components/log-monitor';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

describe('LogMonitor search feedback', () => {
  beforeEach(() => {
    invoke.mockImplementation(async (command: string) => command === 'read_log'
      ? { success: true, output: 'INFO connection restored\nWARN retry retry' }
      : { success: true, sources: [] });
  });
  afterEach(cleanup);

  async function load() {
    const result = render(<LogMonitor connectionId="review" externalLogPath="/var/log/app.log" />);
    await screen.findByText('INFO connection restored');
    return result;
  }

  it('explains invalid regex and recovers when the search is cleared', async () => {
    await load();
    const search = screen.getByRole('textbox', { name: /Search logs/ });
    fireEvent.click(screen.getByRole('button', { name: /regex/i }));
    fireEvent.change(search, { target: { value: '[' } });
    expect(search.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid regular expression/);
    expect(screen.queryByText('INFO connection restored')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('INFO connection restored')).toBeTruthy();
  });

  it('preserves log text while highlighting regex captures and backreferences', async () => {
    const { container } = await load();
    fireEvent.click(screen.getByRole('button', { name: /regex/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /Search logs/ }), { target: { value: '(retry) \\1' } });
    const message = container.querySelector('.log-message');
    expect(message?.textContent).toBe('WARN retry retry');
    expect(message?.querySelector('mark')?.textContent).toBe('retry retry');
    expect(container.querySelectorAll('.log-message')).toHaveLength(1);
  });
});
