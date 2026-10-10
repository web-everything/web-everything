/**
 * @file scripts/lib/__tests__/daemon-background-build.test.mjs
 * @description x44lnnt — the fix daemon's tick starved behind its own inline rebuild (live 2026-10-09: no completed
 *   tick 06:03Z→07:11Z). Pure rules, the declared settings, a replay of tonight's log, and a simulation of
 *   `withSelfSync` over a fast-moving `main` with tonight's real smoke durations: zero ticks inline (before #4126),
 *   ticks on schedule on the rebuild JOB path, swaps only between ticks and at most once per window.
 *   x0m7a8x (card 5691): the background BUILDER process is retired — the detached rebuild job (#4126) builds off
 *   the tick path and the tick adopts its result at once (no 5-min builder coalesce). The builder helpers below
 *   stay tested until the follow-up removes them; the re-clone fail-closed rule now lives in daemon-self-sync.mjs.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILT_IN_BACKGROUND_BUILD_SETTINGS, validateBackgroundBuildSettings, loadBackgroundBuildSettings,
  resolveBackgroundBuild, decideBuilderStart, tickStarvedSmell, builderIsAlive, builderRunFinished,
  spawnBuilder, readBuilderState, writeBuilderState,
} from '../daemon-background-build.mjs';
import { summarizeRebuildResult, parseBuilderArgs, writeBuilderStateIfOwner, deadlineRecord } from '../daemon-rebuild-builder.mjs';
import {
  withSelfSync, memoryRecloneMarkerStore, makeRecloneMarkerStore, recloneMarkerPath, recloneConcluded, resultReportsReclone,
  resolveSelfSyncRebuildAsJob, listRebuildJobIds,
  UNREADABLE_RECLONE_MARKER,
} from '../daemon-self-sync.mjs';
import { REBUILD_JOB_KIND } from '../daemon-rebuild/rebuild-job.mjs';
import { createJobStore, enqueueJob } from '../daemon-jobs-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/background-build/fix-daemon-2026-10-09.json'), 'utf8'));
const MIN = 60_000;
const ms = (iso) => Date.parse(iso);

describe('settings — off = today', () => {
  it('built-in default enables no daemon', () => {
    expect(BUILT_IN_BACKGROUND_BUILD_SETTINGS.enabled).toEqual({});
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/review-daemon.mjs' }).enabled).toBe(false);
  });
  it('the committed file turns it on for the fix and review daemons only (card 5673 added the review daemon)', () => {
    const s = loadBackgroundBuildSettings();
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs', settings: s }).enabled).toBe(true);
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/review-daemon.mjs', settings: s }).enabled).toBe(true);
    expect(resolveBackgroundBuild({ entry: '/c/skills-src/conveyor/pass-daemon.mjs', settings: s }).enabled).toBe(false);
  });
  it('env forces on/off and overrides numbers; malformed values keep the file/default', () => {
    const s = { enabled: { 'a.mjs': true }, swapMinIntervalMs: 5 };
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: s, env: { WE_DAEMON_BACKGROUND_BUILD: '0' } }).enabled).toBe(false);
    expect(resolveBackgroundBuild({ entry: 'b.mjs', settings: s, env: { WE_DAEMON_BACKGROUND_BUILD: '1' } }).enabled).toBe(true);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: s, env: { WE_DAEMON_BACKGROUND_BUILD_SWAP_MIN_INTERVAL_MS: 'x' } }).swapMinIntervalMs).toBe(5);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: s, env: { WE_DAEMON_TICK_STARVED_SMELL_MS: '0' } }).tickStarvedSmellMs).toBe(0);
    expect(validateBackgroundBuildSettings({ enabled: { 'a/b': true }, buildMinIntervalMs: -1 })).toEqual({ ...BUILT_IN_BACKGROUND_BUILD_SETTINGS });
  });
});

describe('decideBuilderStart — pure', () => {
  const base = { enabled: true, builderAlive: false, lastStartedAtMs: null, swapPending: false, nowMs: 100 * MIN, buildMinIntervalMs: 5 * MIN };
  it('off never starts', () => expect(decideBuilderStart({ ...base, enabled: false })).toEqual({ start: false, reason: 'off' }));
  it('one builder at a time', () => expect(decideBuilderStart({ ...base, builderAlive: true }).reason).toBe('builder-running'));
  it('no new build while a built version waits for the swap', () => expect(decideBuilderStart({ ...base, swapPending: true }).reason).toBe('swap-pending'));
  it('coalesces starts within the window', () => expect(decideBuilderStart({ ...base, lastStartedAtMs: 97 * MIN }).reason).toBe('coalesce'));
  it('due otherwise', () => expect(decideBuilderStart({ ...base, lastStartedAtMs: 90 * MIN })).toEqual({ start: true, reason: 'due' }));
});

describe('tickStarvedSmell — pure', () => {
  const t = 30 * MIN;
  it('off at 0', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 0, nowMs: 99 * MIN, lastAdoptedAtMs: 50 * MIN, thresholdMs: 0 }).starved).toBe(false));
  it('ticking recently is not starved', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 80 * MIN, nowMs: 90 * MIN, lastAdoptedAtMs: 85 * MIN, thresholdMs: t }).reason).toBe('ticking'));
  it('a long gap WITHOUT an adoption since is some other stall', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 0, nowMs: 90 * MIN, lastAdoptedAtMs: null, thresholdMs: t }).reason).toBe('no-adoption-since'));
  it('a long gap while rebuilds adopt is starved', () => expect(tickStarvedSmell({ lastTickDoneAtMs: 0, nowMs: 40 * MIN, lastAdoptedAtMs: 35 * MIN, thresholdMs: t })).toMatchObject({ starved: true, sinceTickMs: 40 * MIN }));
  it('never ticked: measured from first seen', () => expect(tickStarvedSmell({ lastTickDoneAtMs: NaN, firstSeenAtMs: 0, nowMs: 40 * MIN, lastAdoptedAtMs: 1, thresholdMs: t }).starved).toBe(true));
});

describe('builder helpers', () => {
  it('builderIsAlive: unfinished + same host + live pid + younger than the max age', () => {
    const o = { host: 'h', isAlive: () => true, nowMs: 100 * MIN, maxAgeMs: 90 * MIN };
    const startedAt = new Date(95 * MIN).toISOString();
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt }, o)).toBe(true);
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt, finishedAt: 'x' }, o)).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'other', startedAt }, o)).toBe(false);
    expect(builderIsAlive(null)).toBe(false);
  });
  it('builderIsAlive: a stale unfinished record with a live-looking pid is NOT alive (pid reuse after SIGKILL / reboot)', () => {
    const o = { host: 'h', isAlive: () => true, nowMs: 300 * MIN, maxAgeMs: 90 * MIN };
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(100 * MIN).toISOString() }, o)).toBe(false);
    // exactly at the bound is still alive; a record whose age cannot be read cannot be bounded, so it is not trusted
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(210 * MIN).toISOString() }, o)).toBe(true);
    expect(builderIsAlive({ pid: 1, host: 'h' }, o)).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: 'garbage' }, o)).toBe(false);
  });
  it('the age bound is a declared setting (built-in default, file/env override), not a magic number', () => {
    expect(BUILT_IN_BACKGROUND_BUILD_SETTINGS.builderMaxAgeMs).toBeGreaterThan(30 * MIN);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', settings: { builderMaxAgeMs: 7 } }).builderMaxAgeMs).toBe(7);
    expect(resolveBackgroundBuild({ entry: 'a.mjs', env: { WE_DAEMON_BACKGROUND_BUILD_MAX_AGE_MS: '9' } }).builderMaxAgeMs).toBe(9);
    expect(loadBackgroundBuildSettings().builderMaxAgeMs).toBeGreaterThan(30 * MIN);
  });
  it('summarize + args', () => {
    expect(summarizeRebuildResult({ moved: true, adopted: true, head: 'abc', alerts: [1] })).toEqual({ moved: true, adopted: true, reason: 'adopted', head: 'abc' });
    expect(summarizeRebuildResult(null).reason).toBe('no-result');
    expect(parseBuilderArgs(['--root=/c', '--entry=/c/a.mjs', '--main-only'])).toEqual({ root: '/c', entries: ['/c/a.mjs'], mainOnly: true, maxAgeMs: 0 });
    expect(parseBuilderArgs(['--root=/c', '--max-age-ms=5400000']).maxAgeMs).toBe(5_400_000);
    expect(parseBuilderArgs(['--root=/c', '--max-age-ms=junk']).maxAgeMs).toBe(0);
  });
});

describe('replay — tonight\'s fix-daemon log (2026-10-09)', () => {
  const ev = FIXTURE.events;
  it('BEFORE: the longest gap between completed ticks was over an hour', () => {
    const ticks = ev.filter((e) => e.kind === 'tick-done').map((e) => ms(e.at));
    const gaps = ticks.slice(1).map((v, i) => v - ticks[i]);
    expect(Math.max(...gaps)).toBeGreaterThan(60 * MIN); // 06:03:03 → 07:11:25
  });
  it('the smell fires during the starved window and never while ticks flow', () => {
    let lastTick = null;
    let lastAdopt = null;
    const fired = [];
    for (const e of ev) {
      const now = ms(e.at);
      if (e.kind === 'tick-done') lastTick = now;
      if (e.kind === 'restart') lastAdopt = now; // every restart here followed an adopted rebuild
      // a tickOnce entry point: each boot / restart / finished smoke is where the wrapper evaluates the smell
      if (['boot', 'restart', 'smoke-done', 'rebuild-not-moved'].includes(e.kind)) {
        const s = tickStarvedSmell({ lastTickDoneAtMs: lastTick, firstSeenAtMs: ms(ev[0].at), lastAdoptedAtMs: lastAdopt, nowMs: now, thresholdMs: 30 * MIN });
        if (s.starved) fired.push(e.at);
      }
    }
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((at) => at >= '2026-10-09T06:33' && at <= '2026-10-09T07:11')).toBe(true);
  });
});

// ── simulation: withSelfSync over a fast-moving main, with tonight's real smoke durations ────────────────────────
const SMOKES = FIXTURE.events.filter((e) => e.kind === 'smoke-done').map((e) => e.ms);

/**
 * Drive real `withSelfSync` wrappers, one per daemon process, on a fake clock. `inline`: the pre-#4126 rebuild (the
 * smoke runs on the tick path). `job`: the rebuild job's tick side (x0m7a8x — what the fix daemon runs now): a
 * finished job is consumed and its ready candidate adopted at that tick, otherwise one job is queued / watched; the
 * smoke runs detached and never advances the tick's clock.
 */
