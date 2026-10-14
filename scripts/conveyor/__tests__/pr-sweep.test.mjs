/** @file pr-sweep.test.mjs
 * @description Card 335 — deterministic movement sweep and fail-closed IO contract.
 */
import { describe, it, expect } from 'vitest';
import { classifyIdlePrs, resolveOwner, planSweep } from '../pr-sweep-core.mjs';
import { runPrSweep } from '../pr-sweep.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const now = Date.parse('2026-10-14T16:00:00Z');
const pr = { repo: 'web-everything/web-everything', number: 12, title: 'test', updatedAt: new Date(now - 120 * 60000).toISOString(), headRefOid: 'abc', labels: ['review:changes'], isDraft: true };
const settings = { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, dispatchDiagnosis: false, repos: [pr.repo] };
const plan = (o = {}) => planSweep({ idle: [pr], owners: { [`${pr.repo}#12`]: resolveOwner(pr, { now, ...settings }) }, now, settings, needsYou: [], ...o });
describe('PR sweep', () => {
  it('includes idle drafts and preserves head, labels; excludes moved/closed/invalid dates', () => {
    expect(classifyIdlePrs({ prs: [pr, { ...pr, number: 2, updatedAt: new Date(now).toISOString() }, { ...pr, state: 'CLOSED' }, { ...pr, updatedAt: 'bad' }], now, idleMinutes: 45 })).toEqual([{ ...pr, ageMin: 120 }]);
  });
  it('binds sessions, recent daemons, stale owner and smell; operator wins', () => {
    expect(resolveOwner(pr, { now, ...settings, sessions: [{ name: 'fix-12' }] }).owner).toBe('session:fix-12');
    expect(resolveOwner(pr, { now, ...settings, daemons: [{ name: 'review', at: now - 1000 }] }).state).toBe('active');
    expect(resolveOwner(pr, { now, ...settings, daemons: [{ name: 'review', at: now - 100 * 60000 }] }).state).toBe('stuck');
    expect(resolveOwner(pr, { now, ...settings, smell: 'fixer-stuck' }).smell).toBe('fixer-stuck');
    expect(resolveOwner(pr, { now, ...settings, operator: true, smell: 'fixer-stuck' }).state).toBe('waiting-operator');
  });
  it.each([{ hung: true }, { pidAlive: false }, { hung: true, pidAlive: false }])('does not refresh ownership for unhealthy sessions: %j', async (health) => {
    for (const [repo, tag] of [[pr.repo, ''], ['plateauapp/plateau-app', 'pa-']]) for (const kind of ['fix', 'ci-heal', 'review', 'inspect']) {
      const key = `${repo}#12`;
      let previous = {};
      const alerts = [];
      for (const minutes of [0, 30, 60, 90, 120, 240]) {
        const out = await runPrSweep({ now: now + minutes * 60000, dryRun: true, config: {},
          settings: { value: { ...settings, repos: [repo] }, sources: {} }, readPrs: () => [pr],
          readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => previous,
          readSignals: () => ({ [key]: { sessions: [{ name: `${kind}-${tag}12`, state: 'working', ...health }] } }) });
        expect(out.idle[0].state).toBe('none');
        expect(out.idle[0].ownerLastSeenAt).toBeNull();
        previous = out.nextState;
        alerts.push(...out.alerts);
      }
      expect(alerts).toHaveLength(1);
      expect(previous.episodes[key].alerted).toBe(true);
    }
  });
  it('keeps healthy or unknown sessions active and falls back from unhealthy ones to daemon evidence', () => {
    for (const health of [{}, { hung: false, pidAlive: true }, { pidAlive: null }]) {
      expect(resolveOwner(pr, { now, ...settings, sessions: [{ name: 'fix-12', state: 'working', ...health }] }).state).toBe('active');
    }
    const unhealthy = { name: 'fix-12', state: 'working', hung: true };
    expect(resolveOwner(pr, { now, ...settings, sessions: [unhealthy, { name: 'review-12' }] }).owner).toBe('session:review-12');
    expect(resolveOwner(pr, { now, ...settings, sessions: [unhealthy], daemons: [{ name: 'review', at: now - 1000 }] }).state).toBe('active');
    expect(resolveOwner(pr, { now, ...settings, sessions: [unhealthy], daemons: [{ name: 'review', at: now - 100 * 60000 }] }).state).toBe('stuck');
  });
  it('alerts once per unmoved head episode and resets on movement/head change', () => {
    const first = plan(); expect(first.alerts).toEqual([]);
    const second = plan({ prevState: first.nextState, now: now + 91 * 60000 });
    expect(second.alerts).toHaveLength(1);
    expect(plan({ prevState: second.nextState, now: now + 180 * 60000 }).alerts).toEqual([]);
    expect(plan({ idle: [{ ...pr, headRefOid: 'def' }], prevState: second.nextState, now: now + 180 * 60000 }).alerts).toEqual([]);
    expect(plan({ idle: [{ ...pr, updatedAt: new Date(now).toISOString() }], prevState: second.nextState }).alerts).toEqual([]);
    expect(plan({ idle: [], prevState: second.nextState }).nextState.episodes).toEqual({});
  });
  it('records first NEEDS YOU set; diffs ready and rulings; incomplete reads preserve previous set', () => {
    const first = plan({ needsYou: [pr] }); expect(first.alerts).toEqual([]);
    const second = plan({ needsYou: [pr, { ...pr, number: 13 }], prevState: first.nextState });
    expect(second.report.needsYouAdded).toHaveLength(1); expect(second.alerts[0].kind).toBe('needs-you');
    expect(plan({ needsYou: null, prevState: first.nextState }).nextState.needsYou).toEqual(first.nextState.needsYou);
  });
  it('failed owner reads never alert or advance unowned episodes', async () => {
    const first = plan();
    const report = await runPrSweep({ now: now + 100 * 60000, dryRun: true, config: {}, settings: { value: settings, sources: {} }, readPrs: async () => [pr], readQueue: async () => ({ ready: [], rulingNeeded: [] }), readSignals: async () => { throw new Error('unreadable'); }, readPrevious: () => first.nextState });
    expect(report.errors.join(' ')).toContain('unreadable'); expect(report.alerts).toEqual([]);
    expect(report.nextState.episodes).toEqual(first.nextState.episodes);
  });
});

