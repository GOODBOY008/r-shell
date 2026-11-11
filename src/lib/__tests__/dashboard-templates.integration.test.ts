import { isCommandWidget } from '../dashboard-config';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { DASHBOARD_TEMPLATES, dashboardFromTemplate } from '../dashboard-templates';
import { parseMonitorOutput } from '../monitor-data';

// Opt in with the name of a disposable Linux SSH fixture that can read Docker.
const container = process.env.RSHELL_DASHBOARD_TEMPLATE_CONTAINER;
describe.skipIf(!container)('real dashboard template commands', () => {
  it.each(DASHBOARD_TEMPLATES.filter(template => template.id !== 'blank'))('parses every $id card from real host output', async template => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: {} } } });
    const board = dashboardFromTemplate(template, 'Live', ['fixture'], false, i18n.t);
    const output = new Map(board.sources.map(source => [source.id, execFileSync('docker', ['exec', '--user', 'testuser', container!, 'sh', '-c', source.command], { encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024 })]));
    for (const widget of board.widgets.filter(isCommandWidget)) {
      const data = parseMonitorOutput(widget, output.get(widget.sourceId)!);
      if (data.kind === 'numbers') expect(data.values.every(Number.isFinite)).toBe(true);
      if (data.kind === 'text') expect(data.text.trim().length).toBeGreaterThan(0);
      if (data.kind === 'table') expect(data.rows.length).toBeGreaterThan(0);
    }
  });
});