async function run({ mode, horizonMs = 3 * 60 * MIN, intervalMs = 2 * MIN, tickMs = 30_000, bootMs = 10_000 }) {
  const world = { clock: 0, head: 0, smokeIdx: 0, ready: null, readyAt: null };
  const tickDoneAt = [];
  const swaps = [];
  let inTick = false;
  let job = null;
  let jobs = 0;
  const nextSmoke = () => SMOKES[(world.smokeIdx++) % SMOKES.length];
  const mainHead = () => Math.floor(world.clock / (3 * MIN)) + 1;
  const inlineRebuild = vi.fn(async () => {
    const target = mainHead();
    world.clock += nextSmoke();
    world.head = target;
    return { moved: true, adopted: true, head: `h${target}` };
  });
  const jobRebuild = vi.fn(async () => {
    const finishedJobs = [];
    if (job && !job.consumed && world.clock >= job.doneAt) {
      job.consumed = true;
      finishedJobs.push({ id: job.id, status: 'succeeded', reason: 'ready-recorded', readyRecorded: true });
      world.ready = job.target;
      world.readyAt = job.doneAt;
    }
    if (job && !job.consumed) return { moved: false, reason: 'rebuild-job-running', job: { id: job.id }, finishedJobs };
    if (world.ready != null) {
      world.head = world.ready;
      world.ready = null;
      return { moved: true, adopted: true, head: `h${world.head}`, finishedJobs };
    }
    if (mainHead() > world.head) {
      jobs += 1;
      job = { id: `j${jobs}`, doneAt: world.clock + nextSmoke(), target: mainHead() };
      return { moved: false, reason: 'rebuild-job-started', job: { id: job.id }, finishedJobs };
    }
    return { moved: false, reason: 'up-to-date', finishedJobs };
  });
  const progress = { read: () => ({}), markSeen: () => {}, markTickDone: () => {}, alert: () => {} };
  while (world.clock < horizonMs) {
    world.clock += bootMs;
    const bootClock = world.clock;
    let restarted = false;
    const w = withSelfSync({
      tickOnce: async () => { inTick = true; world.clock += tickMs; inTick = false; tickDoneAt.push(world.clock); return { repos: [] }; },
    }, {
      root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'],
      rebuild: mode === 'inline' ? inlineRebuild : jobRebuild, readHead: () => `h${world.head}`, readOriginRef: () => null,
      acquireRead: () => ({ ok: true }), releaseRead: () => {}, readState: () => ({ quarantine: null, adopted: null }),
      diffFiles: () => ['scripts/conveyor/reconcile-fix-dispatch.mjs'], importClosure: () => null,
      now: () => world.clock,
      onRestart: () => { swaps.push({ at: world.clock, uptimeMs: world.clock - bootClock, bootClock, readyAt: world.readyAt, inTick }); restarted = true; return { restarted: true }; },
      // inline = the pre-#4126 daemon, which had no swap spacing (the plain 2-min restart window)
      background: mode === 'inline' ? null : { enabled: true, swapMinIntervalMs: 10 * MIN, tickStarvedSmellMs: 30 * MIN },
      tickProgress: progress,
    });
    while (!restarted && world.clock < horizonMs) {
      // eslint-disable-next-line no-await-in-loop
      await w.tickOnce();
      if (!restarted) world.clock += intervalMs;
    }
  }
  return { tickDoneAt, swaps, inlineRebuild, jobRebuild };
}

