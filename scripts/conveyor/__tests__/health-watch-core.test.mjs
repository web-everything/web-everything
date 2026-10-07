/**
 * @file scripts/conveyor/__tests__/health-watch-core.test.mjs
 * @description #4077 (health daemon slice 1) — drives the PURE CORE (health-watch-core.mjs) through each seed
 *   smell's breach → open → clean → close sequence via {@link runHealthTick}, plus {@link stepEpisodes} directly
 *   for the episode-model mechanics (pending, flap cap, tracked silence, reminder) and the rendering helpers.
 *   Never asserts a whole tick/memory object with toEqual — only the fields each behavior actually turns on.
 */
import { describe, it, expect } from 'vitest';
import {
  MINUTE, HOUR, DEFAULT_HEALTH_CONFIG, BLOCKING_REFUSALS, parseDaemonLog, tickIsUnproductive, foldDaemonMemory,
  emptyHealthState, stepEpisodes, planActions, scrubText, fmtAge, renderEpisodeReport, renderHealthSection,
  runHealthTick, scrubDeep, fenceFor, renderInvestigationSection,
} from '../health-watch-core.mjs';
import daemonSilent from '../health-smells/daemon-silent.mjs';
import daemonOwedNoDispatch from '../health-smells/daemon-owed-no-dispatch.mjs';
import cloneStale from '../health-smells/clone-stale.mjs';
import draftNotPromoted from '../health-smells/draft-not-promoted.mjs';
import repeatedPrAttempts from '../health-smells/repeated-pr-attempts.mjs';
import redPrUnattended from '../health-smells/red-pr-unattended.mjs';
import badCredentials from '../health-smells/bad-credentials.mjs';
import laneStarvation from '../health-smells/lane-starvation.mjs';
import healthTickOverrun from '../health-smells/health-tick-overrun.mjs';
import heavyQueueWait from '../health-smells/heavy-queue-wait.mjs';
import claudeAuthExpired from '../health-smells/claude-auth-expired.mjs';
import dispatchTrustRefused from '../health-smells/dispatch-trust-refused.mjs';

const sample = (name, text, over = {}) => ({ name, mtimeMs: 0, sizeBytes: text.length, text, bootstrap: false, defaultIntervalMs: 120_000, ...over });

// ── 1. parseDaemonLog / tickIsUnproductive ──────────────────────────────────────────────────────────────────

describe('parseDaemonLog — fix-dispatch style block', () => {
  const text = [
    'reconcile-fix-dispatch-daemon: tick (a, b) — dispatched 0, refused 3',
    'reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #2653 — dispatch-lane: no value for the brief placeholder {{SCOPE}} — refusing to fill it with nothing',
    'reconcile-fix-dispatch-daemon: reconcile-refused nothing-owed web-everything/web-everything PR #2658 — phase `open` — nothing new to do',
    'reconcile-fix-dispatch-daemon: frontier-ui/frontierui tick failed (non-fatal, other repos unaffected): review-dispatch: the dispatching checkout is 4 commit(s) behind origin/main — refusing to dispatch',
    'reconcile-fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2661 — no free lane in the pool',
  ].join('\n');

  it('folds the summary + every detail line into ONE tick block', () => {
    const parsed = parseDaemonLog(text);
    expect(parsed.ticks.length).toBe(1);
    const t = parsed.ticks[0];
    expect(t.dispatched).toBe(0);
    expect(t.refused).toBe(3);
    expect(t.wholeFailed).toBe(false);
  });

  it('classifies blocking vs benign refusals correctly', () => {
    const t = parseDaemonLog(text).ticks[0];
    // blocking: dispatch-failed refusal, the stale-checkout repo-tick-failure, the no-lane refusal
    expect(t.blocking.some((b) => /dispatch-failed/.test(b))).toBe(true);
    expect(t.blocking.some((b) => /stale-checkout/.test(b))).toBe(true);
    expect(t.blocking.some((b) => /refused no-lane/.test(b))).toBe(true);
    expect(t.blocking.length).toBe(3);
    // benign: nothing-owed is a correct no-op, never blocking
    expect(t.benign.some((b) => /nothing-owed/.test(b))).toBe(true);
    expect(t.blocking.some((b) => /nothing-owed/.test(b))).toBe(false);
  });

  it('records the no-lane refusal subject and the placeholder text verbatim (for the recommend() regex)', () => {
    const t = parseDaemonLog(text).ticks[0];
    expect(t.noLane).toEqual([{ repo: 'web-everything/web-everything' }]);
    expect(t.blocking.find((b) => /dispatch-failed/.test(b))).toContain('{{SCOPE}}');
  });

  it('BLOCKING_REFUSALS names exactly the "wanted to act and could not" kinds', () => {
    expect([...BLOCKING_REFUSALS].sort()).toEqual(['dispatch-failed', 'lane-failed', 'no-lane', 'spawn-failed', 'stale-checkout']);
    expect(BLOCKING_REFUSALS.has('nothing-owed')).toBe(false);
  });

  it('tickIsUnproductive: dispatched 0 with any blocking reason is unproductive', () => {
    expect(tickIsUnproductive(parseDaemonLog(text).ticks[0])).toBe(true);
  });
});

describe('parseDaemonLog — review-daemon style block', () => {
  const text = [
    'review-daemon: tick (x) — 2 owed, dispatched 0, failed 2',
    "review-daemon: tick failed (non-fatal): Cannot read properties of undefined (reading 'map')",
    'review-daemon: started on Mac:1, tick every 120000ms.',
  ].join('\n');

  it('a "failed N" summary line is unproductive on its own (blocking: dispatch failed)', () => {
    const parsed = parseDaemonLog(text);
    expect(parsed.ticks.length).toBe(2);
    const [t1, t2] = parsed.ticks;
    expect(t1.owed).toBe(2);
    expect(t1.dispatched).toBe(0);
    expect(t1.failed).toBe(2);
    expect(t1.blocking).toContain('dispatch failed');
    expect(tickIsUnproductive(t1)).toBe(true);
  });

  it('a thrown tick becomes its OWN wholeFailed tick, also unproductive', () => {
    const t2 = parseDaemonLog(text).ticks[1];
    expect(t2.wholeFailed).toBe(true);
    expect(t2.blocking[0]).toMatch(/^tick failed: Cannot read properties of undefined/);
    expect(tickIsUnproductive(t2)).toBe(true);
  });

  it('a "started on …, tick every Nms" line sets the interval and counts a restart', () => {
    const parsed = parseDaemonLog(text);
    expect(parsed.intervalMs).toBe(120_000);
    expect(parsed.restarts).toBe(1);
  });

  it('an idle tick (nothing owed, nothing blocking) is productive, never unproductive', () => {
    expect(tickIsUnproductive(parseDaemonLog('review-daemon: tick (y) — nothing owed, dispatched 0').ticks[0])).toBe(false);
  });
});

describe('foldDaemonMemory', () => {
  it('bootstrap spreads a single-tick sample\'s time from mtime; a second, incremental sample stamps `now`', () => {
    const boot = foldDaemonMemory(undefined, { name: 'd', mtimeMs: 1000, sizeBytes: 10, text: 'd: tick (1) — dispatched 1', bootstrap: true, defaultIntervalMs: 120_000 }, 1000);
    expect(boot.lastTickAt).toBe(1000);
    expect(boot.lastTickEstimated).toBe(true);
    const next = foldDaemonMemory(boot, { name: 'd', mtimeMs: 5000, sizeBytes: 20, text: 'd: tick (2) — dispatched 1', bootstrap: false, defaultIntervalMs: 120_000 }, 5000);
    expect(next.lastTickAt).toBe(5000);
    expect(next.lastTickEstimated).toBe(false);
    expect(next.ticksSeen).toBe(2);
  });

  it('tracks an unproductive streak across samples and resets it the moment a tick dispatches something', () => {
    let mem = foldDaemonMemory(undefined, sample('d', 'd: tick (1) — dispatched 0, refused 1\nd: refused no-lane web-everything/web-everything PR #1 — no free lane', { mtimeMs: 0 }), 0);
    expect(mem.unproductiveSince).toBe(0);
    expect(mem.unproductiveTicks).toBe(1);
    mem = foldDaemonMemory(mem, sample('d', 'd: tick (2) — dispatched 1', { mtimeMs: 1000 }), 1000);
    expect(mem.unproductiveSince).toBeNull();
    expect(mem.unproductiveTicks).toBe(0);
  });
});

// ── 2. Per-smell breach → open → clean → close sequences ────────────────────────────────────────────────────

