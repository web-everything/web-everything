import { expect, it, vi } from 'vitest';
import { capacityCalendarOperation, finishCapacityCalendar, renderCalendar } from '../capacity-calendar.mjs';
import { isReadOnlyOperation } from '../registry.mjs';
import { capacityCalendar } from '../capacity-calendar-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

it('requires an injected reader and defers collection until the compute step', () => {
  expect(() => capacityCalendarOperation()).toThrow('collect reader');
  const report = { providers: [] };
  const collect = vi.fn(() => report);
  const declaration = capacityCalendarOperation({ collect });
  expect(isReadOnlyOperation(declaration)).toBe(true);
  expect(declaration.verdictFrom).toBe('read');
  expect(collect).not.toHaveBeenCalled();
  const step = declaration.steps[0].step;
  expect(step.reads).toEqual(['input.horizon']);
  expect(step.fn({ input: { horizon: true } })).toBe(report);
  expect(collect).toHaveBeenLastCalledWith({ horizon: true });
  step.fn({ input: {} });
  expect(collect).toHaveBeenLastCalledWith({ horizon: false });
  expect(finishCapacityCalendar({ run: { verdict: report }, code: 0, lines: ['json'], json: true }))
    .toEqual({ code: 0, lines: ['json'] });
});

it('propagates reader failures instead of returning an empty report', () => {
  const declaration = capacityCalendarOperation({ collect: () => { throw new Error('reading unavailable'); } });
  expect(() => declaration.steps[0].step.fn({ input: {} })).toThrow('reading unavailable');
});

it('renders live banked-reset rate, working-hours plan and 14-day horizon', async () => {
  await withRealRepo(({ root }) => {
    const now = Date.parse('2026-11-19T23:00:00Z'), hour = 3600000;
    const env = { HOME: root, CONVEYOR_STATE_ROOT: root, WE_CAPACITY_READERS: 'on' };
    mkdirSync(join(root, '.plateau'));
    writeFileSync(join(root, '.plateau', 'claude-usage.json'), JSON.stringify({ at: now,
      seven_day: { used_percentage: 35, resets_at: now + 120 * hour } }));
    const settings = { expectedDemandPerDay: 240, demandRatePerHour: 10, providers: [{ id: 'claude',
      tier: 3, windowModel: 'restartOnReset', allowedKinds: ['fix'],
      readers: [{ type: 'plateau-usage-file', file: 'claude-usage.json' }],
      windows: [{ name: 'seven_day', lengthHours: 168 }],
      bankedResets: [{ count: 1, expiresAt: new Date(now + 30 * hour).toISOString() }] }] };
    const rendered = renderCalendar(capacityCalendar({ env, now, settings, horizon: true }));
    expect(rendered).toContain('seven_day: 35%');
    expect(rendered).toContain('live');
    expect(rendered).toContain('required 5.5 vs current 10 %/h');
    expect(rendered).toContain('reset plan ["2026-11-20T14:00:00.000Z"]');
    expect(rendered).toContain('14-day horizon:');
    expect(rendered).toContain('2026-11-19 | claude/claude');
    expect(rendered).toContain('2026-12-02 | claude/claude');
  });
});

it('collects a real usage file from an isolated home and reports corrupt evidence as unknown', async () => {
  await withRealRepo(({ root }) => {
    const now = Date.now();
    const env = { HOME: root, CONVEYOR_STATE_ROOT: root, WE_CAPACITY_READERS: 'on' };
    const settings = { providers: [{ id: 'claude', active: true, tier: 3, windowModel: 'fixed',
      readers: [{ type: 'plateau-usage-file', file: 'claude-usage.json' }], allowedKinds: ['fix'],
      windows: [{ name: 'seven_day', lengthHours: 168 }], bankedResets: [] }] };
    mkdirSync(join(root, '.plateau'));
    const file = join(root, '.plateau', 'claude-usage.json');
    writeFileSync(file, JSON.stringify({ at: now,
      seven_day: { used_percentage: 27, resets_at: new Date(now + 2 * 3600000).toISOString() } }));
    const report = capacityCalendar({ env, now, settings, horizon: true });
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]).toMatchObject({ known: true, windows: [{ usedPercent: 27, source: 'live' }] });
    expect(report.horizon.days).toHaveLength(14);
    writeFileSync(file, '{broken');
    const unknown = capacityCalendar({ env, now, settings });
    expect(unknown.providers[0]).toMatchObject({ known: false, windows: [] });
    expect(unknown.needsOperatorInput.join('\n')).toContain('usage unknown');
  });
});