describe('simulation — withSelfSync, main moving every 3 min, tonight\'s smoke durations (A1)', () => {
  it('BEFORE #4126 (inline rebuild): every process restarts before its first tick — zero ticks in 3 h', async () => {
    const r = await run({ mode: 'inline' });
    expect(r.inlineRebuild).toHaveBeenCalled();
    expect(r.swaps.length).toBeGreaterThan(5);
    expect(r.tickDoneAt).toHaveLength(0);
  });

  it('x0m7a8x (rebuild job, no builder process): ticks every ≤ 3 min, swaps only between ticks, spacing kept', async () => {
    const r = await run({ mode: 'job' });
    expect(r.inlineRebuild).not.toHaveBeenCalled();
    expect(r.tickDoneAt.length).toBeGreaterThan(50);
    const gaps = r.tickDoneAt.slice(1).map((v, i) => v - r.tickDoneAt[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(3 * MIN);
    // the swap happened (the new version is picked up), never mid-tick, at most once per 10 min
    expect(r.swaps.length).toBeGreaterThan(2);
    expect(r.swaps.every((s) => !s.inTick && s.uptimeMs >= 10 * MIN)).toBe(true);
    // every process completes at least one tick before it swaps (tick-first after restart)
    for (const s of r.swaps) expect(r.tickDoneAt.some((t) => t <= s.at && t > s.at - s.uptimeMs)).toBe(true);
  });

  it('x0m7a8x: the swap lag is at most one tick interval past the job finishing (or past the swap spacing) — no 5-min builder coalesce', async () => {
    const r = await run({ mode: 'job' });
    const slack = 2 * MIN + 30_000; // intervalMs + tickMs: the next tick boundary
    for (const s of r.swaps) {
      const earliest = Math.max(s.readyAt ?? 0, s.bootClock + 10 * MIN);
      expect(s.at - earliest).toBeLessThanOrEqual(slack);
    }
  });

  it('a stale-main refusal rebuilds through the job tick side and restarts on an adoption', async () => {
    const rebuild = vi.fn()
      .mockResolvedValueOnce({ moved: false, reason: 'up-to-date', finishedJobs: [] })
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'h2', finishedJobs: [] });
    const onRestart = vi.fn(() => ({ restarted: true }));
    const w = withSelfSync({ tickOnce: async () => ({ refusals: ['stale'] }) }, {
      root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/a.mjs'], rebuild,
      readHead: () => 'h1', acquireRead: () => ({ ok: true }), releaseRead: () => {}, readState: () => ({}),
      hasStaleRefusal: () => true, now: () => 0, onRestart, diffFiles: () => ['a.mjs'], importClosure: () => null,
      background: { enabled: true, swapMinIntervalMs: 0, tickStarvedSmellMs: 0 }, tickProgress: null,
    });
    await w.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('the smell is logged when ticks starve while rebuilds adopt', async () => {
    const log = { error: vi.fn() };
    const alert = vi.fn();
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/clone', env: {}, log, versions: null, entries: ['/clone/a.mjs'],
      rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      readHead: () => 'h1', acquireRead: () => ({ ok: true }), releaseRead: () => {}, now: () => 40 * MIN, onRestart: vi.fn(),
      readState: () => ({ adopted: { at: new Date(35 * MIN).toISOString() } }),
      background: { enabled: false, tickStarvedSmellMs: 30 * MIN },
      tickProgress: { read: () => ({ lastTickDoneAt: new Date(0).toISOString() }), markSeen: () => {}, markTickDone: () => {}, alert },
    });
    await w.tickOnce();
    expect(log.error.mock.calls.some(([m]) => /SMELL tick-starved — no completed tick for 40 min/.test(m))).toBe(true);
    expect(alert).toHaveBeenCalledWith('tick-starved', expect.objectContaining({ sinceTickMs: 40 * MIN }), 40 * MIN);
  });
});