describe('smell: daemon-silent — alive lease, no tick for >10 min opens; ticks resume closes it', () => {
  const lease = (heartbeatAt) => ({ log: 'fix-dispatch-daemon', role: 'reconcile-fix-dispatch-daemon', pid: 4242, pidAlive: true, heartbeatAt });

  it('runs the whole sequence', () => {
    let state = emptyHealthState();
    // Tick 1 (t=0): establish a baseline tick — not yet silent.
    let r = runHealthTick(state, {
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (1) — dispatched 1, refused 0', { mtimeMs: 0 })],
      leases: [lease(0)],
    }, [daemonSilent], 0);
    state = r.state;
    expect(r.transitions).toEqual([]);

    // Tick 2 (t=65min): no growth, no new tick — well past the 10-minute threshold and past the 60-minute
    // "observed gap" window (so the daemon's normal cadence doesn't get computed from a single old sample).
    const t2 = 65 * MINUTE;
    r = runHealthTick(state, {
      daemonLogs: [sample('fix-dispatch-daemon', '', { mtimeMs: 0, sizeBytes: 100 })],
      leases: [lease(t2)],
    }, [daemonSilent], t2);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'daemon-silent::fix-dispatch-daemon')).toBe(true);
    expect(state.episodes['daemon-silent::fix-dispatch-daemon'].status).toBe('open');

    // Tick 3 & 4: ticks resume — two clean samples (closeAfter=2) close it.
    const t3 = t2 + MINUTE;
    r = runHealthTick(state, {
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (2) — dispatched 1, refused 0', { mtimeMs: t3, sizeBytes: 150 })],
      leases: [lease(t3)],
    }, [daemonSilent], t3);
    state = r.state;
    expect(state.episodes['daemon-silent::fix-dispatch-daemon'].status).toBe('open'); // 1 clean sample, not closed yet

    const t4 = t3 + MINUTE;
    r = runHealthTick(state, {
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (3) — dispatched 1, refused 0', { mtimeMs: t4, sizeBytes: 200 })],
      leases: [lease(t4)],
    }, [daemonSilent], t4);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'daemon-silent::fix-dispatch-daemon')).toBe(true);
    expect(state.episodes['daemon-silent::fix-dispatch-daemon']).toBeUndefined();
  });

  it('a dead pid breaches immediately regardless of timing', () => {
    const r = runHealthTick(emptyHealthState(), {
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (1) — dispatched 1, refused 0', { mtimeMs: 0 })],
      leases: [{ log: 'fix-dispatch-daemon', role: 'x', pid: 99999999, pidAlive: false, heartbeatAt: 0 }],
    }, [daemonSilent], 0);
    expect(r.evaluations[0].results[0].breach).toBe(true);
  });
});

describe('smell: daemon-owed-no-dispatch', () => {
  it('streak rule: 30+ min of dispatched-0 + blocking refusal opens; a dispatched>0 tick cleans, 2 cleans close', () => {
    let state = emptyHealthState();
    const noLaneText = (n, pr) => `fix-dispatch-daemon: tick (${n}) — dispatched 0, refused 1\nfix-dispatch-daemon: refused no-lane web-everything/web-everything PR #${pr} — no free lane in the pool`;

    let r = runHealthTick(state, { daemonLogs: [sample('fix-dispatch-daemon', noLaneText(1, 4001), { mtimeMs: 0 })] }, [daemonOwedNoDispatch], 0);
    state = r.state;
    expect(r.transitions).toEqual([]); // dur=0, not yet 30 minutes

    const t2 = 31 * MINUTE;
    r = runHealthTick(state, { daemonLogs: [sample('fix-dispatch-daemon', noLaneText(2, 4002), { mtimeMs: t2 })] }, [daemonOwedNoDispatch], t2);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'daemon-owed-no-dispatch::fix-dispatch-daemon')).toBe(true);

    const t3 = t2 + MINUTE;
    r = runHealthTick(state, { daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (3) — dispatched 1, refused 0', { mtimeMs: t3 })] }, [daemonOwedNoDispatch], t3);
    state = r.state;
    expect(state.episodes['daemon-owed-no-dispatch::fix-dispatch-daemon'].status).toBe('open');

    const t4 = t3 + MINUTE;
    r = runHealthTick(state, { daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (4) — dispatched 1, refused 0', { mtimeMs: t4 })] }, [daemonOwedNoDispatch], t4);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'daemon-owed-no-dispatch::fix-dispatch-daemon')).toBe(true);
  });

  it('ratio rule: 3 of 5 recent ticks (>=60%) unproductive breaches even with no 30-minute streak', () => {
    const text = [
      'review-daemon: tick (1) — dispatched 0, refused 1',
      'review-daemon: refused no-lane web-everything/web-everything PR #3001 — no free lane',
      'review-daemon: tick (2) — dispatched 0, refused 1',
      'review-daemon: refused no-lane web-everything/web-everything PR #3002 — no free lane',
      'review-daemon: tick (3) — dispatched 0, refused 1',
      'review-daemon: refused no-lane web-everything/web-everything PR #3003 — no free lane',
      'review-daemon: tick (4) — dispatched 1, refused 0',
      'review-daemon: tick (5) — dispatched 1, refused 0',
    ].join('\n');
    let state = emptyHealthState();
    let r = runHealthTick(state, { daemonLogs: [sample('review-daemon', text, { mtimeMs: 0 })] }, [daemonOwedNoDispatch], 0);
    state = r.state;
    const res = r.evaluations[0].results.find((x) => x.subject === 'review-daemon');
    expect(res.breach).toBe(true);
    expect(res.measure.last30m.ticks).toBe(5);
    expect(res.measure.last30m.unproductive).toBe(3);
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'daemon-owed-no-dispatch::review-daemon')).toBe(true);

    // Quiet down: two productive-only samples close it.
    const t2 = MINUTE;
    r = runHealthTick(state, { daemonLogs: [sample('review-daemon', 'review-daemon: tick (6) — dispatched 1, refused 0', { mtimeMs: t2 })] }, [daemonOwedNoDispatch], t2);
    state = r.state;
    const t3 = 2 * MINUTE;
    r = runHealthTick(state, { daemonLogs: [sample('review-daemon', 'review-daemon: tick (7) — dispatched 1, refused 0', { mtimeMs: t3 })] }, [daemonOwedNoDispatch], t3);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'daemon-owed-no-dispatch::review-daemon')).toBe(true);
  });
});

describe('smell: clone-stale', () => {
  it('a smoke-rejected alert opens; later adoption with no recent bad alert closes (2 clean samples)', () => {
    let state = emptyHealthState();
    let r = runHealthTick(state, {
      selfSync: [{ cloneKey: 'we-primary', alerts: [{ at: 0, kind: 'smoke-rejected', detail: { failed: 'gh-smoke' } }], rebuild: { adopted: null, rejected: null, quarantine: null, inProgress: null } }],
    }, [cloneStale], 0);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'clone-stale::clone:we-primary')).toBe(true);

    const t2 = 20 * MINUTE;
    r = runHealthTick(state, {
      selfSync: [{ cloneKey: 'we-primary', alerts: [{ at: 0, kind: 'smoke-rejected', detail: { failed: 'gh-smoke' } }], rebuild: { adopted: { at: t2 }, rejected: null, quarantine: null, inProgress: null } }],
    }, [cloneStale], t2);
    state = r.state;
    expect(state.episodes['clone-stale::clone:we-primary'].status).toBe('open');

    const t3 = t2 + MINUTE;
    r = runHealthTick(state, {
      selfSync: [{ cloneKey: 'we-primary', alerts: [{ at: 0, kind: 'smoke-rejected', detail: { failed: 'gh-smoke' } }], rebuild: { adopted: { at: t2 }, rejected: null, quarantine: null, inProgress: null } }],
    }, [cloneStale], t3);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'clone-stale::clone:we-primary')).toBe(true);
  });
});

describe('smell: bad-credentials', () => {
  it('3 "Bad credentials" lines in 15 min opens; quiet closes after 3 clean samples', () => {
    const text = ['review-daemon: gh api call failed: Bad credentials', 'review-daemon: gh api call failed: Bad credentials', 'review-daemon: gh api call failed: Bad credentials'].join('\n');
    let state = emptyHealthState();
    let r = runHealthTick(state, { daemonLogs: [sample('review-daemon', text, { mtimeMs: 0 })] }, [badCredentials], 0);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'bad-credentials::github-auth')).toBe(true);

    // Past the 15-minute window, with no new errors: 3 clean samples close it.
    let now = 16 * MINUTE;
    r = runHealthTick(state, { daemonLogs: [] }, [badCredentials], now);
    state = r.state;
    expect(state.episodes['bad-credentials::github-auth'].status).toBe('open');
    now += MINUTE;
    r = runHealthTick(state, { daemonLogs: [] }, [badCredentials], now);
    state = r.state;
    expect(state.episodes['bad-credentials::github-auth'].status).toBe('open');
    now += MINUTE;
    r = runHealthTick(state, { daemonLogs: [] }, [badCredentials], now);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'bad-credentials::github-auth')).toBe(true);
  });
});

