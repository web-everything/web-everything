/** @file pr-sweep.test.mjs
 * @description Card 335 — deterministic movement sweep and fail-closed IO contract.
 */
import { describe, it, expect } from 'vitest';
import { classifyIdlePrs, resolveOwner, planSweep } from '../pr-sweep-core.mjs';
import { collectOwnerSignals, runPrSweep } from '../pr-sweep.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const now = Date.parse('2026-10-14T16:00:00Z');
const pr = { repo: 'web-everything/web-everything', number: 12, title: 'test', updatedAt: new Date(now - 120 * 60000).toISOString(), headRefOid: 'abc', labels: ['review:changes'], isDraft: true };
const settings = { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, dispatchDiagnosis: false, repos: [pr.repo] };
const plan = (o = {}) => planSweep({ idle: [pr], owners: { [`${pr.repo}#12`]: resolveOwner(pr, { now, ...settings }) }, now, settings, needsYou: [], ...o });
it.each(['health', 'log', 'review-not-started', 'review-pending', 'review-failed', 'scope-rank', 'note', 'note-comment', 'unknown'])('recurring %s diagnostics do not suppress stalled PR alerts', async (source) => {
  let previous = {}; const alerts = [];
  for (const minutes of [0, 30, 60, 90, 120, 240, 1440]) {
    const tick = now + minutes * 60000;
    const line = {
      log: `reconcile-fix-dispatch-daemon: refused no-lane ${pr.repo} PR #12 — no acquirable lane`,
      'review-not-started': `review-daemon: ${pr.repo}#12 not dispatched — no acquirable lane`,
      'review-pending': `review-daemon: ${pr.repo}#12 review:pending, no review dispatched — no acquirable lane`,
      'review-failed': `review-daemon: ${pr.repo}#12 failed (non-fatal): no lane`,
      'scope-rank': `reconcile-fix-dispatch-daemon: scope-rank ${pr.repo} PR #12 — rank 1, blocks 0, age 2h`,
      note: `reconcile-fix-dispatch-daemon: note awaiting-permission ${pr.repo} PR #12 — no work started`,
      'note-comment': `reconcile-fix-dispatch-daemon: note-comment awaiting-permission ${pr.repo} PR #12 — already posted, skipping`,
      unknown: `reconcile-fix-dispatch-daemon: observed ${pr.repo} PR #12`,
    }[source];
    const out = await runPrSweep({ now: tick, dryRun: true, config: {}, settings: { value: settings, sources: {} },
      readPrevious: () => previous, readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }),
      readSignals: (args) => collectOwnerSignals({ ...args, readAgents: () => [],
        cloneRoots: () => [join(tmpdir(), 'fix-clone')], listLogs: () => [source.startsWith('review-') ? 'review-daemon.log' : 'fix-dispatch-daemon.log'],
        readTail: () => line ? `${new Date(tick).toISOString()} ${line}` : '',
        readHealth: () => source === 'health' ? { daemons: { 'fix-dispatch-daemon': { prRefusals: {
          'we#12': { at: tick, reason: 'refused no-lane: no acquirable lane' },
        } } } } : {} }),
    });
    expect(out.errors).toEqual([]);
    expect(out.idle[0].state).toBe('none');
    expect(out.idle[0].ownerLastSeenAt).toBeNull();
    previous = out.nextState; alerts.push(...out.alerts);
  }
  expect(alerts).toHaveLength(1);
  expect(previous.episodes[`${pr.repo}#12`].alerted).toBe(true);
});
it.each(['plateauapp/plateau-app#12', 'plateauapp/plateau-app PR #12', 'https://github.com/plateauapp/plateau-app/pull/12'])('binds explicit repository reference %s across clones', async (ref) => {
  const plateau = { ...pr, repo: 'plateauapp/plateau-app' }; const errors = [];
  const signals = await collectOwnerSignals({ prs: [pr, plateau], dir: tmpdir(), env: {}, errors,
    readAgents: () => [], cloneRoots: () => [join(tmpdir(), 'we-fix-clone')], listLogs: () => ['fix-dispatch-daemon.log'],
    readTail: () => `${new Date(now - 1000).toISOString()} reconcile-fix-dispatch-daemon: refused no-lane ${ref} — no acquirable lane`,
    readHealth: () => ({}) });
  expect(errors).toEqual([]);
  expect(signals[`${pr.repo}#12`].daemons).toEqual([]);
  expect(signals[`${plateau.repo}#12`].daemons).toHaveLength(1);
  expect(resolveOwner(plateau, { now, ...settings, ...signals[`${plateau.repo}#12`] }).state).toBe('none');
});
it('ignores refusal evidence without hiding real sessions, daemon progress or health smells', () => {
  const refusal = { name: 'fix-dispatch-daemon', at: now, reason: 'no-lane' };
  expect(resolveOwner(pr, { now, daemons: [refusal] }).state).toBe('none');
  expect(resolveOwner(pr, { now, daemons: [{ ...refusal, kind: 'refusal', reason: undefined }] }).state).toBe('none');
  expect(resolveOwner(pr, { now, daemons: [{ ...refusal, kind: 'diagnostic', reason: undefined }] }).state).toBe('none');
  expect(resolveOwner(pr, { now, daemons: [refusal], sessions: [running()] }).owner).toBe('session:fix-12');
  const progress = { name: 'review', at: now - 1000 };
  expect(resolveOwner(pr, { now, daemons: [refusal, progress] }).owner).toBe('daemon:review');
  expect(resolveOwner(pr, { now, daemons: [refusal, { ...progress, at: now - 100 * 60000 }] }).state).toBe('stuck');
  expect(resolveOwner(pr, { now, daemons: [refusal], smell: 'fixer-stuck' }).state).toBe('stuck');
});
it.each([
  ['PR #12 started', 'we'], ['fixing-12 started', 'we'],
  ['plateau-app PR #12 started', 'plateau-app'], ['PLATEAUAPP/PLATEAU-APP PR #12 started', 'plateau-app'],
  ['chalbert/plateau-app#12 started', 'plateau-app'], ['plateauapp/plateau-app #12 started', 'plateau-app'],
  ['other/repo PR #12 started', null], ['other/plateau-app#12 started', null],
  ['plateauapp/plateau-app PR #123 started', null],
  ['plateauapp/plateau-app#12 dispatched as session', 'plateau-app'],
  ['plateauapp/plateau-app PR #12 — applied rerun', 'plateau-app'],
  ['we#12 tagged review-status:fixing at dispatch', 'we'],
])('matches daemon reference %s only to %s', async (ref, repo) => {
  const plateau = { ...pr, repo: 'plateauapp/plateau-app' }; const errors = [];
  const signals = await collectOwnerSignals({ prs: [pr, plateau], dir: tmpdir(), env: {}, errors,
    readAgents: () => [], cloneRoots: () => [join(tmpdir(), 'we-fix-clone')], listLogs: () => ['review-daemon.log'],
    readTail: () => `${new Date(now - 1000).toISOString()} ${ref}`, readHealth: () => ({}) });
  expect(errors).toEqual([]);
  expect(signals[`${pr.repo}#12`].daemons).toHaveLength(repo === 'we' ? 1 : 0);
  expect(signals[`${plateau.repo}#12`].daemons).toHaveLength(repo === 'plateau-app' ? 1 : 0);
  expect(resolveOwner(pr, { now, ...settings, ...signals[`${pr.repo}#12`] }).state).toBe(repo === 'we' ? 'active' : 'none');
  expect(resolveOwner(plateau, { now, ...settings, ...signals[`${plateau.repo}#12`] }).state).toBe(repo === 'plateau-app' ? 'active' : 'none');
});
describe('PR sweep', () => {
  it('includes idle drafts and preserves head, labels; excludes moved/closed/invalid dates', () => {
    expect(classifyIdlePrs({ prs: [pr, { ...pr, number: 2, updatedAt: new Date(now).toISOString() }, { ...pr, state: 'CLOSED' }, { ...pr, updatedAt: 'bad' }], now, idleMinutes: 45 })).toEqual([{ ...pr, ageMin: 120 }]);
  });
  it('binds sessions, recent daemons, stale owner and smell; operator wins', () => {
    expect(resolveOwner(pr, { now, ...settings, sessions: [running()] }).owner).toBe('session:fix-12');
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
  it('keeps healthy sessions active, never unknown-pid ones, and falls back from unhealthy ones to daemon evidence', () => {
    for (const health of [{}, { hung: false, pidAlive: true }]) {
      expect(resolveOwner(pr, { now, ...settings, sessions: [running(now, health)] }).state).toBe('active');
    }
    expect(resolveOwner(pr, { now, ...settings, sessions: [running(now, { pidAlive: null })] }).state).toBe('none');
    const unhealthy = running(now, { hung: true });
    expect(resolveOwner(pr, { now, ...settings, sessions: [unhealthy, running(now, { name: 'review-12' })] }).owner).toBe('session:review-12');
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
it('a failed NEEDS YOU send keeps the previous set so the next sweep alerts again', async () => {
  const added = { ...pr, number: 13, repo: pr.repo };
  const tick = (notify) => runPrSweep({ now, config: {}, settings: { value: settings, sources: {} }, readPrevious: () => ({ episodes: {}, needsYou: [] }),
    readPrs: () => [], readSignals: () => ({}), readQueue: () => ({ ready: [added], rulingNeeded: [] }), notify, flush: () => {}, persist: () => {}, append: () => {} });
  const failed = await tick(() => ({ ok: false, error: 'transport failed' }));
  expect(failed.alerts.map((a) => a.kind)).toEqual(['needs-you']); expect(failed.nextState.needsYou).toEqual([]);
  const sent = await tick(() => ({ ok: true }));
  expect(sent.alerts.map((a) => a.kind)).toEqual(['needs-you']); expect(sent.nextState.needsYou).toEqual([`${pr.repo}#13`]);
});
it('writes an atomic durable report and a single ET handoff line', async () => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'pr-sweep-report-')); const lines = [];
  // The sweep never writes health `episodes` or `daemons`: health state.json is left byte-identical.
  const health = `${JSON.stringify({ episodes: { e: { status: 'open' } }, daemons: { review: {} } })}\n`;
  writeFileSync(join(dir, 'state.json'), health);
  try {
    const out = await runPrSweep({ dir, config: {}, now, settings: { value: settings, sources: { enabled: 'tool' } }, readPrevious: () => ({}), readPrs: () => [pr], readSignals: () => ({}), readQueue: () => ({ ready: [pr], rulingNeeded: [] }), flush: () => {}, notify: () => { throw new Error('unexpected notification'); }, append: (line) => lines.push(line) });
    expect(JSON.parse(readFileSync(join(dir, 'pr-sweep.json'), 'utf8'))).toEqual(out);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(health);
    expect(readdirSync(dir).sort()).toEqual(['pr-sweep.json', 'state.json']); expect(lines).toHaveLength(1); expect(lines[0]).toContain('ET idle=1');
    expect(out.idle[0].state).toBe('waiting-operator');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Operator send-back on PR #5323: finished fixers are listed idle/offline/blocked, not done.
const running = (at = now, o = {}) => ({ name: 'fix-12', state: 'working', status: 'busy', pidAlive: true, lastActivityAt: at - 60000, ...o });
describe('only an actively running session owns a PR', () => {
  it.each([
    ['idle fixer', { status: 'idle' }], ['offline fixer', { status: 'offline' }],
    ['offline fixer with no state', { state: undefined, status: 'offline' }], ['blocked fixer', { state: 'blocked', status: 'idle' }],
    ['waiting session', { state: undefined, status: 'waiting' }], ['unknown state', { state: 'mystery', status: undefined }],
    ['no state at all', { state: undefined, status: undefined }], ['unprobed pid', { pidAlive: undefined }],
    ['idle-finished', { idleFinished: true }], ['self-reported done', { selfReportedDone: true }], ['auth expired', { authExpired: true }],
  ])('%s on an idle PR yields a no-owner alert', async (_label, shape) => {
    for (const repo of [pr.repo, 'plateauapp/plateau-app']) {
      const key = `${repo}#12`; const tag = repo === pr.repo ? '' : 'pa-';
      let previous = {}; const alerts = [];
      for (const minutes of [0, 30, 60, 90, 120, 240]) {
        const tick = now + minutes * 60000;
        const out = await runPrSweep({ now: tick, dryRun: true, config: {}, settings: { value: { ...settings, repos: [repo] }, sources: {} },
          readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => previous,
          readSignals: () => ({ [key]: { sessions: [running(tick, { name: `fix-${tag}12`, ...shape })] } }) });
        expect(out.idle[0].state).toBe('none');
        previous = out.nextState; alerts.push(...out.alerts);
      }
      expect(alerts).toHaveLength(1);
      expect(alerts[0].key).toBe(key);
    }
  });
  it('a busy fixer whose activity is older than the window stops owning and the stall alerts', async () => {
    let previous = {}; const alerts = []; const started = now - 60000;
    for (const minutes of [0, 30, 60, 90, 120, 240]) {
      const tick = now + minutes * 60000;
      const out = await runPrSweep({ now: tick, dryRun: true, config: {}, settings: { value: { ...settings, sessionActiveWithinMinutes: 20 }, sources: {} },
        readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => previous,
        readSignals: () => ({ [`${pr.repo}#12`]: { sessions: [running(now, { lastActivityAt: started, startedAt: started })] } }) });
      expect(out.idle[0].state).toBe(minutes === 0 ? 'active' : 'none');
      previous = out.nextState; alerts.push(...out.alerts);
    }
    expect(alerts).toHaveLength(1);
  });
  it('owns while busy, alive and recently active; recent start counts as activity', () => {
    const o = { now, ...settings, sessionActiveWithinMinutes: 30 };
    expect(resolveOwner(pr, { ...o, sessions: [running()] })).toMatchObject({ owner: 'session:fix-12', state: 'active' });
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { state: undefined })] }).state).toBe('active');
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { status: undefined, lastActivityAt: new Date(now - 60000).toISOString() })] }).state).toBe('active');
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { lastActivityAt: undefined, startedAt: now - 5 * 60000 })] }).state).toBe('active');
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { lastActivityAt: undefined, startedAt: now - 31 * 60000 })] }).state).toBe('none');
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { lastActivityAt: now - 31 * 60000 })] }).state).toBe('none');
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { lastActivityAt: 'garbage' })] }).state).toBe('none');
    expect(resolveOwner(pr, { ...o, sessions: [running(now, { status: 'idle' }), running(now, { name: 'review-12' })] }).owner).toBe('session:review-12');
  });
  it('reads transcript activity only for busy, live-pid rows', async () => {
    const seen = []; const errors = [];
    const rows = [running(now, { lastActivityAt: undefined, sessionId: 'a' }), running(now, { status: 'idle', lastActivityAt: undefined, sessionId: 'b' }),
      running(now, { pidAlive: false, lastActivityAt: undefined, sessionId: 'c' })];
    const signals = await collectOwnerSignals({ prs: [pr], dir: tmpdir(), env: {}, errors, readAgents: () => rows,
      readActivity: (a) => { seen.push(a.sessionId); return now - 2000; }, cloneRoots: () => [], readHealth: () => ({}) });
    expect(errors).toEqual([]); expect(seen).toEqual(['a']);
    expect(signals[`${pr.repo}#12`].sessions[0].lastActivityAt).toBe(now - 2000);
    expect(resolveOwner(pr, { now, ...settings, ...signals[`${pr.repo}#12`] }).state).toBe('active');
  });
  const sweepWith = (listing, previous, tick = now + 100 * 60000, readActivity = () => null) => runPrSweep({ now: tick, dryRun: true, config: {},
    settings: { value: settings, sources: {} }, readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => previous,
    readSignals: (args) => collectOwnerSignals({ ...args, readAgents: () => listing, readActivity, cloneRoots: () => [], readHealth: () => ({}) }) });
  const gapped = (...gaps) => Object.defineProperty([], 'incomplete', { value: gaps });
  it('an unreadable record pauses only its own PR; an unscoped gap pauses the whole read', async () => {
    const first = plan();
    const own = await sweepWith(gapped({ reason: 'wrapped record fix-12 unreadable', session: 'fix-12' }), first.nextState);
    expect(own.errors).toEqual([]); expect(own.idle[0].state).toBe('unknown'); expect(own.alerts).toEqual([]);
    expect(own.nextState.episodes).toEqual(first.nextState.episodes);
    const other = await sweepWith(gapped({ reason: 'wrapped record fix-13 unreadable', session: 'fix-13' }), first.nextState);
    expect(other.errors).toEqual([]); expect(other.alerts).toHaveLength(1);
    for (const session of ['harvest-x', 'conveyor-12', 'fix-pa-12']) {
      const unbound = await sweepWith(gapped({ reason: `wrapped record ${session} unreadable`, session }), first.nextState);
      expect(unbound.errors).toEqual([]); expect(unbound.idle[0].state).toBe('none'); expect(unbound.alerts).toHaveLength(1);
    }
    expect((await sweepWith(gapped({ reason: 'x', session: 'conflict-12' }), first.nextState)).idle[0].state).toBe('unknown');
    const unscoped = await sweepWith(gapped({ reason: 'completion store row unreadable' }), first.nextState);
    expect(unscoped.errors.join(' ')).toContain('agent listing incomplete'); expect(unscoped.alerts).toEqual([]);
    expect(unscoped.nextState.episodes).toEqual(first.nextState.episodes);
    // A record that stays unreadable still alerts once the doubled wait passes.
    const blind = await sweepWith(gapped({ reason: 'wrapped record fix-12 unreadable', session: 'fix-12' }), first.nextState, now + 181 * 60000);
    expect(blind.idle[0].state).toBe('unknown'); expect(blind.alerts).toHaveLength(1);
    expect(blind.alerts[0].body).toContain('Bound session could not be read');
  });
  it('a busy live job with no readable transcript is unknown, never a false stall or a forever owner', async () => {
    const first = plan();
    const job = running(now, { name: 'review-12', sessionId: null, lastActivityAt: undefined, startedAt: now + 60 * 60000 });
    const report = await sweepWith([job], first.nextState);
    expect(report.errors).toEqual([]); expect(report.idle[0].state).toBe('unknown'); expect(report.alerts).toEqual([]);
    expect(report.nextState.episodes).toEqual(first.nextState.episodes);
    const thrown = await sweepWith([job], first.nextState, now + 100 * 60000, () => { throw new Error('tail read failed'); });
    expect(thrown.idle[0].state).toBe('unknown'); expect(thrown.alerts).toEqual([]);
    expect((await sweepWith([{ ...job, pidAlive: false }], first.nextState)).alerts).toHaveLength(1);
    // Unknown is bounded: a job started 4 h ago with no readable activity no longer holds the PR.
    const wedged = await sweepWith([{ ...job, startedAt: now - 140 * 60000 }], first.nextState);
    expect(wedged.idle[0].state).toBe('none'); expect(wedged.alerts).toHaveLength(1);
    // An unnamed busy row binds to every web-everything PR but must not make them unreadable.
    const unnamed = await sweepWith([{ ...job, name: 'Assistant' }], first.nextState);
    expect(unnamed.idle[0].state).toBe('none'); expect(unnamed.alerts).toHaveLength(1);
    expect(resolveOwner(pr, { now, sessions: [running(now, { lastActivityAt: now + 10 * 60 * 60000 })] }).state).toBe('none');
    expect(resolveOwner(pr, { now, sessions: [running(now, { lastActivityAt: String(now - 60000) })] }).state).toBe('active');
  });
  it('the default reader scopes unreadable or torn wrapped records to their sessions', async () => {
    const { readSweepAgents } = await import('../pr-sweep.mjs');
    const gaps = [{ reason: 'wrapped record fix-12 unreadable', session: 'fix-12' }];
    const torn = await readSweepAgents({ listWrapped: () => Object.defineProperty([], 'incomplete', { value: gaps }), readRows: () => [running()] });
    expect(torn).toHaveLength(1); expect(torn.incomplete).toEqual(gaps);
    expect((await readSweepAgents({ listWrapped: () => [running()], readRows: () => [running()] })).incomplete).toBeUndefined();
    const missing = await readSweepAgents({ listWrapped: () => [running(now, { name: 'fix-14' })], readRows: () => [running()] });
    expect(missing.incomplete).toEqual([{ reason: 'wrapped session fix-14 missing from the agent listing', session: 'fix-14' }]);
    const errors = [];
    const signals = await collectOwnerSignals({ prs: [pr], dir: tmpdir(), env: {}, errors, readAgents: () => torn, readActivity: () => now, cloneRoots: () => [], readHealth: () => ({}) });
    expect(errors).toEqual([]); expect(signals[`${pr.repo}#12`].unreadSessions).toEqual(['fix-12']);
    expect(resolveOwner(pr, { now, ...signals[`${pr.repo}#12`] }).state).toBe('active');
    expect(resolveOwner(pr, { now, ...signals[`${pr.repo}#12`], sessions: [] }).state).toBe('unknown');
  });
});
