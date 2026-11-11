import { isCommandWidget } from '../dashboard-config';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { DASHBOARD_TEMPLATES, dashboardFromTemplate } from '../dashboard-templates';
import { parseMonitorOutput } from '../monitor-data';

// Opt in with the name of a disposable Linux SSH fixture that can read Docker.
const container = process.env.RSHELL_DASHBOARD_TEMPLATE_CONTAINER;
// Enable hardware/systemd templates only when the disposable fixture provides them.
const templates = (process.env.RSHELL_DASHBOARD_TEMPLATE_IDS ?? 'linux,docker,storage,processes,network,mixed,runbook,blank').split(',');
describe.skipIf(!container)('real dashboard template commands', () => {
  it.each(DASHBOARD_TEMPLATES.filter(template => templates.includes(template.id)))('validates $id cards against real host capabilities', async template => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: {} } } });
    const board = dashboardFromTemplate(template, 'Live', ['fixture'], false, i18n.t);
    const output = new Map<string, string>();
    const unavailable = new Set<string>();
    for (const source of board.sources) {
      try {
        output.set(source.id, execFileSync('docker', ['exec', '--user', 'testuser', container!, 'sh', '-c', source.command], { encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024 }));
      } catch (error) {
        if (!source.command.includes('df -Pi /')) throw error;
        // Some Docker overlay filesystems report no inode capacity. That must
        // remain an explicit collection error, never a fabricated healthy zero.
        const df = execFileSync('docker', ['exec', '--user', 'testuser', container!, 'df', '-Pi', '/'], { encoding: 'utf8', timeout: 5000 });
        expect(df.trim().split('\n')[1].trim().split(/\s+/)[1]).toMatch(/^(0|-)$/);
        unavailable.add(source.id);
      }
    }
    for (const widget of board.widgets.filter(isCommandWidget)) {
      if (unavailable.has(widget.sourceId)) { expect(widget.fields[0].path).toBe('inodeUsedPercent'); continue; }
      const data = parseMonitorOutput(widget, output.get(widget.sourceId)!);
      if (data.kind === 'numbers') expect(data.values.every(Number.isFinite)).toBe(true);
      if (data.kind === 'text') expect(data.text.trim().length).toBeGreaterThan(0);
      if (data.kind === 'table') expect(data.rows.length).toBeGreaterThan(0);
    }
  });
});