// #4174 follow-up (live-caught 2026-09-27) — 17 real "Workspace not trusted" refusals in
// ~/workspace/wev-review-daemon/.conveyor/fix-dispatch-daemon.log, across fix-/ci-heal-/review dispatches.
describe('parseDaemonLog / foldDaemonMemory — trust refusals', () => {
  it('counts a "Workspace not trusted" refusal line, same as AUTH_ERROR counts a 401', () => {
    const text = 'Workspace not trusted. Run `claude` in /x/dispatch/abc once and accept the trust prompt, then retry.';
    expect(parseDaemonLog(text).trustRefusals).toBe(1);
  });

  it('folds into trustRefusalTimes, kept within the 2h window like authErrorTimes', () => {
    const mem = foldDaemonMemory(undefined, sample('fix-dispatch-daemon', 'Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.', { mtimeMs: 0 }), 0);
    expect(mem.trustRefusalTimes).toHaveLength(1);
  });

  // PR #2824 review — memory persisted by a daemon build that predates `trustRefusalTimes` must not crash the fold.
  it('folds a refusal into LEGACY memory that has no trustRefusalTimes field', () => {
    const legacy = foldDaemonMemory(undefined, sample('fix-dispatch-daemon', '', { mtimeMs: 0 }), 0);
    delete legacy.trustRefusalTimes;
    const mem = foldDaemonMemory(legacy, sample('fix-dispatch-daemon', 'Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.', { mtimeMs: 1, sizeBytes: 10 }), 1);
    expect(mem.trustRefusalTimes).toHaveLength(1);
  });

  it('counts the dispatch sink\'s normalized refusal line (lower-case "workspace not trusted")', () => {
    const line = 'reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #2822 — claude could not be started (workspace not trusted for /x/dispatch/a) — no agent exists';
    expect(parseDaemonLog(line).trustRefusals).toBe(1);
  });
});

describe('smell: dispatch-trust-refused', () => {
  it('2 "Workspace not trusted" refusals in 60 min opens; quiet closes after 3 clean samples', () => {
    const text = [
      'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 0, refused 1',
      'Workspace not trusted. Run `claude` in /x/dispatch/a once and accept the trust prompt, then retry.',
      'reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #2822 — claude could not be started (workspace not trusted for /x/dispatch/a) — no agent exists',
      'Workspace not trusted. Run `claude` in /x/dispatch/b once and accept the trust prompt, then retry.',
    ].join('\n');
    let state = emptyHealthState();
    let r = runHealthTick(state, { daemonLogs: [sample('fix-dispatch-daemon', text, { mtimeMs: 0 })] }, [dispatchTrustRefused], 0);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'dispatch-trust-refused::dispatch-trust')).toBe(true);

    // Past the 60-minute window, with no new refusals: 3 clean samples close it.
    let now = 61 * MINUTE;
    r = runHealthTick(state, { daemonLogs: [] }, [dispatchTrustRefused], now);
    state = r.state;
    expect(state.episodes['dispatch-trust-refused::dispatch-trust'].status).toBe('open');
    now += MINUTE;
    r = runHealthTick(state, { daemonLogs: [] }, [dispatchTrustRefused], now);
    state = r.state;
    expect(state.episodes['dispatch-trust-refused::dispatch-trust'].status).toBe('open');
    now += MINUTE;
    r = runHealthTick(state, { daemonLogs: [] }, [dispatchTrustRefused], now);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'dispatch-trust-refused::dispatch-trust')).toBe(true);
  });

  it('a single refusal (below minErrors=2) never opens', () => {
    const text = 'Workspace not trusted. Run `claude` in /x/dispatch/only-one once and accept the trust prompt, then retry.';
    const state = emptyHealthState();
    const r = runHealthTick(state, { daemonLogs: [sample('fix-dispatch-daemon', text, { mtimeMs: 0 })] }, [dispatchTrustRefused], 0);
    expect(r.transitions.some((t) => t.type === 'opened')).toBe(false);
  });

  it('opens on the sink\'s normalized refusal lines alone, with no raw CLI stderr logged (PR #2824 review)', () => {
    const text = ['a', 'b'].map((s) => `reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #2822 — claude could not be started (workspace not trusted for /x/dispatch/${s}) — no agent exists`).join('\n');
    const r = runHealthTick(emptyHealthState(), { daemonLogs: [sample('fix-dispatch-daemon', text, { mtimeMs: 0 })] }, [dispatchTrustRefused], 0);
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'dispatch-trust-refused::dispatch-trust')).toBe(true);
  });
});

// Live incident, night of 2026-09-25/26 ET — the operator's Claude login expired; every daemon-dispatched
// session hit the CLI's own auth failure and sat dead all night with nothing alerting the operator.
describe('smell: claude-auth-expired (live incident, night of 2026-09-25/26 ET)', () => {
  it('RED→GREEN: 2 auth-expired sessions in 30 min opens; a single one does not', () => {
    let state = emptyHealthState();
    let r = runHealthTick(state, { authExpired: [{ name: 'ci-heal-2711', startedAt: 0 }] }, [claudeAuthExpired], 0);
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'claude-auth-expired::claude-auth')).toBe(false);

    state = r.state;
    r = runHealthTick(state, { authExpired: [
      { name: 'ci-heal-2711', startedAt: 0 }, { name: 'ci-heal-2712', startedAt: 5 * MINUTE },
    ] }, [claudeAuthExpired], 6 * MINUTE);
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'claude-auth-expired::claude-auth')).toBe(true);
    const ep = r.state.episodes['claude-auth-expired::claude-auth'];
    expect(ep.summary).toMatch(/ci-heal-2711/);
    expect(ep.summary).toMatch(/ci-heal-2712/);
    expect(ep.recommendation).toMatch(/\/login/);
  });

  it('a session whose failure is OLDER than the 30-minute window no longer counts', () => {
    const state = emptyHealthState();
    const r = runHealthTick(state, { authExpired: [
      { name: 'ci-heal-2711', startedAt: 0 }, { name: 'ci-heal-2712', startedAt: 31 * MINUTE },
    ] }, [claudeAuthExpired], 31 * MINUTE);
    // Only ci-heal-2712 is within the 30-minute window — one session, below the minCount:2 threshold.
    expect(r.transitions.some((t) => t.type === 'opened')).toBe(false);
  });

  // `claude-auth-expired` was approved to notify by an earlier operator decision and the Sun 2026-09-27
  // `notify-list.mjs` addition (`health-smells-notify-list.mjs`) is additive — it never demotes a sign already
  // approved, so this stays a real, un-suppressed notify.
  it('THE URGENT NOTIFY EXCEPTION: opens with a `notify` action that is NEVER suppressed, even in shadow mode', () => {
    const state = emptyHealthState();
    const r = runHealthTick(state, { authExpired: [
      { name: 'ci-heal-2711', startedAt: 0 }, { name: 'ci-heal-2712', startedAt: 0 },
    ] }, [claudeAuthExpired], 0, { config: { mode: 'shadow' } });
    expect(r.transitions.some((t) => t.type === 'opened')).toBe(true);
    const notify = r.plan.find((p) => p.kind === 'notify' && p.key === 'claude-auth-expired::claude-auth');
    expect(notify).toBeDefined();
    expect(notify.suppressed).toBeNull();
  });

  it('closes after `closeAfter` (1) clean sample once the auth-expired count drops below minCount', () => {
    let state = emptyHealthState();
    let r = runHealthTick(state, { authExpired: [
      { name: 'ci-heal-2711', startedAt: 0 }, { name: 'ci-heal-2712', startedAt: 0 },
    ] }, [claudeAuthExpired], 0);
    state = r.state;
    expect(state.episodes['claude-auth-expired::claude-auth'].status).toBe('open');

    r = runHealthTick(state, { authExpired: [] }, [claudeAuthExpired], MINUTE);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'claude-auth-expired::claude-auth')).toBe(true);
  });

  it('a probe that did not sample this tick (no `authExpired` key) never moves the episode', () => {
    let state = emptyHealthState();
    let r = runHealthTick(state, { authExpired: [
      { name: 'ci-heal-2711', startedAt: 0 }, { name: 'ci-heal-2712', startedAt: 0 },
    ] }, [claudeAuthExpired], 0);
    state = r.state;
    r = runHealthTick(state, {}, [claudeAuthExpired], MINUTE); // no `authExpired` probe this tick
    expect(r.transitions).toEqual([]);
    expect(r.state.episodes['claude-auth-expired::claude-auth'].status).toBe('open');
  });
});

