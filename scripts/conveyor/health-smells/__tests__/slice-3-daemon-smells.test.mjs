/**
 * @file scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs
 * @description #4068 — the daemon-code smells (self-sync conflict, stale live-process bindings, drain pass over
 *   budget, drain merge rate dropping), each driven through the slice-1 core (`runHealthTick`) on breach and clean
 *   fixtures; their two new probes (`probeStaleLiveSessions`, `probeDrainHistory`); and a whole fixture `tick()`
 *   that feeds a daemon log and a drain history file through the real registry. (Clone behind main and smoke-gate
 *   failure are `clone-stale`/`daemon-held-on-last-good`, tested in their own files.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHealthTick, emptyHealthState, MINUTE, HOUR } from '../../health-watch-core.mjs';
import { probeLiveBindings, prBoundSessionPr, probeDrainHistory, tick } from '../../health-watch.mjs';
import selfSyncConflict, { stuckSelfSyncLines } from '../self-sync-conflict.mjs';
import liveStale, { liveProcessRefusals } from '../live-process-stale-transcript.mjs';
import passOverBudget from '../drain-pass-over-budget.mjs';
import mergeRateDrop, { mergeRate } from '../drain-merge-rate-drop.mjs';
import { SMELLS } from '../index.mjs';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const TICK = 5 * MINUTE;

function ticks(smell, probesPerTick) {
  let state = emptyHealthState();
  let last;
  const opened = [];
  probesPerTick.forEach((probes, i) => {
    last = runHealthTick(state, probes, [smell], NOW + i * TICK);
    state = last.state;
    opened.push(...last.transitions.filter((t) => t.type === 'opened').map((t) => t.key));
  });
  return { last, state, opened };
}

describe('registry', () => {
  it('discovers all four slice-3 smells from disk', () => {
    const ids = SMELLS.map((s) => s.id);
    for (const id of ['self-sync-conflict', 'live-process-stale-transcript', 'drain-pass-over-budget', 'drain-merge-rate-drop']) expect(ids).toContain(id);
  });
});

// ── self-sync-conflict ────────────────────────────────────────────────────────────────────────────────────────

const PLAIN = 'daemon-self-sync: behind origin/main but NOT syncing (conflict) — needs a hand merge';
const POC = 'daemon-self-sync: [POC mode: poc/x] behind but NOT syncing (dirty) — needs a hand merge';
const NOISE = 'daemon-self-sync: rebuild did not move the clone (tick-in-progress) — ticking on the current code';
const log = (name, ...lines) => ({ name, text: `${lines.join('\n')}\n` });

describe('stuckSelfSyncLines', () => {
  it('matches both log shapes and ignores ordinary self-sync noise', () => {
    expect(stuckSelfSyncLines([NOISE, PLAIN, PLAIN].join('\n'))).toEqual({ count: 2, reasons: { conflict: 2 }, pocBranch: null });
    expect(stuckSelfSyncLines(POC)).toEqual({ count: 1, reasons: { dirty: 1 }, pocBranch: 'poc/x' });
    expect(stuckSelfSyncLines(NOISE).count).toBe(0);
    expect(stuckSelfSyncLines(undefined).count).toBe(0);
  });
});

describe('self-sync-conflict', () => {
  it('breach: the plain conflict line in a daemon log opens an episode for that daemon', () => {
    const { opened, last } = ticks(selfSyncConflict, [{ daemonLogs: [log('review-daemon', NOISE, PLAIN), log('fix-dispatch-daemon', NOISE)], selfSync: [] }]);
    expect(opened).toEqual(['self-sync-conflict::daemon:review-daemon']);
    expect(last.state.episodes['self-sync-conflict::daemon:review-daemon'].recommendation).toMatch(/merge it by hand/);
  });

  it('breach: the POC dirty line names the branch and the dirty-tree fix', () => {
    const { last } = ticks(selfSyncConflict, [{ daemonLogs: [log('review-daemon', POC)], selfSync: [] }]);
    const ep = last.state.episodes['self-sync-conflict::daemon:review-daemon'];
    expect(ep.summary).toContain('POC poc/x');
    expect(ep.recommendation).toMatch(/local modifications/);
  });

  it('clean: only ordinary self-sync lines → no episode', () => {
    const { opened } = ticks(selfSyncConflict, [{ daemonLogs: [log('review-daemon', NOISE)], selfSync: [] }]);
    expect(opened).toEqual([]);
  });

  it('closes once the daemon stops printing the conflict line (closeAfter 3)', () => {
    const stuck = { daemonLogs: [log('review-daemon', PLAIN)], selfSync: [] };
    const fine = { daemonLogs: [log('review-daemon', NOISE)], selfSync: [] };
    const { state } = ticks(selfSyncConflict, [stuck, fine, fine, fine]);
    expect(state.episodes['self-sync-conflict::daemon:review-daemon']).toBeUndefined();
  });

  it('breach: a recent pinned-overlay-conflict alert; clean: an old one', () => {
    const alert = (minAgo) => ({ at: NOW - minAgo * MINUTE, kind: 'pinned-overlay-conflict', detail: { ref: 'lane/fix-x', pr: 2768, pinnedBy: 'mechanism' } });
    const recent = ticks(selfSyncConflict, [{ daemonLogs: [], selfSync: [{ cloneKey: 'abc', alerts: [alert(5)] }] }]);
    expect(recent.opened).toEqual(['self-sync-conflict::clone:abc']);
    expect(recent.last.state.episodes['self-sync-conflict::clone:abc'].recommendation).toContain('PR #2768');
    const old = ticks(selfSyncConflict, [{ daemonLogs: [], selfSync: [{ cloneKey: 'abc', alerts: [alert(120)] }] }]);
    expect(old.opened).toEqual([]);
  });
});

// ── live-process-stale-transcript ─────────────────────────────────────────────────────────────────────────────

const WE = 'web-everything/web-everything';
const refused = (pr, n = 1, repo = WE) => Array.from({ length: n }, () => `reconcile-fix-dispatch-daemon: reconcile-refused live-process ${repo} PR #${pr} — a bound session has a LIVE pid — something is already working this PR, however stale its transcript looks`);
const binding = (pr, idleMin, extra = {}) => ({ pr, repo: WE, name: `review-${pr}`, source: 'review-job', pid: 4242, lastActivityAgeMs: idleMin == null ? null : idleMin * MINUTE, reason: null, ...extra });

describe('liveProcessRefusals', () => {
  it('collects distinct repo/PR pairs with their counts, ignoring every other refusal kind', () => {
    const text = [...refused(2911, 3), ...refused(12, 1, 'frontier-ui/frontierui'), 'reconcile-fix-dispatch-daemon: reconcile-refused nothing-owed web-everything/web-everything PR #5 — x'].join('\n');
    expect(liveProcessRefusals([{ name: 'fix-dispatch-daemon', text }])).toEqual([
      { repo: WE, pr: 2911, count: 3 },
      { repo: 'frontier-ui/frontierui', pr: 12, count: 1 },
    ]);
  });
});

describe('live-process-stale-transcript', () => {
  it('breach: a PR refused live-process behind a review job idle for 2h (the job log has not moved)', () => {
    const { opened, last } = ticks(liveStale, [{ daemonLogs: [log('fix-dispatch-daemon', ...refused(2911, 4))], liveBindings: [binding(2911, 120), binding(7, 1)] }]);
    expect(opened).toEqual([`live-process-stale-transcript::pr:${WE}#2911`]);
    const ep = last.state.episodes[`live-process-stale-transcript::pr:${WE}#2911`];
    expect(ep.measure).toMatchObject({ refusals: 4, bindings: 1, freshestIdleMin: 120 });
    expect(ep.recommendation).toMatch(/ps -p 4242/);
  });

  it('clean: the binding is active (a review job writing its log right now) — a live-process refusal is correct', () => {
    expect(ticks(liveStale, [{ daemonLogs: [log('d', ...refused(2911))], liveBindings: [binding(2911, 2)] }]).opened).toEqual([]);
  });

  it('clean: judged on the FRESHEST binding — one stale and one active binding is still being worked', () => {
    const bindings = [binding(2911, 300), binding(2911, 3, { name: 'fix-2911', source: 'session', repo: null })];
    expect(ticks(liveStale, [{ daemonLogs: [log('d', ...refused(2911))], liveBindings: bindings }]).opened).toEqual([]);
  });

  it('clean: a stale binding whose PR is NOT being refused this tick is not this sign', () => {
    expect(ticks(liveStale, [{ daemonLogs: [log('d', 'nothing relevant')], liveBindings: [binding(2911, 300)] }]).opened).toEqual([]);
  });

  it('clean, never guessed: a refused PR with no bound row, or a row whose activity is unreadable', () => {
    const r = ticks(liveStale, [{ daemonLogs: [log('d', ...refused(2911), ...refused(8))], liveBindings: [binding(8, null)] }]);
    expect(r.opened).toEqual([]);
    expect(r.last.state.episodes[`live-process-stale-transcript::pr:${WE}#2911`]).toBeUndefined();
  });

  it('a binding from another repo never matches (same PR number, different repo)', () => {
    const other = binding(2911, 300, { repo: 'frontier-ui/frontierui' });
    const r = liveStale.evaluate({ daemonLogs: [log('d', ...refused(2911))], liveBindings: [other] }, { now: NOW });
    expect(r[0].measure.bindings).toBe(0);
  });

  it('a stale session pending on a tool call gets the blocked-child recommendation', () => {
    const s = binding(2735, 60, { name: 'fix-2735', source: 'session', repo: null, pid: null, reason: 'pending-foreground-call-within-grace' });
    const { last } = ticks(liveStale, [{ daemonLogs: [log('d', ...refused(2735))], liveBindings: [s] }]);
    expect(last.state.episodes[`live-process-stale-transcript::pr:${WE}#2735`].recommendation).toMatch(/tool call that never returned/);
  });

  it('is skipped (episodes do not move) on a tick where the gh-cadenced probe did not run', () => {
    const first = runHealthTick(emptyHealthState(), { daemonLogs: [log('d', ...refused(2911))], liveBindings: [binding(2911, 120)] }, [liveStale], NOW);
    const second = runHealthTick(first.state, { daemonLogs: [] }, [liveStale], NOW + TICK);
    expect(second.state.episodes[`live-process-stale-transcript::pr:${WE}#2911`].status).toBe('open');
  });
});

describe('probeLiveBindings', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hw-bind-')); mkdirSync(join(root, '.operations', 'review-jobs'), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const jobs = () => join(root, '.operations', 'review-jobs');
  const agent = (name, extra = {}) => ({ name, kind: 'background', state: 'working', cwd: `/lanes/${name}`, sessionId: `sid-${name}`, startedAt: '2026-09-24T09:00:00Z', ...extra });
  const readInfo = (a) => (a.name === 'fix-404' ? { hung: false, reason: 'no-signal', ageMs: null } : { hung: false, reason: 'pending-foreground-call-within-grace', ageMs: 50 * MINUTE });

  it('reads live review-job records (activity = newest of the job\'s own files), read-only, skipping dead pids and non-record json', () => {
    writeFileSync(join(jobs(), 'review-2911.json'), JSON.stringify({ slug: 'review-2911', pid: 100, pr: 2911, repo: WE }));
    writeFileSync(join(jobs(), 'review-2911.log'), 'x');
    writeFileSync(join(jobs(), 'review-2911.red-team.loop.json'), '{"pid":1,"pr":1}');
    writeFileSync(join(jobs(), 'review-9.json'), JSON.stringify({ slug: 'review-9', pid: 101, pr: 9, repo: WE }));
    const logMtime = Date.now();
    const out = probeLiveBindings([], { roots: [root, root], isAlive: (pid) => pid === 100, nowMs: logMtime + 70 * MINUTE });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pr: 2911, repo: WE, name: 'review-2911', source: 'review-job', pid: 100 });
    expect(out[0].lastActivityAgeMs).toBeGreaterThanOrEqual(69 * MINUTE);
    expect(existsSync(join(jobs(), 'review-9.json'))).toBe(true); // never pruned
  });

  it('keeps only PR-bound, unfinished background sessions; conveyor/prepare names end in a backlog number, not a PR', () => {
    const agents = [
      agent('fix-2735'), agent('ci-heal-2711'), agent('review-12', { pid: 7 }),
      agent('conveyor-3412'), agent('prepare-3438'), agent('fix-1', { state: 'done' }), agent('fix-2', { state: 'stopped' }),
      agent('fix-3', { pid: 8 }), agent('fix-4', { kind: 'interactive' }), agent('fix-404'),
    ];
    const out = probeLiveBindings(agents, { roots: [], readInfo, isAlive: (pid) => pid === 7, nowMs: NOW });
    expect(out.map((b) => b.name)).toEqual(['fix-2735', 'ci-heal-2711', 'review-12', 'fix-404']);
    expect(out[0]).toMatchObject({ pr: 2735, source: 'session', pid: null, lastActivityAgeMs: 50 * MINUTE, reason: 'pending-foreground-call-within-grace' });
    expect(out[3].lastActivityAgeMs).toBeNull();
  });

  it('prBoundSessionPr', () => {
    expect(prBoundSessionPr('fix-2735')).toBe(2735);
    expect(prBoundSessionPr('ci-heal-2711')).toBe(2711);
    expect(prBoundSessionPr('conveyor-3412')).toBeNull();
    expect(prBoundSessionPr('fix-2735b')).toBeNull();
    expect(prBoundSessionPr(undefined)).toBeNull();
  });

  it('a transcript reader that throws keeps the row with unreadable activity instead of failing the probe', () => {
    const out = probeLiveBindings([agent('fix-5')], { roots: [], readInfo: () => { throw new Error('x'); }, nowMs: NOW });
    expect(out).toEqual([expect.objectContaining({ name: 'fix-5', lastActivityAgeMs: null })]);
  });

  it('feeds the smell end to end: a real job record on disk + a refusal line → breach', () => {
    writeFileSync(join(jobs(), 'review-2911.json'), JSON.stringify({ slug: 'review-2911', pid: 100, pr: 2911, repo: WE }));
    const liveBindings = probeLiveBindings([], { roots: [root], isAlive: () => true, nowMs: Date.now() + 2 * HOUR });
    const { opened } = ticks(liveStale, [{ daemonLogs: [log('d', ...refused(2911))], liveBindings }]);
    expect(opened).toEqual([`live-process-stale-transcript::pr:${WE}#2911`]);
  });
});

// ── drain history fixtures ────────────────────────────────────────────────────────────────────────────────────

/** One pass every 2 minutes over `hours`, newest last; `fn(minAgo)` overrides fields per pass. */
function history(hours, fn = () => ({})) {
  const out = [];
  for (let m = hours * 60; m >= 0; m -= 2) out.push({ at: NOW - m * MINUTE, ms: 17_000, exit: 0, considered: 0, merged: 0, deferred: 0, failed: 0, ...fn(m) });
  return out;
}