it('collects owners by clone name, bounded log timestamps, health smells and refusal memory', async () => {
  const { collectOwnerSignals } = await import('../pr-sweep.mjs');
  const errors = [];
  const signals = await collectOwnerSignals({ prs: [pr], dir: tmpdir(), env: {}, errors,
    readAgents: () => [{ name: 'review-12' }], cloneRoots: () => [join(tmpdir(), 'fix-clone')], listLogs: () => ['fix-dispatch-daemon.log'],
    readTail: () => `${new Date(now - 1000).toISOString()} fixing-12 started\n`,
    readHealth: () => ({ episodes: { a: { smell: 'fixer-stuck', status: 'open', subject: 'pr:we#12' } }, daemons: { review: { prRefusals: { 'we#12': { at: now - 1000, reason: 'no-lane' } } } } }) });
  expect(errors).toEqual([]); expect(signals[`${pr.repo}#12`].smell).toBe('fixer-stuck');
  expect(signals[`${pr.repo}#12`].daemons).toHaveLength(2);
});
it('settings cascade validates leaves and records env and health-config sources', async () => {
  const { resolvePrSweepSettings } = await import('../pr-sweep.mjs');
  const out = resolvePrSweepSettings({ config: { prSweep: { idleMinutes: 60 } }, env: { WE_PR_SWEEP_ENABLED: 'false', WE_PR_SWEEP_INTERVAL_MINUTES: '0' }, log: () => {} });
  expect(out.value.enabled).toBe(false); expect(out.value.idleMinutes).toBe(60); expect(out.value.intervalMinutes).toBe(30);
  expect(out.sources.enabled).toBe('env'); expect(out.sources.idleMinutes).toBe('tool'); expect(out.invalid.length).toBe(1);
});
it('dry run performs no writes, sends or diagnoses; dispatch is an explicit opt-in', async () => {
  const { vi } = await import('vitest');
  const notify = vi.fn(() => ({ ok: true })); const diagnose = vi.fn(); const persist = vi.fn(); const append = vi.fn(); const flush = vi.fn();
  const opts = { now, settings: { value: { ...settings, dispatchDiagnosis: true }, sources: {} }, config: {}, readPrevious: () => ({}), readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({ [`${pr.repo}#12`]: { smell: 'fixer-stuck' } }), notify, diagnose, persist, append, flush };
  await runPrSweep({ ...opts, dryRun: true }); for (const fn of [notify, diagnose, persist, append, flush]) expect(fn).not.toHaveBeenCalled();
  const out = await runPrSweep(opts); expect(diagnose).toHaveBeenCalledWith(pr.repo); expect(persist).toHaveBeenCalledWith(out); expect(append.mock.calls[0][0].split('\n')).toHaveLength(2);
});
it('malformed queue data degrades to an incomplete read instead of crashing', async () => {
  const out = await runPrSweep({ now, dryRun: true, config: {}, settings: { value: settings, sources: {} }, readPrevious: () => ({}), readPrs: () => [pr], readSignals: () => ({}), readQueue: () => ({ ready: [{ number: 12 }], rulingNeeded: [] }) });
  expect(out.needsYou).toBe(null); expect(out.alerts).toEqual([]); expect(out.errors.join(' ')).toContain('operator queue');
});
it('retries failed alerts while preserving the successful ones', async () => {
  const first = plan();
  const out = await runPrSweep({ now: now + 91 * 60000, config: {}, settings: { value: settings, sources: {} }, readPrevious: () => first.nextState, readPrs: () => [pr], readSignals: () => ({}), readQueue: () => ({ ready: [], rulingNeeded: [] }), notify: () => ({ ok: false, error: 'transport failed' }), flush: () => {}, persist: () => {}, append: () => {} });
  expect(out.errors.join(' ')).toContain('transport failed');
  expect(out.nextState.episodes[`${pr.repo}#12`].alerted).toBe(false);
});
it('writes an atomic durable report and a single ET handoff line', async () => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'pr-sweep-report-')); const lines = [];
  try {
    const out = await runPrSweep({ dir, config: {}, now, settings: { value: settings, sources: { enabled: 'tool' } }, readPrevious: () => ({}), readPrs: () => [pr], readSignals: () => ({}), readQueue: () => ({ ready: [pr], rulingNeeded: [] }), flush: () => {}, notify: () => { throw new Error('unexpected notification'); }, append: (line) => lines.push(line) });
    expect(JSON.parse(readFileSync(join(dir, 'pr-sweep.json'), 'utf8'))).toEqual(out);
    expect(readdirSync(dir)).toEqual(['pr-sweep.json']); expect(lines).toHaveLength(1); expect(lines[0]).toContain('ET idle=1');
    expect(out.idle[0].state).toBe('waiting-operator');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