describe('smell: lane-starvation', () => {
  it('opens after openAfter=2 samples (not 1); acquirable>demand + no recent no-lane closes after 3', () => {
    let state = emptyHealthState();
    const noLaneText = (n, pr) => `fix-dispatch-daemon: tick (${n}) — dispatched 0, refused 1\nfix-dispatch-daemon: refused no-lane web-everything/web-everything PR #${pr} — no free lane`;

    let r = runHealthTick(state, {
      lanePools: [{ repo: 'we', health: { total: 2, leased: 2, acquirable: 0, dirtyUnleased: 0 }, at: 0 }],
      daemonLogs: [sample('fix-dispatch-daemon', noLaneText(1, 4001), { mtimeMs: 0 })],
    }, [laneStarvation], 0);
    state = r.state;
    expect(r.transitions).toEqual([]);
    expect(state.episodes['lane-starvation::lane-pool:we'].status).toBe('pending');

    const t2 = MINUTE;
    r = runHealthTick(state, {
      lanePools: [{ repo: 'we', health: { total: 2, leased: 2, acquirable: 0, dirtyUnleased: 0 }, at: t2 }],
      daemonLogs: [sample('fix-dispatch-daemon', noLaneText(2, 4002), { mtimeMs: t2 })],
    }, [laneStarvation], t2);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'lane-starvation::lane-pool:we')).toBe(true);

    // 30+ minutes later: lanes free, no recent no-lane refusal, demand gone (a productive tick).
    const t3 = 32 * MINUTE;
    r = runHealthTick(state, {
      lanePools: [{ repo: 'we', health: { total: 2, leased: 0, acquirable: 2, dirtyUnleased: 0 }, at: t3 }],
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (3) — dispatched 1, refused 0', { mtimeMs: t3 })],
    }, [laneStarvation], t3);
    state = r.state;
    expect(state.episodes['lane-starvation::lane-pool:we'].status).toBe('open');

    const t4 = t3 + MINUTE;
    r = runHealthTick(state, {
      lanePools: [{ repo: 'we', health: { total: 2, leased: 0, acquirable: 2, dirtyUnleased: 0 }, at: t4 }],
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (4) — dispatched 1, refused 0', { mtimeMs: t4 })],
    }, [laneStarvation], t4);
    state = r.state;
    expect(state.episodes['lane-starvation::lane-pool:we'].status).toBe('open'); // 2 clean, not 3 yet

    const t5 = t4 + MINUTE;
    r = runHealthTick(state, {
      lanePools: [{ repo: 'we', health: { total: 2, leased: 0, acquirable: 2, dirtyUnleased: 0 }, at: t5 }],
      daemonLogs: [sample('fix-dispatch-daemon', 'fix-dispatch-daemon: tick (5) — dispatched 1, refused 0', { mtimeMs: t5 })],
    }, [laneStarvation], t5);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'lane-starvation::lane-pool:we')).toBe(true);
  });
});

describe('smell: health-tick-overrun', () => {
  it('a previous tick over the budget opens; back under budget for 2 samples closes', () => {
    let state = { ...emptyHealthState(), lastTick: { completedAt: 0, durationMs: 90_000, mode: 'shadow', probeErrors: {} } };
    let r = runHealthTick(state, {}, [healthTickOverrun], 100_000, { config: {} });
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'health-tick-overrun::health-watch')).toBe(true);

    state.lastTick = { completedAt: 100_000, durationMs: 1_000, mode: 'shadow', probeErrors: {} };
    r = runHealthTick(state, {}, [healthTickOverrun], 160_000, { config: {} });
    state = r.state;
    expect(state.episodes['health-tick-overrun::health-watch'].status).toBe('open');

    state.lastTick = { completedAt: 160_000, durationMs: 1_000, mode: 'shadow', probeErrors: {} };
    r = runHealthTick(state, {}, [healthTickOverrun], 220_000, { config: {} });
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'health-tick-overrun::health-watch')).toBe(true);
  });

  it('a probe error streak of 3 (via opts.probeErrors) opens, even with no overrun', () => {
    let state = emptyHealthState();
    let r;
    for (let i = 1; i <= 3; i += 1) {
      r = runHealthTick(state, {}, [healthTickOverrun], i * MINUTE, { config: {}, probeErrors: { selfSync: 'ENOENT' } });
      state = r.state;
    }
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'health-tick-overrun::health-watch')).toBe(true);
    expect(state.probeErrors.selfSync.count).toBe(3);

    // Dropping the probe error resets the streak entirely (not a decrement).
    r = runHealthTick(state, {}, [healthTickOverrun], 4 * MINUTE, { config: {}, probeErrors: {} });
    expect(state.probeErrors.selfSync).toBeDefined(); // pre-mutation state still has it
    expect(r.state.probeErrors.selfSync).toBeUndefined();
  });
});

describe('smell: red-pr-unattended', () => {
  const T0 = Date.parse('2026-09-25T12:00:00Z');
  it('red for >1h with no fixer opens; a live fix-<N> agent cleans and closes (closeAfter=1)', () => {
    let state = emptyHealthState();
    const prs = [{
      repo: 'web-everything/web-everything', number: 2636, title: 'fix flaky test', updatedAt: new Date(T0 - 2 * HOUR).toISOString(),
      labels: [], statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', completedAt: new Date(T0 - 2 * HOUR).toISOString() }],
    }];
    let r = runHealthTick(state, { prs, agents: [] }, [redPrUnattended], T0);
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'opened' && t.key === 'red-pr-unattended::web-everything/web-everything#2636')).toBe(true);

    r = runHealthTick(state, { prs, agents: [{ name: 'fix-2636', state: 'running' }] }, [redPrUnattended], T0 + MINUTE);
    expect(r.transitions.some((t) => t.type === 'closed' && t.key === 'red-pr-unattended::web-everything/web-everything#2636')).toBe(true);
  });

  it('a red review-gate check alone (ignored) never breaches — the PR is skipped entirely', () => {
    const prs = [{
      repo: 'web-everything/web-everything', number: 9999, title: 'x', updatedAt: new Date(T0).toISOString(), labels: [],
      statusCheckRollup: [{ name: 'review-gate', conclusion: 'FAILURE', completedAt: new Date(T0).toISOString() }],
    }];
    const results = redPrUnattended.evaluate({ prs, agents: [] }, { now: T0, daemons: {} });
    expect(results.find((r) => r.subject === 'web-everything/web-everything#9999')).toBeUndefined();
  });
});

// ── 3. stepEpisodes directly — the episode model's own mechanics ────────────────────────────────────────────

const S = { id: 's', openAfter: 2, closeAfter: 2, severity: 'high', action: 'alert' };
const breachStep = (state, now, opts) => stepEpisodes(state, [{ smell: S, results: [{ subject: 'x', breach: true }] }], now, opts);
const cleanStep = (state, now, opts) => stepEpisodes(state, [{ smell: S, results: [{ subject: 'x', breach: false }] }], now, opts);
const breachStepFor = (subject, state, now, opts) => stepEpisodes(state, [{ smell: S, results: [{ subject, breach: true }] }], now, opts);
const cleanStepFor = (subject, state, now, opts) => stepEpisodes(state, [{ smell: S, results: [{ subject, breach: false }] }], now, opts);

describe('stepEpisodes — pending', () => {
  it('does not open on a single breach (openAfter=2)', () => {
    const r = breachStep(emptyHealthState(), 0);
    expect(r.transitions).toEqual([]);
    expect(r.state.episodes['s::x'].status).toBe('pending');
  });

  it('pending then a clean sample is dropped entirely, no transition', () => {
    let state = breachStep(emptyHealthState(), 0).state;
    const r = cleanStep(state, 1);
    expect(r.transitions).toEqual([]);
    expect(r.state.episodes['s::x']).toBeUndefined();
  });
});

describe('stepEpisodes — flap cap', () => {
  it('re-opening the same (smell,subject) more than flapMax(3) times in 24h becomes "flapping", needing flapCloseAfter(12) cleans to close', () => {
    let state = emptyHealthState();
    let t = 0;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      state = breachStep(state, t++).state;
      const opened = breachStep(state, t++);
      state = opened.state;
      expect(state.episodes['s::x'].status).toBe('open');
      state = cleanStep(state, t++).state;
      const closed = cleanStep(state, t++);
      state = closed.state;
      expect(closed.transitions.some((tr) => tr.type === 'closed' && tr.key === 's::x')).toBe(true);
    }
    // 4th open: opens.length is now 4 > flapMax(3) → flapping.
    state = breachStep(state, t++).state;
    const fourth = breachStep(state, t++);
    state = fourth.state;
    expect(fourth.transitions.some((tr) => tr.type === 'flapping' && tr.key === 's::x')).toBe(true);
    expect(state.episodes['s::x'].status).toBe('flapping');
    expect(state.opens['s::x'].length).toBe(4);

    // flapCloseAfter (default 12) clean samples needed, not the smell's own closeAfter(2).
    for (let i = 0; i < 11; i += 1) {
      state = cleanStep(state, t++).state;
      expect(state.episodes['s::x'].status).toBe('flapping');
    }
    const closeResult = cleanStep(state, t++);
    expect(closeResult.transitions.some((tr) => tr.type === 'closed' && tr.key === 's::x')).toBe(true);
  });

  it('an open older than the 24h flap window does not count toward the cap', () => {
    let state = emptyHealthState();
    state.opens = { 's::y': [-25 * HOUR] }; // older than flapWindowMs(24h) relative to now=0
    state = breachStepFor('y', state, 0).state;
    const opened = breachStepFor('y', state, 1);
    expect(opened.state.episodes['s::y'].status).toBe('open'); // NOT flapping — the stale entry got dropped
    expect(opened.state.opens['s::y'].length).toBe(1);
  });
});