describe('drain-pass-over-budget', () => {
  it('breach: several passes over the 3-minute budget in the last 30 minutes', () => {
    const h = history(1, (m) => (m <= 20 && m % 6 === 0 ? { ms: 5 * MINUTE } : {}));
    const { opened, last } = ticks(passOverBudget, [{ drainHistory: h }]);
    expect(opened).toEqual(['drain-pass-over-budget::drain']);
    expect(last.state.episodes['drain-pass-over-budget::drain'].measure.overBudget).toBe(4);
  });

  it('breach: one extreme latest pass (24 minutes) is enough on its own', () => {
    const h = history(1, (m) => (m === 0 ? { ms: 24 * MINUTE } : {}));
    expect(ticks(passOverBudget, [{ drainHistory: h }]).opened).toEqual(['drain-pass-over-budget::drain']);
  });

  it('clean: ordinary passes, and a single slow-but-not-extreme pass', () => {
    expect(ticks(passOverBudget, [{ drainHistory: history(1) }]).opened).toEqual([]);
    const one = history(1, (m) => (m === 10 ? { ms: 4 * MINUTE } : {}));
    expect(ticks(passOverBudget, [{ drainHistory: one }]).opened).toEqual([]);
  });

  it('no drain on this host (null probe) or no recent passes → no subject at all', () => {
    expect(passOverBudget.evaluate({ drainHistory: null }, { now: NOW })).toEqual([]);
    expect(passOverBudget.evaluate({ drainHistory: history(1).map((p) => ({ ...p, at: p.at - 2 * HOUR })) }, { now: NOW })).toEqual([]);
  });
});

