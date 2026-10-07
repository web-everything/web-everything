import { describe, it, expect } from 'vitest';
import {
  assessBuilderStarvation, parseTickRows, classifyPrMovement, renderSweepReport,
  SWEEP_JOBS, buildLaunchdPlist, installPlan,
} from '../scheduled-sweep.mjs';
import { DAEMON_MANIFEST } from '../../../skills-src/conveyor/daemon-manifest.mjs';

const MIN = 60_000;
const now = Date.parse('2026-10-07T12:00:00Z');
const tick = (minAgo, extra = {}) => ({
  at: new Date(now - minAgo * MIN).toISOString(),
  status: 'conveyor · 0 building · 3 preparing · 0 fixing · 0 healing · 12 queued · 0 parked',
  inFlight: [], openItems: { count: 0, cap: 7 }, dispatched: [], prepare: { launched: [] }, ...extra,
});

describe('assessBuilderStarvation', () => {
  it('flags queue>0, free capacity, and no launch for 60 min (the 2026-10-07 overnight case)', () => {
    const rows = [tick(400, { dispatched: [{ num: '1' }] }), tick(120), tick(60), tick(2)];
    const r = assessBuilderStarvation(rows, { now });
    expect(r.starved).toBe(true);
    expect(r.queued).toBe(12);
    expect(r.freeSlots).toBeGreaterThan(0);
    expect(r.minutesSinceLaunch).toBe(400);
  });
  it('a build launch inside the window clears it', () => {
    const rows = [tick(30, { dispatched: [{ num: '1' }] }), tick(2)];
    expect(assessBuilderStarvation(rows, { now }).starved).toBe(false);
  });
  it('a prepare launch counts as a launch', () => {
    const rows = [tick(30, { prepare: { launched: [{ num: '9' }] } }), tick(2)];
    expect(assessBuilderStarvation(rows, { now }).starved).toBe(false);
  });
  it('empty queue or full capacity is not starvation', () => {
    expect(assessBuilderStarvation([tick(2, { status: '0 queued' })], { now }).starved).toBe(false);
    expect(assessBuilderStarvation([tick(2, { inFlight: [{}], openItems: { count: 7, cap: 7 } })], { now, buildCap: 1 }).starved).toBe(false);
  });
  it('honours the threshold knob and reports no-data without alarming', () => {
    expect(assessBuilderStarvation([tick(2)], { now, thresholdMin: 1 }).starved).toBe(true);
    const r = assessBuilderStarvation([], { now });
    expect(r.starved).toBe(false);
    expect(r.noData).toBe(true);
  });
  it('a stale newest tick (daemon down) is reported as stale, not starved', () => {
    const r = assessBuilderStarvation([tick(300)], { now });
    expect(r.daemonStale).toBe(true);
  });
});

describe('parseTickRows', () => {
  it('keeps tick rows and drops noise lines', () => {
    const text = ['2026-10-07T10:54:02Z noise', JSON.stringify(tick(1)), '{"x":1}', 'not json'].join('\n');
    expect(parseTickRows(text)).toHaveLength(1);
  });
});

describe('classifyPrMovement', () => {
  const pr = (o) => ({ number: 1, title: 't', isDraft: false, updatedAt: new Date(now - 5 * MIN).toISOString(), labels: [], mergeable: 'MERGEABLE', statusCheckRollup: [], ...o });
  it('buckets stalled, conflicting, red and send-back PRs', () => {
    const out = classifyPrMovement([
      pr({ number: 1 }),
      pr({ number: 2, updatedAt: new Date(now - 200 * MIN).toISOString() }),
      pr({ number: 3, mergeable: 'CONFLICTING' }),
      pr({ number: 4, statusCheckRollup: [{ conclusion: 'FAILURE', name: 'test' }] }),
      pr({ number: 5, labels: [{ name: 'review:changes' }] }),
    ], { now, stalledMin: 90 });
    expect(out.moving.map((p) => p.number)).toEqual([1]);
    expect(out.stalled.map((p) => p.number)).toContain(2);
    expect(out.conflicting.map((p) => p.number)).toEqual([3]);
    expect(out.red.map((p) => p.number)).toEqual([4]);
    expect(out.changesRequested.map((p) => p.number)).toEqual([5]);
  });
});

describe('report and wiring', () => {
  it('renders attention first', () => {
    const md = renderSweepReport({ job: 'pr-movement', at: '2026-10-07T12:00:00.000Z', attention: ['builder starved'], sections: [{ title: 'PRs', lines: ['a'] }] });
    expect(md.indexOf('builder starved')).toBeLessThan(md.indexOf('PRs'));
  });
  it('declares the three jobs as non-default manifest passes', () => {
    expect(Object.keys(SWEEP_JOBS).sort()).toEqual(['coroner', 'opus', 'pr-movement']);
    for (const [job, name] of [['pr-movement', 'pr-movement-sweep'], ['coroner', 'coroner-sweep'], ['opus', 'opus-sweep']]) {
      const e = DAEMON_MANIFEST[name];
      expect(e, name).toBeDefined();
      expect(e.script).toBe('scripts/operations/scheduled-sweep.mjs');
      expect(e.args).toEqual(['run', job]);
      expect(e.defaultLaunch).toBe(false);
    }
    expect(DAEMON_MANIFEST['pr-movement-sweep'].intervalMs).toBe(30 * MIN);
  });
  it('plist runs the pass daemon for the named pass and install is default-off', () => {
    const xml = buildLaunchdPlist({ pass: 'pr-movement-sweep', repoRoot: '/r', nodePath: '/n', home: '/h' });
    expect(xml).toContain('com.we.conveyor-pass-daemon.pr-movement-sweep');
    expect(xml).toContain('--pass=pr-movement-sweep');
    const plan = installPlan({ repoRoot: '/r', nodePath: '/n', home: '/h', apply: false });
    expect(plan.writes).toEqual([]);
    expect(plan.commands.length).toBe(3);
    expect(plan.commands.join('\n')).toContain('launchctl bootstrap');
  });
});