describe('stepEpisodes — tracked silences', () => {
  it('an unexpired silence sets episode.tracked; planActions emits no notify for it', () => {
    let state = emptyHealthState();
    state.silences = [{ smell: 's', subject: 'x', expiresAt: 50 }];
    state = breachStepFor('x', state, 0).state;
    const opened = breachStepFor('x', state, 1);
    state = opened.state;
    const ep = state.episodes['s::x'];
    expect(ep.tracked).toBeTruthy();
    const plan = planActions(opened.transitions, { s: S }, { mode: 'shadow' });
    expect(plan.filter((p) => p.kind === 'notify' && p.key === 's::x')).toEqual([]);
  });

  it('once expired, emits ONE silence-expired transition, then never repeats it', () => {
    let state = emptyHealthState();
    state.silences = [{ smell: 's', subject: 'x', expiresAt: 50 }];
    state = breachStepFor('x', state, 0).state;
    state = breachStepFor('x', state, 1).state;
    expect(state.episodes['s::x'].tracked).toBeTruthy();

    const expired = breachStepFor('x', state, 60);
    state = expired.state;
    expect(expired.transitions.some((t) => t.type === 'silence-expired' && t.key === 's::x')).toBe(true);
    expect(state.episodes['s::x'].tracked).toBeNull();

    const again = breachStepFor('x', state, 61);
    expect(again.transitions.some((t) => t.type === 'silence-expired')).toBe(false);
  });

  it('a silence whose card is in activeCards never expires, regardless of expiresAt', () => {
    let state = emptyHealthState();
    state.silences = [{ smell: 's', subject: 'y', card: '123', expiresAt: -1 }];
    const activeCards = new Set(['123']);
    state = breachStepFor('y', state, 0, { activeCards }).state;
    let r = breachStepFor('y', state, 1, { activeCards });
    state = r.state;
    expect(state.episodes['s::y'].tracked).toBeTruthy();
    r = breachStepFor('y', state, 2, { activeCards });
    state = r.state;
    expect(r.transitions.some((t) => t.type === 'silence-expired')).toBe(false);
    expect(state.episodes['s::y'].tracked).toBeTruthy();
  });
});

describe('stepEpisodes — high-severity reminder', () => {
  it('emits exactly one reminder, reminderAfterMs after opening, and never again', () => {
    let state = emptyHealthState();
    state = breachStepFor('z', state, 0).state;
    state = breachStepFor('z', state, 1).state; // opened at t=1
    expect(state.episodes['s::z'].status).toBe('open');

    const t2 = 1 + DEFAULT_HEALTH_CONFIG.reminderAfterMs;
    const reminded = breachStepFor('z', state, t2);
    state = reminded.state;
    expect(reminded.transitions.some((t) => t.type === 'reminder' && t.key === 's::z')).toBe(true);

    const t3 = t2 + 1;
    const again = breachStepFor('z', state, t3);
    expect(again.transitions.some((t) => t.type === 'reminder')).toBe(false);
  });
});

// ── 4. planActions — shadow mode ─────────────────────────────────────────────────────────────────────────────

