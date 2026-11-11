import { describe, expect, it } from 'vitest';
import { DASHBOARD_TEMPLATES, dashboardFromTemplate } from '../dashboard-templates';
import { validDashboard } from '../dashboard-config';
import i18n from '../i18n';

describe('dashboard starter templates', () => {
  it('samples expensive or slowly changing probes less often', () => {
    const linux = dashboardFromTemplate(DASHBOARD_TEMPLATES[0], 'Linux', ['one'], false, i18n.t);
    const docker = dashboardFromTemplate(DASHBOARD_TEMPLATES[1], 'Docker', ['one'], false, i18n.t);
    expect(linux.sources.map(source => source.intervalSeconds)).toEqual([10, 60, 60]);
    expect(docker.sources.map(source => source.intervalSeconds)).toEqual([15, 30, 30]);
  });
  it.each(DASHBOARD_TEMPLATES)('creates an independent valid $id dashboard with shared source references', template => {
    const before = JSON.stringify(template);
    const first = dashboardFromTemplate(template, 'First', ['one', 'two', 'one'], true, i18n.t);
    const second = dashboardFromTemplate(template, 'Second', ['other'], false, i18n.t);
    expect(validDashboard(first)).toBe(true);
    expect(validDashboard(second)).toBe(true);
    expect(first.paused).toBe(true);
    expect(second.paused).toBe(false);
    expect(first.id).not.toBe(second.id);
    expect(first.sources.every(source => JSON.stringify(source.connectionIds) === JSON.stringify(['one', 'two']))).toBe(true);
    expect(first.sources.every(source => !second.sources.some(other => other.id === source.id))).toBe(true);
    expect(first.widgets.every(widget => !second.widgets.some(other => other.id === widget.id))).toBe(true);
    if (template.id !== 'blank') expect(first.widgets[0].sourceId).toBe(first.widgets[1].sourceId);
    first.sources.forEach(source => { source.command = 'edited'; source.connectionIds.push('changed'); });
    expect(JSON.stringify(template)).toBe(before);
    expect(second.sources.every(source => source.connectionIds.join() === 'other')).toBe(true);
  });
  it('rejects missing connections for populated templates and permits an empty workspace', () => {
    expect(() => dashboardFromTemplate(DASHBOARD_TEMPLATES[0], 'Hosts', [], false, i18n.t)).toThrow();
    expect(dashboardFromTemplate(DASHBOARD_TEMPLATES[2], 'Empty', [], false, i18n.t).widgets).toEqual([]);
  });
});