describe('drain-merge-rate-drop', () => {
  // Baseline: 3 merges/hour for the 6 hours before the last one (one merge every 20 minutes).
  const baseline = (m) => (m > 60 && m % 20 === 0 ? { considered: 1, merged: 1 } : {});

  it('mergeRate splits the window from its baseline and counts waiting passes', () => {
    const r = mergeRate(history(7, (m) => (m <= 60 && m % 10 === 0 ? { considered: 2, merged: 0, deferred: 2 } : baseline(m))), { now: NOW });
    expect(r.recentMerged).toBe(0);
    expect(r.baselinePerHour).toBe(3);
    expect(r.waitingPasses).toBe(7);
    expect(r.baselineCovered).toBe(true);
  });

  it('breach: no merges in the last hour while PRs are considered and deferred, against a 3/h baseline (two samples)', () => {
    const h = history(7, (m) => (m <= 60 && m % 10 === 0 ? { considered: 2, merged: 0, deferred: 2 } : baseline(m)));
    const { opened, last } = ticks(mergeRateDrop, [{ drainHistory: h }, { drainHistory: h.map((p) => ({ ...p, at: p.at + TICK })) }]);
    expect(opened).toEqual(['drain-merge-rate-drop::drain']);
    expect(last.state.episodes['drain-merge-rate-drop::drain'].measure).toMatchObject({ recentMerged: 0, baselinePerHour: 3 });
  });

  it('clean: a quiet hour with nothing waiting is not a drop', () => {
    const h = history(7, baseline);
    expect(ticks(mergeRateDrop, [{ drainHistory: h }, { drainHistory: h }]).opened).toEqual([]);
  });

  it('clean: the drain keeps its pace', () => {
    const h = history(7, (m) => (m % 20 === 0 ? { considered: 1, merged: 1 } : {}));
    expect(ticks(mergeRateDrop, [{ drainHistory: h }, { drainHistory: h }]).opened).toEqual([]);
  });

  it('clean: history too short to cover the baseline (a freshly restarted drain)', () => {
    const h = history(2, (m) => (m <= 60 && m % 10 === 0 ? { considered: 2, merged: 0 } : baseline(m)));
    expect(ticks(mergeRateDrop, [{ drainHistory: h }, { drainHistory: h }]).opened).toEqual([]);
  });
});