// ── x0m7a8x: no builder process; every skip path still rebuilds first; the re-clone fail-closed rule ─────────────

/** A job-mode `withSelfSync` over fakes; returns the wrapper plus the spies the tests assert on. */
function jobDaemon({
  tick = async () => ({ repos: [] }), readState = () => ({}), acquireRead, rebuild, cloneIdentity, readHead = () => 'h1',
  recloneMarker = memoryRecloneMarkerStore(), hasStaleRefusal, rebuildAsJob = true, rebuildJobIds,
} = {}) {
  const onRestart = vi.fn(() => ({ restarted: true }));
  const tickOnce = vi.fn(tick);
  const rb = rebuild ?? vi.fn(async () => ({ moved: false, reason: 'rebuild-job-running', job: { id: 'j1' }, finishedJobs: [] }));
  const w = withSelfSync({ tickOnce }, {
    root: '/clone', env: {}, log: { error: () => {} }, versions: null, entries: ['/clone/a.mjs'], rebuild: rb,
    readHead, readOriginRef: () => null, acquireRead: acquireRead ?? (() => ({ ok: true })), releaseRead: vi.fn(), readState,
    now: () => 0, onRestart, recloneMarker, rebuildAsJob,
    ...(cloneIdentity ? { cloneIdentity } : {}),
    ...(hasStaleRefusal ? { hasStaleRefusal } : {}),
    ...(rebuildJobIds ? { rebuildJobIds } : {}),
    background: { enabled: true, swapMinIntervalMs: 0, tickStarvedSmellMs: 0 }, tickProgress: null,
  });
  return { w, onRestart, tickOnce, rebuild: rb, recloneMarker };
}