describe('planActions', () => {
  it('shadow mode suppresses notify/investigate with a reason; diagnose is never suppressed', () => {
    const D = { id: 'd', openAfter: 1, closeAfter: 1, severity: 'high', action: 'investigate', diagnose: { command: 'echo', args: ['hi'] } };
    const r = stepEpisodes(emptyHealthState(), [{ smell: D, results: [{ subject: 'p', breach: true }] }], 0);
    const plan = planActions(r.transitions, { d: D }, { mode: 'shadow' });

    const diag = plan.find((p) => p.kind === 'diagnose' && p.key === 'd::p');
    expect(diag).toBeDefined();
    expect(diag.suppressed).toBeUndefined();

    const notify = plan.find((p) => p.kind === 'notify' && p.key === 'd::p');
    expect(notify.suppressed).toBe('shadow mode');

    const investigate = plan.find((p) => p.kind === 'investigate' && p.key === 'd::p');
    expect(investigate.suppressed).toMatch(/shadow mode/);
  });

  // #4078 — agent dispatch is its own operator switch (4065 clause 6), independent of `mode`.
  it('investigate is unsuppressed only when config `investigateDispatch` is on — in any mode — and runHealthTick passes it', () => {
    const D = { id: 'd', openAfter: 1, closeAfter: 1, severity: 'medium', action: 'investigate', evaluate: () => [{ subject: 'p', breach: true }] };
    const r = stepEpisodes(emptyHealthState(), [{ smell: D, results: [{ subject: 'p', breach: true }] }], 0);
    const inv = (opts) => planActions(r.transitions, { d: D }, opts).find((p) => p.kind === 'investigate');
    expect(inv({ mode: 'shadow' }).suppressed).toMatch(/shadow mode.*investigateDispatch/);
    expect(inv({ mode: 'live' }).suppressed).toMatch(/dispatch is off/);
    expect(inv({ mode: 'shadow', investigateDispatch: true }).suppressed).toBeNull();
    expect(DEFAULT_HEALTH_CONFIG.investigateDispatch).toBe(false);
    const tick = runHealthTick(emptyHealthState(), {}, [D], 0, { config: { investigateDispatch: true } });
    expect(tick.plan.find((p) => p.kind === 'investigate').suppressed).toBeNull();
  });

  // #4079 (review round 1, finding 10) — filing dispatch is its own operator switch, same independent-of-`mode`
  // shape as `investigateDispatch` just above (4065 clause 6).
  it('file is unsuppressed only when config `fileDispatch` is on — in any mode — and runHealthTick passes it', () => {
    const D = { id: 'd', openAfter: 1, closeAfter: 1, severity: 'medium', action: 'file', evaluate: () => [{ subject: 'p', breach: true }] };
    const r = stepEpisodes(emptyHealthState(), [{ smell: D, results: [{ subject: 'p', breach: true }] }], 0);
    const file = (opts) => planActions(r.transitions, { d: D }, opts).find((p) => p.kind === 'file');
    expect(file({ mode: 'shadow' }).suppressed).toMatch(/shadow mode.*fileDispatch/);
    expect(file({ mode: 'live' }).suppressed).toMatch(/dispatch is off/);
    expect(file({ mode: 'shadow', fileDispatch: true }).suppressed).toBeNull();
    expect(DEFAULT_HEALTH_CONFIG.fileDispatch).toBe(false);
    const tick = runHealthTick(emptyHealthState(), {}, [D], 0, { config: { fileDispatch: true } });
    expect(tick.plan.find((p) => p.kind === 'file').suppressed).toBeNull();
  });

  it('the report renders an investigation status and scrubbed findings, and nothing when none was considered', () => {
    const ep = { key: 'd::p', smell: 'd', subject: 'p', status: 'open', severity: 'medium', openedAt: 0, lastBreachAt: 0 };
    expect(renderEpisodeReport(ep, { now: 0 })).not.toContain('Agent investigation');
    const md = renderEpisodeReport({
      ...ep,
      investigationStatus: { status: 'finished', reason: 'findings recorded; session stopped', session: 'health-x' },
      investigation: { recordedAt: 't', evidence: [{ command: 'c', output: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }], recommendation: { whatIsWrong: 'w', productChange: 'p', nextStep: 'n' } },
    }, { now: 0 });
    expect(md).toContain('## Agent investigation');
    expect(md).toContain('health-x');
    expect(md).toContain('**Next step:** n');
    expect(md).not.toContain('ghp_abcdef');
  });

  // #4077 continuation — a smell whose `id` is in `notifySet` (default: notify-list.mjs's NOTIFY_EVEN_IN_SHADOW)
  // is the one opt-in exception to shadow-mode notify suppression.
  it('a smell whose id is in `notifySet` is never suppressed, even in shadow mode — every other smell is unaffected', () => {
    const URGENT = { id: 'u', openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert' };
    const ORDINARY = { id: 'd', openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert' };
    const r = stepEpisodes(emptyHealthState(), [
      { smell: URGENT, results: [{ subject: 'p', breach: true }] },
      { smell: ORDINARY, results: [{ subject: 'p', breach: true }] },
    ], 0);
    const plan = planActions(r.transitions, { u: URGENT, d: ORDINARY }, { mode: 'shadow', notifySet: new Set(['u']) });

    const urgentNotify = plan.find((p) => p.kind === 'notify' && p.key === 'u::p');
    expect(urgentNotify.suppressed).toBeNull();

    const ordinaryNotify = plan.find((p) => p.kind === 'notify' && p.key === 'd::p');
    expect(ordinaryNotify.suppressed).toBe('shadow mode');
  });

  it('membership in `notifySet` is irrelevant outside shadow mode — never suppressed there either way', () => {
    const URGENT = { id: 'u', openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert' };
    const r = stepEpisodes(emptyHealthState(), [{ smell: URGENT, results: [{ subject: 'p', breach: true }] }], 0);
    const plan = planActions(r.transitions, { u: URGENT }, { mode: 'live', notifySet: new Set(['u']) });
    expect(plan.find((p) => p.kind === 'notify' && p.key === 'u::p').suppressed).toBeNull();
  });

  it('defaults `notifySet` to notify-list.mjs\'s NOTIFY_EVEN_IN_SHADOW when no override is passed', () => {
    const D = { id: 'daemon-silent', openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert' };
    const r = stepEpisodes(emptyHealthState(), [{ smell: D, results: [{ subject: 'p', breach: true }] }], 0);
    const plan = planActions(r.transitions, { 'daemon-silent': D }, { mode: 'shadow' });
    expect(plan.find((p) => p.kind === 'notify' && p.key === 'daemon-silent::p').suppressed).toBeNull();
  });
});

// ── 5. Rendering ─────────────────────────────────────────────────────────────────────────────────────────────

describe('renderHealthSection', () => {
  it('says "never completed a tick" when lastTick is null', () => {
    const lines = renderHealthSection({ episodes: {}, lastTick: null }, { now: 0 });
    expect(lines[0]).toContain('never completed a tick');
  });

  it('the first line names the last-tick age, and flags STALE when older than staleAfterMs', () => {
    const fresh = renderHealthSection({ episodes: {}, lastTick: { completedAt: 0, mode: 'shadow' } }, { now: MINUTE, staleAfterMs: 15 * MINUTE });
    expect(fresh[0]).toContain('last health tick completed');
    expect(fresh[0]).not.toContain('STALE');

    const stale = renderHealthSection({ episodes: {}, lastTick: { completedAt: 0, mode: 'shadow' } }, { now: 20 * MINUTE, staleAfterMs: 15 * MINUTE });
    expect(stale[0]).toContain('STALE');
  });

  it('one row per non-pending episode; pending episodes never show', () => {
    const state = {
      lastTick: { completedAt: 0, mode: 'shadow' },
      episodes: {
        'a::x': { status: 'pending', severity: 'high', smell: 'a', subject: 'x' },
        'b::y': { status: 'open', severity: 'medium', smell: 'b', subject: 'y', openedAt: 0, summary: 'y is broken' },
      },
    };
    const lines = renderHealthSection(state, { now: MINUTE });
    const rows = lines.slice(1);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('b');
    expect(rows[0]).toContain('y');
  });

  it('shows "(no open episodes)" when there are none', () => {
    const lines = renderHealthSection({ lastTick: { completedAt: 0, mode: 'shadow' }, episodes: {} }, { now: 0 });
    expect(lines[1]).toContain('no open episodes');
  });
});

describe('renderEpisodeReport', () => {
  it('contains "What you should do"', () => {
    const ep = { key: 'x::y', smell: 'x', subject: 'y', status: 'open', severity: 'high', openedAt: 0, lastBreachAt: 0, summary: 'test summary', measure: {}, recommendation: 'do the thing' };
    const out = renderEpisodeReport(ep, { now: 1000 });
    expect(out).toContain('What you should do');
    expect(out).toContain('do the thing');
  });
});

describe('scrubText', () => {
  it('redacts a ghp_ token but keeps a 40-hex SHA', () => {
    const shaSum = 'abcdef0123456789abcdef0123456789abcdef01'; // 40 hex chars
    const secret = `ghp_${'A'.repeat(36)}`;
    const out = scrubText(`commit ${shaSum} leaked ${secret} into the log`);
    expect(out).toContain(shaSum);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });
});

// #4077 — a daemon whose log this watch does not read (the plateau drain daemon) is judged on daemon-status's own
// last-activity timestamp (`lastActivityAt`), so a long merging pass never reads as silent.
describe('daemon-silent on a daemon known only through daemon-status', () => {
  const T0 = Date.parse('2026-09-25T15:39:00.000Z');
  const lease = (lastActivityAt) => ({ log: 'plateau-drain-daemon', role: 'drain-daemon', pid: null, pidAlive: true, heartbeatAt: null, lastActivityAt });
  it('is clean while its newest activity is recent, and breaches once it is older than the threshold', () => {
    const fresh = daemonSilent.evaluate({ leases: [lease(T0 - 2 * 60_000)] }, { now: T0, daemons: {} });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].breach).toBe(false);
    const stale = daemonSilent.evaluate({ leases: [lease(T0 - 40 * 60_000)] }, { now: T0, daemons: {} });
    expect(stale[0].breach).toBe(true);
  });
  it('skips a daemon with neither a log memory nor a last-activity time', () => {
    expect(daemonSilent.evaluate({ leases: [lease(null)] }, { now: T0, daemons: {} })).toEqual([]);
  });
});

// ── review round 1 (PR #2672) regressions ─────────────────────────────────────────────────────────────────────

describe('incremental reads keep tick details that cross a sample boundary', () => {
  const summary = 'reconcile-fix-dispatch-daemon: tick (a) — dispatched 0, refused 2';
  const details = [
    'reconcile-fix-dispatch-daemon: refused no-lane frontier-ui/frontierui PR #7 — no free lane to dispatch a fix agent for PR #7',
    'reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #8 — dispatch-lane: no value for the brief placeholder {{SCOPE}} — refusing',
  ].join('\n');
  const T = Date.parse('2026-09-25T12:00:00.000Z');
  const sample = (text, i) => ({ name: 'fix', mtimeMs: T + i * 60_000, sizeBytes: 100 * (i + 1), text, bootstrap: false });
  it('a split summary/details pair folds to the same memory as the unsplit read', () => {
    const whole = foldDaemonMemory(foldDaemonMemory(undefined, { ...sample('', 0), bootstrap: true }, T), sample(`${summary}\n${details}`, 1), T + 60_000);
    let split = foldDaemonMemory(undefined, { ...sample('', 0), bootstrap: true }, T);
    split = foldDaemonMemory(split, sample(summary, 1), T + 60_000);
    expect(split.lastTick.unproductive).toBe(false); // nothing blocking seen yet
    split = foldDaemonMemory(split, sample(details, 2), T + 120_000);
    expect(split.lastTick.unproductive).toBe(true);
    expect(split.unproductiveTicks).toBe(whole.unproductiveTicks);
    expect(Object.keys(split.unproductiveReasons).sort()).toEqual(Object.keys(whole.unproductiveReasons).sort());
    expect(split.lastTick.noLane).toEqual(['frontier-ui/frontierui']);
    expect(Object.keys(split.prRefusals).sort()).toEqual(['frontier-ui/frontierui#7', 'web-everything/web-everything#8']);
    expect(split.recentTicks.at(-1).u).toBe(1);
  });
});

describe('lane-starvation credits demand to the repo each refusal names', () => {
  it('a no-lane refusal on frontierui breaches the frontierui pool, not we', () => {
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    const daemons = { fix: { lastTick: { noLane: ['frontier-ui/frontierui', 'frontier-ui/frontierui'] }, noLaneTimes: [] } };
    const pools = [
      { repo: 'we', health: { total: 10, leased: 9, acquirable: 1, dirtyUnleased: 0 }, at: now },
      { repo: 'frontierui', health: { total: 2, leased: 2, acquirable: 0, dirtyUnleased: 0 }, at: now },
    ];
    const out = laneStarvation.evaluate({ lanePools: pools }, { now, daemons });
    expect(out.find((r) => r.subject === 'lane-pool:frontierui')).toMatchObject({ breach: true, measure: expect.objectContaining({ demandNow: 2 }) });
    expect(out.find((r) => r.subject === 'lane-pool:we')).toMatchObject({ breach: false, measure: expect.objectContaining({ demandNow: 0 }) });
  });
});

describe('a smell that throws every tick raises health-tick-overrun after 3 ticks', () => {
  it('its smell:<id> error streak survives ticks where every IO probe is fine', () => {
    const broken = { id: 'broken', probes: [], openAfter: 1, closeAfter: 1, severity: 'low', action: 'alert', evaluate() { throw new Error('boom'); } };
    let state = emptyHealthState();
    let opened = false;
    for (let i = 0; i < 3; i += 1) {
      const r = runHealthTick(state, {}, [broken, healthTickOverrun], Date.parse('2026-09-25T12:00:00.000Z') + i * 300_000, {});
      state = r.state;
      opened = opened || r.transitions.some((t) => t.type === 'opened' && t.key === 'health-tick-overrun::health-watch');
    }
    expect(state.probeErrors['smell:broken'].count).toBe(3);
    expect(opened).toBe(true);
  });
});

describe('scrubDeep', () => {
  it('redacts a credential in any nested string, leaving numbers and SHAs alone', () => {
    const tok = `ghp_${'A'.repeat(36)}`;
    const out = scrubDeep({ a: [`leaked ${tok} here`], b: { n: 3, sha: '0123456789abcdef0123456789abcdef01234567' } });
    expect(JSON.stringify(out)).not.toContain(tok);
    expect(out.b).toEqual({ n: 3, sha: '0123456789abcdef0123456789abcdef01234567' });
  });
});

// 2026-09-25 13:35 ET, live: the review daemon failed every review (`<repo>#N failed (non-fatal): … N commit(s)
// behind origin/main`) because the rebuild refused to move a DIRTY clone.
describe('review-daemon per-PR failures and the dirty-clone hold', () => {
  it('parses `<repo>#N failed (non-fatal)` as a blocking stale-checkout reason tied to the PR', () => {
    const p = parseDaemonLog([
      'review-daemon: tick (a, b) — 9 owed, dispatched 0, failed 9',
      'review-daemon: web-everything/web-everything#2672 failed (non-fatal): review-dispatch: the dispatching checkout is 10 commit(s) behind origin/main — refusing to dispatch a review',
    ].join('\n'));
    expect(p.ticks[0].blocking).toContain('stale-checkout: dispatching clone behind origin/main');
    expect(p.ticks[0].prs).toEqual([{ pr: 'web-everything/web-everything#2672', reason: 'stale-checkout: dispatching clone behind origin/main' }]);
  });
  it('a `dirty` rebuild alert holds the clone open until the next adoption', () => {
    const at = Date.parse('2026-09-25T17:35:18.330Z');
    const probe = (adoptedAt) => ({ selfSync: [{ cloneKey: 'k', alerts: [{ at, kind: 'dirty', detail: ['M scripts/conveyor/run-scorecards.json'] }], rebuild: { adopted: adoptedAt ? { at: adoptedAt } : null, rejected: null, quarantine: null, inProgress: null } }] });
    const later = at + 60 * 60_000;
    const held = cloneStale.evaluate(probe(null), { now: later, daemons: {} })[0];
    expect(held.breach).toBe(true);
    expect(held.recommendation).toMatch(/local modifications/);
    expect(cloneStale.evaluate(probe(at + 5 * 60_000), { now: later, daemons: {} })[0].breach).toBe(false);
  });
});

// ── review round 2 (PR #2672) regressions ─────────────────────────────────────────────────────────────────────

describe('round 2: attribution and benign-only ticks', () => {
  it('a review-daemon `deferred N (no acquirable lane…)` is recorded unattributed, never credited to the we pool', () => {
    const p = parseDaemonLog('review-daemon: tick (a, b, c) — 2 owed, dispatched 0, failed 0, deferred 2 (no acquirable lane this tick, #3383)');
    expect(p.ticks[0].noLane).toEqual([{ repo: null }, { repo: null }]);
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    const daemons = { review: { lastTick: { noLane: [null, null] }, noLaneTimes: [{ at: now, repo: null }, { at: now, repo: null }] } };
    const out = laneStarvation.evaluate({ lanePools: [{ repo: 'we', health: { total: 3, leased: 2, acquirable: 1, dirtyUnleased: 0 }, at: now }] }, { now, daemons });
    expect(out[0].breach).toBe(false);
    expect(out[0].measure).toMatchObject({ demandNow: 0, noLaneRefusals30m: 0, unattributedNoLane30m: 2 });
  });
  it('owed work refused only by correct no-ops (live-process, cap-exhausted) is NOT unproductive', () => {
    const p = parseDaemonLog([
      'review-daemon: tick (a) — 2 owed, dispatched 0, failed 0',
      'reconcile-fix-dispatch-daemon: tick (a) — dispatched 0, refused 2',
      'reconcile-fix-dispatch-daemon: reconcile-refused live-process web-everything/web-everything PR #1 — a bound session has a LIVE pid',
      'reconcile-fix-dispatch-daemon: reconcile-refused cap-exhausted web-everything/web-everything PR #2 — cap',
    ].join('\n'));
    expect(p.ticks.map(tickIsUnproductive)).toEqual([false, false]);
  });
});

// ── heavy-queue-wait (coordinator request, live 16:02 ET: lane-9 waited 1.5 h for a heavy slot) ──────────────

describe('heavy-queue-wait', () => {
  const T0 = Date.parse('2026-09-25T20:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const held = [{ slot: 0, owner: '/x/.lanes/web-everything/lane-13', pid: 33047, heartbeatAt: iso(T0) }];
  it('opens when a waiter has waited over 30 min (the 16:02 ET lane-9 case), and closes once the queue drains', () => {
    const q = (waiting) => ({ heavyQueue: { cap: 2, heldCount: 1, held, waiting } });
    let state = emptyHealthState();
    let r = runHealthTick(state, q([{ owner: '/x/.lanes/web-everything/lane-9', lane: '9', pid: 1, requestedAt: iso(T0 - 90 * MINUTE) }]), [heavyQueueWait], T0, {});
    expect(r.transitions).toEqual([expect.objectContaining({ type: 'opened', key: 'heavy-queue-wait::heavy-admission' })]);
    expect(r.state.episodes['heavy-queue-wait::heavy-admission'].measure.longWaiters).toEqual([{ lane: 'lane-9', pid: 1, waitedMin: 90 }]);
    state = r.state;
    for (let i = 1; i <= 2; i += 1) { r = runHealthTick(state, q([]), [heavyQueueWait], T0 + i * 5 * MINUTE, {}); state = r.state; }
    expect(r.transitions.map((t) => t.type)).toEqual(['closed']);
  });
  it('measures a holder from when the watch first saw it, and opens past 40 min', () => {
    const q = { heavyQueue: { cap: 2, heldCount: 1, held, waiting: [] } };
    let state = emptyHealthState();
    let opened = null;
    for (let m = 0; m <= 45; m += 5) {
      const r = runHealthTick(state, q, [heavyQueueWait], T0 + m * MINUTE, {});
      state = r.state;
      if (r.transitions.some((t) => t.type === 'opened')) opened = opened ?? m;
    }
    expect(opened).toBe(45);
    expect(state.episodes['heavy-queue-wait::heavy-admission'].measure.longHolders[0]).toMatchObject({ lane: 'lane-13', heldMin: 45 });
  });
  it('forgets a holder as soon as it releases its slot', () => {
    let r = runHealthTick(emptyHealthState(), { heavyQueue: { cap: 2, held, waiting: [] } }, [heavyQueueWait], T0, {});
    expect(Object.keys(r.state.heavyHeldSince)).toHaveLength(1);
    r = runHealthTick(r.state, { heavyQueue: { cap: 2, held: [], waiting: [] } }, [heavyQueueWait], T0 + MINUTE, {});
    expect(r.state.heavyHeldSince).toEqual({});
  });
});

describe('report fences around untrusted text (#4437)', () => {
  it('fenceFor is one backtick longer than the longest run inside, never under three', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('x `````` y')).toBe('```````');
    expect(fenceFor('a `b` c', 1)).toBe('``');
  });
  it('findings containing a fence cannot close the evidence block or the command span', () => {
    const md = renderInvestigationSection({
      investigation: {
        recordedAt: 't', recommendation: { whatIsWrong: 'w', productChange: 'p', nextStep: 'n' },
        evidence: [{ command: 'echo `id`', output: 'before\n```\n## injected\n```\nafter' }],
      },
    }).join('\n');
    expect(md).toContain('Evidence — `` echo `id` ``');
    const open = md.split('\n').find((l) => /^`{4,}$/.test(l));
    expect(open).toBe('````');
    expect(md.split('\n').filter((l) => l === open)).toHaveLength(2);
  });
});


// Duration policy uses the real detectors and the production shadow allowlist.
describe('xyx5mea stuck PR duration', () => {
  const start = 1790882705935;
  const targets = [draftNotPromoted, redPrUnattended, repeatedPrAttempts];
  const subject = 'web-everything/web-everything#3336';
  const key = (s) => `${s.id}::${subject}`;
  const reload = (s) => JSON.parse(JSON.stringify(s));
  const notify = (r) => r.plan.filter(p => p.kind === 'notify');
  function probes(now) {
    return {
      prs: [{ repo: 'web-everything/web-everything', number: 3336, isDraft: true,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: new Date(start - HOUR).toISOString() }] }],
      agents: [], daemonLogs: [],
      operationRuns: Array.from({ length: 5 }, (_, i) => ({ id: `run-${i}`, op: 'open-pr',
        input: { repo: 'web-everything/web-everything', pr: 3336 }, effects: [{ key: 'submit', status: 'failed',
          lastAttemptAt: new Date(now).toISOString(), error: 'submit failed' }] })),
    };
  }
  function run(s, state, now, input = probes(now)) {
    if (s.id === redPrUnattended.id && input.prs) {
      input.prs[0].statusCheckRollup[0].conclusion = 'FAILURE';
    }
    return runHealthTick(state, input, [s], now);
  }

  it.each(targets)('$id escalates exactly once at 60 minutes and soaks across reloads', (s) => {
    let r = run(s, emptyHealthState(), start);
    const original = r.state.episodes[key(s)];
    expect(original.severity).toBe('medium');
    expect(notify(r)).toEqual([]);
    expect(r.plan.filter(p => ['investigate', 'file'].includes(p.kind)).every(p => p.suppressed)).toBe(true);
    r = run(s, r.state, start + HOUR - 1);
    expect(r.state.episodes[key(s)].severity).toBe('medium');
    expect(notify(r)).toEqual([]);
    r = run(s, r.state, start + HOUR);
    expect(r.state.episodes[key(s)]).toMatchObject({ severity: 'high', escalatedAt: start + HOUR,
      id: original.id, openedAt: original.openedAt });
    expect(r.transitions.filter(t => t.type === 'escalated')).toHaveLength(1);
    expect(notify(r)).toEqual([{ kind: 'notify', key: key(s), reason: 'escalated', suppressed: null }]);
    expect(r.plan).toHaveLength(1);
    for (let offset = HOUR + 1; offset < 4 * HOUR; offset += MINUTE) {
      r = run(s, reload(r.state), start + offset);
      expect(r.transitions.filter(t => t.type === 'escalated')).toEqual([]);
      expect(notify(r)).toEqual([]);
    }
  });

  it.each(targets)('$id clears before escalation and reopens with a fresh clock', (s) => {
    let r = run(s, emptyHealthState(), start);
    for (let i = 1; i <= s.closeAfter; i++) {
      r = runHealthTick(r.state, { prs: [], agents: [], daemonLogs: [], operationRuns: [] }, [s], start + i);
      expect(notify(r)).toEqual([]);
    }
    expect(r.state.episodes[key(s)]).toBeUndefined();
    r = run(s, r.state, start + HOUR);
    expect(r.state.episodes[key(s)]).toMatchObject({ severity: 'medium', firstBreachAt: start + HOUR });
    expect(notify(r)).toEqual([]);
  });

  it('clean hysteresis breaks continuity; expired attempts alone cannot escalate', () => {
    const s = repeatedPrAttempts;
    let r = run(s, emptyHealthState(), start);
    r = runHealthTick(r.state, probes(start), [s], start + HOUR);
    expect(r.state.episodes[key(s)].severity).toBe('medium');
    expect(notify(r)).toEqual([]);
    r = run(s, r.state, start + HOUR + 1);
    expect(r.state.episodes[key(s)].firstBreachAt).toBe(start + HOUR + 1);
    expect(notify(r)).toEqual([]);
    r = run(s, r.state, start + 2 * HOUR);
    expect(notify(r)).toEqual([]);
    r = run(s, r.state, start + 2 * HOUR + 1);
    expect(notify(r)).toHaveLength(1);
  });

  it.each(targets)('$id skips unknown probes and thrown evaluations until a confirmed breach', (s) => {
    let r = run(s, emptyHealthState(), start);
    r = runHealthTick(r.state, {}, [s], start + HOUR);
    expect(notify(r)).toEqual([]);
    expect(r.state.episodes[key(s)].severity).toBe('medium');
    r = run({ ...s, evaluate() { throw new Error('probe failed'); } }, r.state, start + HOUR + 1);
    expect(notify(r)).toEqual([]);
    expect(r.state.probeErrors[`smell:${s.id}`].count).toBe(1);
    r = run(s, reload(r.state), start + HOUR + 2);
    expect(notify(r)).toHaveLength(1);
  });

  it('high survives a clean hysteresis sample, and an active tracking card suppresses overdue expiry', () => {
    const s = repeatedPrAttempts;
    let r = run(s, emptyHealthState(), start);
    r = run(s, r.state, start + HOUR);
    const id = r.state.episodes[key(s)].id;
    r = runHealthTick(r.state, { daemonLogs: [], operationRuns: [] }, [s], start + HOUR + 1);
    expect(r.state.episodes[key(s)]).toMatchObject({ severity: 'high', id });
    r.state.silences = [{ smell: s.id, subject, expiresAt: start, card: 'active-card' }];
    r = runHealthTick(r.state, probes(start + 5 * HOUR), [s], start + 5 * HOUR,
      { activeCards: new Set(['active-card']) });
    expect(r.state.episodes[key(s)].severity).toBe('high');
    expect(notify(r)).toEqual([]);
    expect(r.state.episodes[key(s)].remindedAt).toBeNull();
  });

  it('red detection floor is separate from episode duration', () => {
    const input = probes(start);
    input.prs[0].statusCheckRollup[0].completedAt = new Date(start - HOUR + 1).toISOString();
    let r = run(redPrUnattended, emptyHealthState(), start, input);
    expect(r.state.episodes).toEqual({});
    r = run(redPrUnattended, r.state, start + 1, input);
    expect(r.state.episodes[key(redPrUnattended)].severity).toBe('medium');
    expect(notify(r)).toEqual([]);
  });

  it.each([undefined, null, NaN, Infinity, start + 2 * HOUR])('refuses invalid persisted start %s', (firstBreachAt) => {
    let r = run(redPrUnattended, emptyHealthState(), start);
    r.state.episodes[key(redPrUnattended)].firstBreachAt = firstBreachAt;
    r = run(redPrUnattended, r.state, start + HOUR);
    expect(notify(r)).toEqual([]);
    expect(r.state.episodes[key(redPrUnattended)].severity).toBe('medium');
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])('refuses invalid duration %s', (escalateAfterMs) => {
    const s = { ...redPrUnattended, escalateAfterMs };
    let r = run(s, emptyHealthState(), start);
    r = run(s, r.state, start + HOUR);
    expect(notify(r)).toEqual([]);
  });

  it.each(targets)('$id respects tracking, medium expiry, high expiry and coalesces overdue reminders', (s) => {
    let r = run(s, emptyHealthState(), start);
    r.state.silences = [{ smell: s.id, subject, expiresAt: start + 2 * HOUR }];
    r = run(s, r.state, start + HOUR);
    expect(r.state.episodes[key(s)].severity).toBe('high');
    expect(notify(r)).toEqual([]);
    r = run(s, r.state, start + 2 * HOUR);
    expect(notify(r)).toHaveLength(1);
    r = run(s, reload(r.state), start + 2 * HOUR + 1);
    expect(notify(r)).toEqual([]);

    r = run(s, emptyHealthState(), start);
    r.state.silences = [{ smell: s.id, subject, expiresAt: start + MINUTE }];
    r = run(s, r.state, start + MINUTE);
    expect(notify(r)).toEqual([]);

    r = run(s, emptyHealthState(), start);
    r.state.silences = [{ smell: s.id, subject, expiresAt: start + 4 * HOUR }];
    r = run(s, r.state, start + 1);
    r = run(s, r.state, start + 4 * HOUR);
    expect(r.transitions.map(t => t.type)).toEqual(['escalated', 'silence-expired', 'reminder']);
    expect(notify(r)).toHaveLength(1);
    expect(r.state.episodes[key(s)].remindedAt).toBe(start + 4 * HOUR);
    r = run(s, reload(r.state), start + 4 * HOUR + 1);
    expect(notify(r)).toEqual([]);
  });

  it.each([draftNotPromoted, repeatedPrAttempts])('grandfathers legacy high $id without replay', (s) => {
    let r = run(s, emptyHealthState(), start);
    r.state.episodes[key(s)].severity = 'high';
    r = run(s, reload(r.state), start + HOUR);
    expect(r.state.episodes[key(s)].severity).toBe('high');
    expect(r.transitions).toEqual([]);
    expect(notify(r)).toEqual([]);
  });
});

import { recordPrRefusal } from '../health-watch-core.mjs';
describe('recordPrRefusal keeps the owner-state reason', () => {
  it('timeout-retry-ineligible never masks the same tick\'s real refusal (PR #4141)', () => {
    const m = {};
    recordPrRefusal(m, { pr: 'w#1', reason: 'refused fix-loop-hold: 3 sessions' }, 5);
    recordPrRefusal(m, { pr: 'w#1', reason: 'reconcile-refused timeout-retry-ineligible' }, 5);
    expect(m['w#1'].reason).toMatch(/fix-loop-hold/);
    recordPrRefusal(m, { pr: 'w#1', reason: 'reconcile-refused timeout-retry-ineligible' }, 6);
    expect(m['w#1'].at).toBe(6);
  });
});