// ── probeDrainHistory + the whole tick ────────────────────────────────────────────────────────────────────────

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hw-slice3-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const toJsonl = (h) => `${h.map((p) => JSON.stringify({ ...p, at: new Date(p.at).toISOString(), mergedPrs: [], consideredPrs: [] })).join('\n')}\n`;

describe('probeDrainHistory', () => {
  it('reads the real history.jsonl shape, trimmed to the window and the fields the smells read', () => {
    const path = join(dir, 'history.jsonl');
    writeFileSync(path, toJsonl(history(9)));
    const out = probeDrainHistory({ path, nowMs: NOW });
    expect(out.length).toBeGreaterThan(0);
    expect(Math.min(...out.map((p) => p.at))).toBeGreaterThanOrEqual(NOW - 7 * HOUR);
    expect(Object.keys(out[0]).sort()).toEqual(['at', 'considered', 'deferred', 'exit', 'failed', 'merged', 'ms']);
  });

  it('no file → null (no drain on this host), not an empty history', () => {
    expect(probeDrainHistory({ path: join(dir, 'missing.jsonl'), nowMs: NOW })).toBeNull();
  });
});

describe('tick() — a daemon log and a drain history reach the slice-3 smells through the real registry', () => {
  function base() {
    for (const d of ['logs', 'locks', 'sync']) mkdirSync(join(dir, d), { recursive: true });
    return { 'logs-dir': join(dir, 'logs'), 'lock-root': join(dir, 'locks'), 'self-sync-dir': join(dir, 'sync'), 'state-root': join(dir, 'state'), 'no-gh': true, 'no-diagnose': true, 'no-investigate': true, 'no-file': true };
  }

  it('a conflict line and slow drain passes open both episodes in one fixture tick', async () => {
    const flags = base();
    writeFileSync(join(dir, 'logs', 'review-daemon.log'), `${NOISE}\n${PLAIN}\n`);
    const drain = join(dir, 'history.jsonl');
    writeFileSync(drain, toJsonl(history(1, (m) => (m <= 20 && m % 6 === 0 ? { ms: 5 * MINUTE } : {}))));
    const summary = await tick({ ...flags, now: new Date(NOW).toISOString(), 'drain-history': drain });
    const opened = summary.transitions.map((t) => t.key);
    expect(opened).toContain('self-sync-conflict::daemon:review-daemon');
    expect(opened).toContain('drain-pass-over-budget::drain');
  });

  it('a fixture tick with no --drain-history never reads the host drain file', async () => {
    const summary = await tick({ ...base(), now: new Date(NOW).toISOString() });
    expect(summary.transitions.filter((t) => t.key.startsWith('drain-'))).toEqual([]);
  });
});