describe('F1 → x0m7a8x — no skip path needs a builder: the tick\'s own rebuild runs first (a quarantined clone can heal)', () => {
  it('quarantined clone: the tick is skipped, the rebuild (whose adopt pass clears the quarantine) already ran, no builder', async () => {
    const { w, tickOnce, rebuild } = jobDaemon({ readState: () => ({ quarantine: { prevHead: 'p', reason: 'reset-rollback-failed' } }) });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'quarantine' });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
  it.each([['writer-active'], ['writer-priority']])('read lock refused (%s): the rebuild ran, no builder', async (reason) => {
    const { w, tickOnce, rebuild } = jobDaemon({ acquireRead: () => ({ ok: false, reason }) });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
  it('a tick() that throws: the error still propagates', async () => {
    const { w } = jobDaemon({ tick: async () => { throw new Error('boom'); } });
    await expect(w.tickOnce()).rejects.toThrow('boom');
  });
});

describe('x0m7a8x — a re-cloned checkout runs no children until a rebuild on it concludes', () => {
  it('PURE resolveSelfSyncRebuildAsJob: the retired builder\'s opt-in WE_DAEMON_BACKGROUND_BUILD=1 still moves an UNLISTED daemon off the tick path', () => {
    const unlisted = () => false;
    const listed = () => true;
    expect(resolveSelfSyncRebuildAsJob({ entries: ['/c/x.mjs'], env: {}, resolve: unlisted })).toBe(false);
    expect(resolveSelfSyncRebuildAsJob({ entries: ['/c/x.mjs'], env: { WE_DAEMON_BACKGROUND_BUILD: '1' }, resolve: unlisted })).toBe(true);
    expect(resolveSelfSyncRebuildAsJob({ entries: ['/c/x.mjs'], env: { WE_DAEMON_BACKGROUND_BUILD: '0' }, resolve: listed })).toBe(true); // '0' is spacing only
    // the explicit rebuild-path switch wins over the legacy opt-in
    expect(resolveSelfSyncRebuildAsJob({ entries: ['/c/x.mjs'], env: { WE_DAEMON_BACKGROUND_BUILD: '1', WE_DAEMON_REBUILD_AS_JOB: '0' }, resolve: unlisted })).toBe(false);
  });
  it('PURE resultReportsReclone: directly, or through a rebuild job that finished with that reason', () => {
    expect(resultReportsReclone({ reason: 'clone-recloned' })).toBe(true);
    expect(resultReportsReclone({ reason: 'rebuild-job-running', finishedJobs: [{ status: 'succeeded', reason: 'clone-recloned' }] })).toBe(true);
    expect(resultReportsReclone({ reason: 'rebuild-job-running', finishedJobs: [{ status: 'succeeded', reason: 'ready-recorded' }] })).toBe(false);
  });
  it('PURE recloneConcluded: adoption, HEAD moved, up-to-date or a job that RAN; never a failed launch or another re-clone', () => {
    const m = { head: 'h1', concluded: false };
    const job = { asJob: true };
    expect(recloneConcluded({ moved: true, adopted: true }, m, 'h2', job)).toBe(true);
    expect(recloneConcluded({ reason: 'rebuild-job-running' }, m, 'h2', job)).toBe(true); // HEAD moved off the re-clone's
    expect(recloneConcluded({ reason: 'up-to-date' }, m, 'h1', job)).toBe(true);
    expect(recloneConcluded({ reason: 'needs-build', finishedJobs: [{ status: 'succeeded', reason: 'held' }] }, m, 'h1', job)).toBe(true);
    expect(recloneConcluded({ reason: 'rebuild-job-started', finishedJobs: [] }, m, 'h1', job)).toBe(false);
    expect(recloneConcluded({ reason: 'rebuild-job-running', finishedJobs: [{ status: 'failed', reason: 'could not prepare code: x' }] }, m, 'h1', job)).toBe(false);
    expect(recloneConcluded({ reason: 'rebuild-job-running', finishedJobs: [{ status: 'failed', reason: 'spawn failed: ENOENT' }] }, m, 'h1', job)).toBe(false);
    expect(recloneConcluded({ reason: 'rebuild-job-running', finishedJobs: [{ status: 'failed', reason: 'dead: max attempts' }] }, m, 'h1', job)).toBe(false);
    expect(recloneConcluded({ reason: 'rebuild-job-running', finishedJobs: [{ status: 'succeeded', reason: 'clone-recloned' }] }, m, 'h1', job)).toBe(false);
    expect(recloneConcluded({ reason: 'rebuild-job-spaced' }, null, 'h1', job)).toBe(true); // no marker: nothing to block
  });
  it('PURE recloneConcluded: a JOB-mode result that carries NO finishedJobs never concludes (the mode is declared, not read off the shape)', () => {
    const m = { head: 'h1', concluded: false };
    for (const reason of ['rebuild-job-spaced', 'rebuild-job-started', 'rebuild-job-running', 'rebuild-job-queue-failed', 'needs-build', 'error']) {
      expect(recloneConcluded({ moved: false, reason }, m, 'h1', { asJob: true })).toBe(false);
      expect(recloneConcluded({ moved: false, reason }, m, 'h1')).toBe(false); // mode unknown: fails closed to the job rule
    }
  });
  it('PURE recloneConcluded: a job whose rebuild CRASHED after starting ran on the checkout — it concludes (builder parity: a thrown rebuild was a finished run)', () => {
    const m = { head: 'h1', concluded: false, staleJobIds: ['j1'] };
    expect(recloneConcluded({ reason: 'needs-build', finishedJobs: [{ id: 'j2', status: 'failed', reason: 'rebuild child exited 1 with no JSON result' }] }, m, 'h1', { asJob: true })).toBe(true);
    expect(recloneConcluded({ reason: 'needs-build', finishedJobs: [{ id: 'j1', status: 'failed', reason: 'rebuild child exited 1 with no JSON result' }] }, m, 'h1', { asJob: true })).toBe(false); // stale
  });
  it('PURE recloneConcluded: an INLINE rebuild (declared asJob:false) concludes on ANY verdict, as the pre-job inline path did', () => {
    const m = { head: 'h1', concluded: false };
    const inline = { asJob: false };
    expect(recloneConcluded({ moved: false, reason: 'smoke-failed' }, m, 'h1', inline)).toBe(true);
    expect(recloneConcluded({ moved: false, reason: 'held' }, m, 'h1', inline)).toBe(true);
    expect(recloneConcluded(null, m, 'h1', inline)).toBe(false);
    expect(recloneConcluded({ moved: false, reason: 'smoke-failed', finishedJobs: [] }, m, 'h1', { asJob: true })).toBe(false);
  });
  it('PURE recloneConcluded: a job that was in flight BEFORE the re-clone (staleJobIds) ran on the old tree — it never concludes', () => {
    const m = { head: 'h1', concluded: false, staleJobIds: ['j1'] };
    expect(recloneConcluded({ reason: 'rebuild-job-started', finishedJobs: [{ id: 'j1', status: 'succeeded', reason: 'ready-recorded' }] }, m, 'h1', { asJob: true })).toBe(false);
    expect(recloneConcluded({ reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] }, m, 'h1', { asJob: true })).toBe(true);
  });
  it('an INLINE-rebuild daemon: the tick after the re-clone ticks again on a rejected rebuild (never stalls while main is unsmokable)', async () => {
    const results = [
      { moved: false, reason: 'clone-recloned', quarantinedTo: '/q' },
      { moved: false, reason: 'smoke-failed' },
      { moved: false, reason: 'smoke-failed' },
    ];
    const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()), rebuildAsJob: false });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    await w.tickOnce();
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(2);
    expect(recloneMarker.read()).toMatchObject({ concluded: true });
  });
  it('a JOB-mode daemon whose tick side answers WITHOUT finishedJobs stays blocked (no rebuild ran on the fresh checkout)', async () => {
    const results = [
      { moved: false, reason: 'clone-recloned', quarantinedTo: '/q', finishedJobs: [] },
      { moved: false, reason: 'rebuild-job-spaced', retryInMs: 1 },
      { moved: false, reason: 'rebuild-job-started', job: { id: 'j2' } },
      { moved: false, reason: 'rebuild-job-running', job: { id: 'j2' } },
    ];
    const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()) });
    for (let i = 0; i < 4; i += 1) expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' }); // eslint-disable-line no-await-in-loop
    expect(tickOnce).not.toHaveBeenCalled();
    expect(recloneMarker.read()).toMatchObject({ concluded: false });
  });
  it('a JOB-mode daemon on an unsmokable main never stalls: a rejected smoke (succeeded job) or a crashed rebuild child concludes', async () => {
    for (const finished of [
      { id: 'j2', status: 'succeeded', reason: 'smoke-failed', readyRecorded: false },
      { id: 'j2', status: 'failed', reason: 'rebuild child exited 1 with no JSON result' },
    ]) {
      const results = [
        { moved: false, reason: 'clone-recloned', quarantinedTo: '/q', finishedJobs: [] },
        { moved: false, reason: 'rebuild-job-started', job: { id: 'j2' }, finishedJobs: [] },
        { moved: false, reason: 'needs-build', finishedJobs: [finished] },
        { moved: false, reason: 'rebuild-job-spaced', finishedJobs: [] },
      ];
      const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()) });
      for (let i = 0; i < 4; i += 1) await w.tickOnce(); // eslint-disable-line no-await-in-loop
      expect(tickOnce).toHaveBeenCalledTimes(2);
      expect(recloneMarker.read()).toMatchObject({ concluded: true });
    }
  });
  it('a sibling daemon\'s NEWER re-clone marker written mid-tick is never overwritten as concluded (compare-before-write)', async () => {
    const m1 = { identity: 'inode-b', head: 'h1', at: 't1', concluded: false };
    const m2 = { identity: 'inode-c', head: 'h1', at: 't2', concluded: false, why: 'clone-recloned' };
    let readsAfterRebuild = null; // the sibling writes M2 right after this daemon read M1 post-rebuild
    let v = m1;
    const recloneMarker = {
      read: () => { if (readsAfterRebuild != null && (readsAfterRebuild += 1) === 2) v = m2; return v; },
      write: vi.fn((n) => { v = n; }),
    };
    const rebuild = vi.fn(async () => { readsAfterRebuild = 0; return { moved: false, reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] }; });
    const { w, tickOnce } = jobDaemon({ recloneMarker, cloneIdentity: () => (v === m1 ? 'inode-b' : 'inode-c'), rebuild }); // M2 names the checkout now on disk
    await w.tickOnce();
    expect(recloneMarker.write).not.toHaveBeenCalledWith(expect.objectContaining({ identity: 'inode-b', concluded: true }));
    expect(v).toMatchObject({ identity: 'inode-c', concluded: false });
    expect(tickOnce).not.toHaveBeenCalled();
  });
  it('a job seen in flight before the re-clone finishing `succeeded` afterwards does NOT unblock; the next job on the fresh tree does', async () => {
    const results = [
      { moved: false, reason: 'rebuild-job-running', job: { id: 'j1' }, finishedJobs: [] },
      { moved: false, reason: 'clone-recloned', quarantinedTo: '/q', finishedJobs: [] },
      { moved: false, reason: 'rebuild-job-started', job: { id: 'j2' }, finishedJobs: [{ id: 'j1', status: 'succeeded', reason: 'ready-recorded' }] },
      { moved: false, reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] },
    ];
    const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()) });
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(recloneMarker.read()).toMatchObject({ staleJobIds: ['j1'], concluded: false });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(2);
  });
  it('a job a SIBLING daemon (or this daemon before a restart) queued on the old tree never concludes: the shared job store is listed when the marker is written', async () => {
    const results = [
      { moved: false, reason: 'clone-recloned', quarantinedTo: '/q', finishedJobs: [] },
      // jB was never seen in flight by this process; it finishes `succeeded` after the re-clone
      { moved: false, reason: 'rebuild-job-started', job: { id: 'j2' }, finishedJobs: [{ id: 'jB', status: 'succeeded', reason: 'ready-recorded' }] },
      { moved: false, reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] },
    ];
    const rebuildJobIds = vi.fn(() => ['jB', 'jOld']);
    const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()), rebuildJobIds });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(recloneMarker.read()).toMatchObject({ staleJobIds: ['jB', 'jOld'], concluded: false });
    expect(recloneMarker.read().staleJobsUnknown).toBeUndefined();
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
    expect(recloneMarker.read()).toMatchObject({ concluded: true });
  });
  it('a job store that cannot be listed fails CLOSED: no finished job concludes the re-clone (logged); an adopted build still does, and the tick never throws', async () => {
    const results = [
      { moved: false, reason: 'clone-recloned', quarantinedTo: '/q', finishedJobs: [] },
      { moved: false, reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] },
      { moved: true, adopted: true, head: 'h1', finishedJobs: [] },
    ];
    const rebuildJobIds = () => { throw new Error('EACCES'); };
    const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()), rebuildJobIds });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(recloneMarker.read()).toMatchObject({ staleJobsUnknown: true, concluded: false });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
    await w.tickOnce();
    expect(recloneMarker.read()).toMatchObject({ concluded: true });
  });
  it('PURE recloneConcluded: a marker whose job store could not be listed (staleJobsUnknown) concludes only on adoption, a HEAD move or up-to-date', () => {
    const m = { head: 'h1', concluded: false, staleJobIds: [], staleJobsUnknown: true };
    const job = { asJob: true };
    expect(recloneConcluded({ reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] }, m, 'h1', job)).toBe(false);
    expect(recloneConcluded({ moved: true, adopted: true }, m, 'h1', job)).toBe(true);
    expect(recloneConcluded({ reason: 'rebuild-job-running' }, m, 'h2', job)).toBe(true);
    expect(recloneConcluded({ reason: 'up-to-date' }, m, 'h1', job)).toBe(true);
  });
  it('listRebuildJobIds: every rebuild job in the clone\'s store (corrupt records included), never another kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbjobs-'));
    try {
      const store = createJobStore(dir);
      enqueueJob({ store, kindDef: REBUILD_JOB_KIND, id: 'rb-1', codeSha: 'a'.repeat(40), input: {} });
      expect(listRebuildJobIds('/clone', {}, { store })).toEqual(['rb-1']);
      const fake = { list: () => ({ records: [{ id: 'rb-2', job: { kind: REBUILD_JOB_KIND.kind } }, { id: 'other', job: { kind: 'daemon-deps-install' } }], corrupt: ['bad-1'] }) };
      expect(listRebuildJobIds('/clone', {}, { store: fake })).toEqual(['rb-2', 'bad-1']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a re-clone reported by the stale-refusal rebuild (step 5) writes the marker and the next tick runs no children', async () => {
    const results = [
      { moved: false, reason: 'rebuild-job-running', job: { id: 'j1' }, finishedJobs: [] },
      { moved: false, reason: 'needs-build', finishedJobs: [{ id: 'j1', status: 'succeeded', reason: 'clone-recloned' }] },
      { moved: false, reason: 'rebuild-job-started', job: { id: 'j2' }, finishedJobs: [] },
    ];
    const { w, tickOnce, recloneMarker, rebuild } = jobDaemon({ rebuild: vi.fn(async () => results.shift()), hasStaleRefusal: () => true });
    await w.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(tickOnce).toHaveBeenCalledTimes(1);
    expect(recloneMarker.read()).toMatchObject({ concluded: false, why: 'clone-recloned' });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
  it('the tick that sees the re-clone skips; later ticks skip while the job builds; the first concluded rebuild ticks again', async () => {
    const results = [
      { moved: false, reason: 'clone-recloned', quarantinedTo: '/q' },
      { moved: false, reason: 'rebuild-job-started', job: { id: 'j1' }, finishedJobs: [] },
      { moved: false, reason: 'rebuild-job-running', job: { id: 'j1' }, finishedJobs: [] },
      { moved: false, reason: 'held', finishedJobs: [{ id: 'j1', status: 'succeeded', reason: 'held' }] },
    ];
    const { w, tickOnce, recloneMarker } = jobDaemon({ rebuild: vi.fn(async () => results.shift()) });
    for (let i = 0; i < 3; i += 1) expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' }); // eslint-disable-line no-await-in-loop
    expect(tickOnce).not.toHaveBeenCalled();
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
    expect(recloneMarker.read()).toMatchObject({ concluded: true });
  });
  it('a re-clone reported by the rebuild JOB (its child re-cloned under the write lock) blocks the same way', async () => {
    const results = [
      { moved: false, reason: 'needs-build', finishedJobs: [{ id: 'j1', status: 'succeeded', reason: 'clone-recloned' }] },
      { moved: false, reason: 'rebuild-job-started', job: { id: 'j2' }, finishedJobs: [] },
    ];
    const { w, tickOnce } = jobDaemon({ rebuild: vi.fn(async () => results.shift()) });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
  });
  it('the marker survives a restart: a NEW process on the unconcluded re-clone runs no children', async () => {
    const recloneMarker = memoryRecloneMarkerStore({ identity: 'inode-b', head: 'h1', concluded: false });
    const { w, tickOnce } = jobDaemon({ recloneMarker, cloneIdentity: () => 'inode-b' });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
  });
  it('a checkout replaced between the rebuild call and the read lock (the job re-cloned it) is caught UNDER the read lock', async () => {
    const ids = ['inode-a', 'inode-a', 'inode-b']; // boot, the pre-lock check (not yet replaced), then under the read lock
    const { w, tickOnce, recloneMarker } = jobDaemon({ cloneIdentity: () => ids.shift() ?? 'inode-b' });
    expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(recloneMarker.read()).toMatchObject({ identity: 'inode-b', concluded: false });
  });
  it('once concluded, the replaced checkout is accepted: ticks keep running while a LATER job builds', async () => {
    const recloneMarker = memoryRecloneMarkerStore({ identity: 'inode-b', head: 'h1', concluded: true });
    const identities = ['inode-a'];
    const { w, tickOnce } = jobDaemon({ recloneMarker, cloneIdentity: () => identities[0] });
    identities[0] = 'inode-b';
    await w.tickOnce();
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(2);
  });
  it('an unchanged checkout with no marker is untouched while a job runs', async () => {
    const { w, tickOnce } = jobDaemon({ cloneIdentity: () => 'inode-a' });
    await w.tickOnce();
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
  it('the real marker store persists per clone under the daemon state dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reclone-'));
    try {
      const env = { WE_DAEMON_STATE_DIR: dir };
      const s = makeRecloneMarkerStore({ root: '/some/clone', env });
      expect(s.read()).toBeNull();
      s.write({ identity: 'x', concluded: false });
      expect(makeRecloneMarkerStore({ root: '/some/clone', env }).read()).toEqual({ identity: 'x', concluded: false });
      expect(recloneMarkerPath('/some/clone', env).startsWith(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('the real store fails CLOSED on a corrupt marker file: it reads as an unconcluded re-clone, and the tick skips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reclone-'));
    try {
      const env = { WE_DAEMON_STATE_DIR: dir };
      writeFileSync(recloneMarkerPath('/some/clone', env), '{"identity":"x","conc');
      const s = makeRecloneMarkerStore({ root: '/some/clone', env });
      expect(s.read()).toEqual(UNREADABLE_RECLONE_MARKER);
      const results = [
        { moved: false, reason: 'rebuild-job-running', job: { id: 'j1' }, finishedJobs: [] },
        { moved: false, reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] },
      ];
      const { w, tickOnce } = jobDaemon({ recloneMarker: s, cloneIdentity: () => 'inode-a', rebuild: vi.fn(async () => results.shift()) });
      expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
      expect(tickOnce).not.toHaveBeenCalled();
      // ...and a concluding rebuild OVERWRITES it: the file is rewritten as concluded, for this checkout, and the tick runs.
      await w.tickOnce();
      expect(tickOnce).toHaveBeenCalledTimes(1);
      expect(makeRecloneMarkerStore({ root: '/some/clone', env }).read()).toMatchObject({ concluded: true, identity: 'inode-a', concludedBy: 'held' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an unwritable state dir never wedges the process: the marker is kept in memory (blocks, then unblocks) and the failure is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reclone-'));
    try {
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x'); // the state dir path is a FILE: every mkdir/write under it fails
      const log = { error: vi.fn() };
      const s = makeRecloneMarkerStore({ root: '/some/clone', env: { WE_DAEMON_STATE_DIR: blocker }, log });
      const results = [
        { moved: false, reason: 'clone-recloned', quarantinedTo: '/q', finishedJobs: [] },
        { moved: false, reason: 'held', finishedJobs: [{ id: 'j2', status: 'succeeded', reason: 'held' }] },
      ];
      const { w, tickOnce } = jobDaemon({ recloneMarker: s, rebuild: vi.fn(async () => results.shift()) });
      expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'clone-recloned' });
      expect(s.read()).toMatchObject({ concluded: false });
      expect(log.error.mock.calls.some(([m]) => /could not persist the re-clone marker/.test(m))).toBe(true);
      await w.tickOnce();
      expect(tickOnce).toHaveBeenCalledTimes(1);
      expect(s.read()).toMatchObject({ concluded: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('F2 — the re-clone fail-closed flag survives a respawn', () => {
  const withState = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'bgb-'));
    try { return fn({ root: dir, env: { WE_DAEMON_STATE_DIR: join(dir, 'state') } }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const fakeSpawn = () => () => Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
  it('a builder spawned after a recloned record keeps recloned until a builder run finishes on the fresh clone', () => withState(({ root, env }) => {
    writeBuilderState(root, { pid: 1, host: 'h', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), recloned: true, result: { reason: 'clone-recloned' } }, env);
    const next = spawnBuilder({ root, env, spawnFn: fakeSpawn(), log: { error: () => {} } });
    expect(next.recloned).toBe(true);
    expect(readBuilderState(root, env)).toMatchObject({ pid: 4242, finishedAt: null, recloned: true });
  }));
  it('a normal respawn does not invent the flag', () => withState(({ root, env }) => {
    writeBuilderState(root, { pid: 1, host: 'h', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), recloned: false }, env);
    expect(spawnBuilder({ root, env, spawnFn: fakeSpawn(), log: { error: () => {} } }).recloned).toBeUndefined();
  }));
});

describe('F3 — an asynchronous spawn failure never crashes the daemon', () => {
  it('a child that emits \'error\' (ENOENT/EAGAIN) is logged and recorded as a finished failed build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgb-'));
    try {
      const env = { WE_DAEMON_STATE_DIR: join(dir, 'state') };
      const child = Object.assign(new EventEmitter(), { pid: undefined, unref: () => {} });
      const log = { error: vi.fn() };
      spawnBuilder({ root: dir, env, spawnFn: () => child, log });
      const err = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
      // an EventEmitter with no 'error' listener THROWS on emit — exactly the uncaught exception that killed the daemon
      expect(() => child.emit('error', err)).not.toThrow();
      expect(log.error.mock.calls.some(([m]) => /spawn node ENOENT/.test(m) && /next tick/.test(m))).toBe(true);
      const st = readBuilderState(dir, env);
      expect(st.finishedAt).toBeTruthy();
      expect(st.result).toMatchObject({ moved: false, adopted: false });
      expect(st.result.reason).toMatch(/^spawn-failed: spawn node ENOENT/);
      expect(builderIsAlive(st)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('self-review round — record ownership, future-dated records (the builder helpers, retired with the process — follow-up card removes them)', () => {
  // D4: a late finish from an expired builder must not mark its successor's record finished.
  it('writeBuilderStateIfOwner refuses to write over a record another pid owns', () => {
    const write = vi.fn();
    expect(writeBuilderStateIfOwner('/c', { x: 1 }, { pid: 10, read: () => ({ pid: 11 }), write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeBuilderStateIfOwner('/c', { x: 1 }, { pid: 10, read: () => ({ pid: 10 }), write })).toBe(true);
    expect(writeBuilderStateIfOwner('/c', { x: 2 }, { pid: 10, read: () => null, write })).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
  // Review round 2: the deadline can fire after the builder re-cloned and before its final write.
  it('the deadline record keeps the recloned marker set so far (live local or carried in), never drops it', () => {
    const base = { pid: 10, host: 'h', startedAt: 's', finishedAt: null, result: null };
    expect(deadlineRecord(base, { recloned: true }).recloned).toBe(true);
    expect(deadlineRecord({ ...base, recloned: true }, { recloned: false }).recloned).toBe(true);
    expect(deadlineRecord(base, { recloned: false }).recloned).toBe(false);
    const r = deadlineRecord(base, { recloned: true, nowMs: Date.UTC(2026, 9, 9) });
    expect(r.finishedAt).toBe('2026-10-09T00:00:00.000Z');
    expect(r.result.reason).toBe('builder-deadline');
    expect(builderRunFinished(r)).toBe(false); // a deadline is not a finished run: the clone stays fail-closed
  });
  it('--max-age-ms is clamped to the largest setTimeout delay (above it Node fires after ~1 ms)', () => {
    expect(parseBuilderArgs(['--root=/c', `--max-age-ms=${2 ** 40}`]).maxAgeMs).toBe(2 ** 31 - 1);
  });
  it('spawnBuilder hands the builder its own deadline (the daemon\'s trust bound)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgb-'));
    try {
      const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { pid: 1, unref: () => {} }));
      spawnBuilder({ root: dir, env: { WE_DAEMON_STATE_DIR: join(dir, 'state') }, spawnFn, log: { error: () => {} }, maxAgeMs: 5_400_000 });
      expect(spawnFn.mock.calls[0][1]).toContain('--max-age-ms=5400000');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // D6: a clock jump back must not keep a stale record young forever.
  it('a future-dated record (beyond clock skew) is not alive', () => {
    const o = { host: 'h', isAlive: () => true, nowMs: 100 * MIN, maxAgeMs: 90 * MIN };
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(1000 * MIN).toISOString() }, o)).toBe(false);
    expect(builderIsAlive({ pid: 1, host: 'h', startedAt: new Date(101 * MIN).toISOString() }, o)).toBe(true); // small skew is fine
  });
});
