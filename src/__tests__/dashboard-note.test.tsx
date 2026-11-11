import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DashboardNote } from '../components/dashboard-note';
import { DashboardNoteEditor } from '../components/dashboard-note-editor';
import { newDashboard, newDashboardNote, type DashboardNoteWidget } from '../lib/dashboard-config';
import '../lib/i18n';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const note = (content: string): DashboardNoteWidget => ({ ...newDashboardNote(), name: 'Runbook', content });

describe('static dashboard content', () => {
  it('keeps plain text literal, including Markdown, HTML, whitespace and line breaks', () => {
    const content = '# Title\n  <b>literal</b>\n\n**No formatting**';
    const { container } = render(<DashboardNote widget={{ ...note(content), format: 'text' }} />);
    expect(container.textContent).toBe(content); expect(container.querySelector('h1,b,strong')).toBeNull();
  });
  it('renders Markdown headings, tasks, tables, fenced code and external links', () => {
    render(<DashboardNote widget={note('## Guide\n\n- [x] Ready\n\n| Host | State |\n| --- | --- |\n| A | OK |\n\n```sh\ndocker ps\n```\n\n[Docs](https://docs.docker.com/)')} />);
    expect(screen.getByRole('heading', { name: 'Guide', level: 2 })).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(within(screen.getByRole('table')).getByRole('cell', { name: 'OK' })).toBeTruthy();
    expect(screen.getByText('docker ps').tagName).toBe('CODE');
    fireEvent.click(screen.getByRole('link', { name: 'Docs' }));
    expect(openUrl).toHaveBeenCalledWith('https://docs.docker.com/');
  });
  it('does not render raw HTML, executable URLs or local files', () => {
    const { container } = render(<DashboardNote widget={note('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[JS](javascript:alert%281%29) [file](file:///etc/passwd) [data](data:text/html,test) [relative](/inside-app)\n\n![local](file:///etc/passwd)')} />);
    expect(container.querySelector('script,img,iframe')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0); expect(openUrl).not.toHaveBeenCalled();
  });
  it('isolates footnote anchors between cards', () => {
    const { container } = render(<><DashboardNote widget={note('One[^1]\n\n[^1]: Note')} /><DashboardNote widget={note('Two[^1]\n\n[^1]: Note')} /></>);
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const link of container.querySelectorAll('a[href^="#"]')) expect(document.getElementById(link.getAttribute('href')!.slice(1))).toBeTruthy();
  });
});

describe('static card editor', () => {
  it('previews without saving and cancels a draft without creating sources', () => {
    const save = vi.fn(); const close = vi.fn(); const board = newDashboard('Offline');
    render(<DashboardNoteEditor board={board} onSave={save} onClose={close} />);
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: '## Draft' } });
    expect(screen.getByRole('heading', { name: 'Draft' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'text' } });
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(save).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(board.sources).toEqual([]);
  });
  it('saves edited content and format while retaining card identity, geometry and visibility', () => {
    const initial = { ...note('Old'), enabled: false, layouts: { wide: { x: 0, y: 0, w: 12, h: 5 } } };
    const board = { ...newDashboard('Notes'), widgets: [initial] }; const save = vi.fn();
    render(<DashboardNoteEditor board={board} initialWidget={initial} onSave={save} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: '  New\n\ntext  ' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mock.calls[0][0]).toEqual({ ...board, widgets: [{ ...initial, format: 'text', content: '  New\n\ntext  ' }] });
  });
  it('keeps unsaved content open on a persistence failure and rejects oversized UTF-8 text', () => {
    const close = vi.fn();
    render(<DashboardNoteEditor board={newDashboard('Notes')} initialWidget={note('Draft')} onSave={() => { throw new Error('quota'); }} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toBeTruthy(); expect(close).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: '界'.repeat(22_000) } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
