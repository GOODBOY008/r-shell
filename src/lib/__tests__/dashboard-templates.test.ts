import { describe, expect, it } from 'vitest';
import { DASHBOARD_TEMPLATES, appendDashboardTemplate, dashboardFromTemplate, dashboardFromTemplates, planDashboardTemplates, type DashboardTemplateId } from '../dashboard-templates';
import { isCommandWidget, validDashboard } from '../dashboard-config';
import i18n from '../i18n';
const template = (id: DashboardTemplateId) => DASHBOARD_TEMPLATES.find(item => item.id === id)!;

describe('dashboard starter templates', () => {
  it('preserves the default sampling frequency for every starter probe', () => {
    const linux = dashboardFromTemplate(DASHBOARD_TEMPLATES[0], 'Linux', ['one'], false, i18n.t);
    const docker = dashboardFromTemplate(DASHBOARD_TEMPLATES[1], 'Docker', ['one'], false, i18n.t);
    expect(linux.sources.map(source => source.intervalSeconds)).toEqual([10, 10, 10]);
    expect(docker.sources.map(source => source.intervalSeconds)).toEqual([10, 10, 10]);
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
    const commands = first.widgets.filter(isCommandWidget);
    if (commands.length > 1) expect(commands.some((card, index) => commands.some((other, otherIndex) => index !== otherIndex && card.sourceId === other.sourceId))).toBe(true);
    first.sources.forEach(source => { source.command = 'edited'; source.connectionIds.push('changed'); });
    expect(JSON.stringify(template)).toBe(before);
    expect(second.sources.every(source => source.connectionIds.join() === 'other')).toBe(true);
  });
  it('rejects missing connections for populated templates and permits an empty workspace', () => {
    expect(() => dashboardFromTemplate(DASHBOARD_TEMPLATES[0], 'Hosts', [], false, i18n.t)).toThrow();
    expect(dashboardFromTemplate(template('blank'), 'Empty', [], false, i18n.t).widgets).toEqual([]);
  });
  it('binds mixed collection groups to different connections and includes both note formats', () => {
    const board = dashboardFromTemplates([template('mixed')], 'Production', { linux: ['app'], docker: ['containers'] }, false, i18n.t);
    expect(validDashboard(board)).toBe(true);
    expect(board.sources.slice(0, 3).every(source => source.connectionIds.join() === 'app')).toBe(true);
    expect(board.sources.slice(3).every(source => source.connectionIds.join() === 'containers')).toBe(true);
    const summaries = board.widgets.filter(isCommandWidget).slice(0, 2);
    expect(summaries.map(card => card.display)).toEqual(['number', 'number']);
    expect(summaries[0].sourceId).not.toBe(summaries[1].sourceId);
    expect(board.widgets.filter(widget => !isCommandWidget(widget)).map(note => note.format)).toEqual(['markdown', 'text']);
    expect(() => dashboardFromTemplates([template('mixed')], 'Missing', { linux: ['app'] }, false, i18n.t)).toThrow();
  });
  it('deduplicates overlapping presets, sources and identical cards on the same connection set', () => {
    const choices = [template('mixed'), template('linux'), template('storage'), template('runbook')];
    const bindings = { linux: ['one', 'two'], docker: ['two'], storage: ['two', 'one'] };
    const plan = planDashboardTemplates(choices, bindings);
    const board = dashboardFromTemplates(choices, 'Mixed', bindings, false, i18n.t);
    expect(plan.blocks.map(block => block.id)).toEqual(['linux', 'docker', 'runbook', 'storage']);
    expect(board.sources.filter(source => source.command === 'LC_ALL=C df -hP')).toHaveLength(1);
    expect(board.widgets.filter(widget => widget.name === i18n.t('dashboard.templates.cards.disks'))).toHaveLength(1);
    expect(board.widgets).toHaveLength(plan.cards.length + plan.notes.length);
    expect(board.sources).toHaveLength(8);
  });
  it('keeps different host bindings independent even when the commands match', () => {
    const board = dashboardFromTemplates([template('linux'), template('storage')], 'Mixed', { linux: ['one'], storage: ['two'] }, false, i18n.t);
    const disks = board.sources.filter(source => source.command === 'LC_ALL=C df -hP');
    expect(disks.map(source => source.connectionIds)).toEqual([['one'], ['two']]);
    expect(new Set(disks.map(source => source.id)).size).toBe(2);
  });
  it('appends cards using existing matching collectors without changing their identity or layout', () => {
    const board = dashboardFromTemplate(template('linux'), 'Existing', ['one'], true, i18n.t);
    board.widgets[0].layouts = { wide: { x: 0, y: 3, w: 4, h: 6 } };
    const before = structuredClone(board);
    const addition = dashboardFromTemplate(template('storage'), 'Added', ['one'], false, i18n.t);
    const appended = appendDashboardTemplate(board, addition);
    expect(board).toEqual(before);
    expect(appended.id).toBe(board.id); expect(appended.paused).toBe(true);
    expect(appended.widgets.slice(0, board.widgets.length)).toEqual(board.widgets);
    expect(appended.sources).toHaveLength(5);
    const diskSource = board.sources.find(source => source.command === 'LC_ALL=C df -hP')!;
    expect(appended.widgets.filter(isCommandWidget).filter(card => card.sourceId === diskSource.id)).toHaveLength(2);
    expect(validDashboard(appended)).toBe(true);
  });
  it.each(['en', 'zh-CN', 'pl'])('creates localized standalone notes without SSH in %s', language => {
    const board = dashboardFromTemplate(template('runbook'), 'Notes', [], false, i18n.getFixedT(language));
    expect(board.sources).toEqual([]); expect(validDashboard(board)).toBe(true);
    expect(board.widgets).toHaveLength(2);
    expect(board.widgets.every(widget => !isCommandWidget(widget) && widget.content.length > 20 && !widget.content.startsWith('dashboard.'))).toBe(true);
  });
});
