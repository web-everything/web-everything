/**
 * @file skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs
 * @description Unit proof of #3870's standalone Fix-dispatch daemon — the pure loop only (no real lease, no
 *   real dispatch, no real timers): injected effects, so the tick/backoff/stop-condition decision is tested
 *   with fakes exactly like runner.mjs's own `runLoop` is.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runDaemonLoop, buildCliDaemonEffects, realSleep, RECONCILE_FIX_DISPATCH_LEASE_KEY, DEFAULT_INTERVAL_MS,
  runReconcileFixDispatchAllRepos, FIX_DISPATCH_DAEMON_REPOS, hasStaleMainRefusal,
  runReconcileCiHealDispatchAllRepos, runTickAllRepos, formatRefusalLine,
  runHungCiRecoveryAllRepos, formatHungActionLine,
  runMainRedRebaseAllRepos, formatMainRedRebaseActionLine,
  runMissingRunRecoveryAllRepos, formatMissingRunActionLine,
  runPromoteDraftDispatchAllRepos, formatPromoteActionLine,
  defaultTagDispatchStatus, withFixDispatchClaimRefresh,
  buildAwaitVerifyStep, buildFixThrottle, buildDaemonExits,
} from '../reconcile-fix-dispatch-daemon.mjs';
import { CONSTELLATION_REPOS } from '../../../scripts/lib/constellation-repos.mjs';
import { assertMainNotStale } from '../../../scripts/lib/main-staleness.mjs';

// #3383 bug 1 — wired into withSelfSync's `hasStaleRefusal` option in main(); tested here in isolation
// (pure, no IO) against the exact shape `runReconcileFixDispatchAllRepos` returns.
describe('hasStaleMainRefusal', () => {
  it('true when a repo tick-failed with the real assertMainNotStale refusal message', () => {
    let message = null;
    try { assertMainNotStale('/repo', () => ({ action: 'warn', reason: 'diverged', behind: 1, ahead: 5, dirty: false })); }
    catch (e) { message = e.message; }
    expect(hasStaleMainRefusal({ refusals: [{ repo: 'frontier-ui/frontierui', kind: 'tick-failed', why: message }] })).toBe(true);
  });
  it('false for an ordinary, unrelated tick failure', () => {
    expect(hasStaleMainRefusal({ refusals: [{ repo: 'x', kind: 'tick-failed', why: 'gh: rate limited' }] })).toBe(false);
  });
  it('false for a non-tick-failed refusal (an ordinary per-PR dispatch refusal is not a whole-repo tick failure)', () => {
    expect(hasStaleMainRefusal({ refusals: [{ repo: 'x', kind: 'no-scope', why: 'STALE code from this checkout — false shape, not tick-failed' }] })).toBe(false);
  });
  it('false with no refusals, or a missing/malformed result', () => {
    expect(hasStaleMainRefusal({ refusals: [] })).toBe(false);
    expect(hasStaleMainRefusal({})).toBe(false);
    expect(hasStaleMainRefusal(undefined)).toBe(false);
  });
});

describe('runDaemonLoop — the pure control flow', () => {
  it('requires a tickOnce effect', async () => {
    await expect(runDaemonLoop({})).rejects.toThrow(/requires a tickOnce effect/);
  });

  it('ticks, sleeps between ticks, and stops at maxTicks', async () => {
    const sleep = vi.fn(async () => {});
    const tickOnce = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const out = await runDaemonLoop({ tickOnce, sleep, maxTicks: 3 });
    expect(tickOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // never sleeps after the LAST tick
    expect(out).toEqual({ ticks: 3, stoppedReason: 'max-ticks' });
  });

  it('a failing tick is isolated — reported via onTickError, never fatal, the loop continues', async () => {
    const onTickError = vi.fn();
    let calls = 0;
    const tickOnce = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('transient gh hiccup'); return { ok: true }; });
    const out = await runDaemonLoop({ tickOnce, sleep: async () => {}, onTickError, maxTicks: 2 });
    expect(tickOnce).toHaveBeenCalledTimes(2);
    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError.mock.calls[0][0].message).toBe('transient gh hiccup');
    expect(out).toEqual({ ticks: 2, stoppedReason: 'max-ticks' });
  });

  it('a lost heartbeat stops the loop immediately — never sleeps or ticks again after losing the lease', async () => {
    let heartbeats = 0;
    const heartbeat = vi.fn(async () => { heartbeats += 1; return heartbeats < 2; }); // alive tick 1, lost tick 2
    const sleep = vi.fn(async () => {});
    const tickOnce = vi.fn(async () => ({}));
    const out = await runDaemonLoop({ tickOnce, sleep, heartbeat, maxTicks: Infinity });
    expect(tickOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // slept after tick 1 (still alive), never after tick 2 (lease lost)
    expect(out).toEqual({ ticks: 2, stoppedReason: 'lease-lost' });
  });

  it('onTick observes every successful result, in order', async () => {
    const seen = [];
    const results = [{ dispatched: [1] }, { dispatched: [2] }];
    let i = 0;
    const tickOnce = async () => results[i++];
    await runDaemonLoop({ tickOnce, sleep: async () => {}, onTick: (r, tick) => seen.push([tick, r]), maxTicks: 2 });
    expect(seen).toEqual([[0, results[0]], [1, results[1]]]);
  });
});

describe('FIX_DISPATCH_DAEMON_REPOS', () => {
  it('is every constellation repo\'s real slug, not just WE (#x1rr9rh, multi-repo slice 2)', () => {
    expect(FIX_DISPATCH_DAEMON_REPOS.sort()).toEqual(Object.values(CONSTELLATION_REPOS).map((r) => r.slug).sort());
    expect(FIX_DISPATCH_DAEMON_REPOS).toContain('plateauapp/plateau-app');
    expect(FIX_DISPATCH_DAEMON_REPOS).toContain('frontier-ui/frontierui');
    expect(FIX_DISPATCH_DAEMON_REPOS).toContain('web-everything/web-everything');
  });
});

describe('runReconcileFixDispatchAllRepos — one runReconcileFixDispatch call per watched repo (#x1rr9rh)', () => {
  it('ticks every repo in the list, calling runReconcileFixDispatch with {repo: slug} per repo', () => {
    const tick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { dispatched: [{ pr: 10 }], refusals: [] }
      : { dispatched: [], refusals: [{ kind: 'unsupported-repo', prNumber: 20 }] }));
    const out = runReconcileFixDispatchAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-b' });
    expect(out.dispatched).toEqual([{ pr: 10, repo: 'repo-a' }]);
    expect(out.refusals).toEqual([{ kind: 'unsupported-repo', prNumber: 20, repo: 'repo-b' }]);
    expect(out.repos).toEqual([
      { repo: 'repo-a', result: expect.any(Object) },
      { repo: 'repo-b', result: expect.any(Object) },
    ]);
  });

  it('one repo throwing (a gh outage, a stale-checkout refusal) never stops the others — isolated per repo', () => {
    const tick = vi.fn(({ repo }) => {
      if (repo === 'repo-bad') throw new Error('reconcile-fix-dispatch: behind origin/main');
      return { dispatched: [{ pr: 1 }], refusals: [] };
    });
    const out = runReconcileFixDispatchAllRepos({ repos: ['repo-bad', 'repo-good'], tick });
    expect(out.dispatched).toEqual([{ pr: 1, repo: 'repo-good' }]);
    expect(out.refusals).toEqual([{ repo: 'repo-bad', prNumber: null, kind: 'tick-failed', why: 'reconcile-fix-dispatch: behind origin/main' }]);
    expect(out.repos[0]).toEqual({ repo: 'repo-bad', error: 'reconcile-fix-dispatch: behind origin/main' });
  });

  it('defaults to FIX_DISPATCH_DAEMON_REPOS and to the real runReconcileFixDispatch when nothing is injected', () => {
    // Only proves the DEFAULTS are wired — this test injects `tick` itself so the real
    // runReconcileFixDispatch's own IO defaults (gh, lane-pool, git) are never reached.
    const tick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const out = runReconcileFixDispatchAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
    expect(out.repos.map((r) => r.repo)).toEqual(FIX_DISPATCH_DAEMON_REPOS);
  });

  // #x0mn6x0 (epic #4075/#3383) — a PR `reconcile-core.mjs#planReconcile` refuses OUTRIGHT (never becoming a
  // `kind:'fix'` dispatch entry at all) previously vanished: `runReconcileFixDispatch` collapsed
  // `reconciled.refusals` to a bare `reconcileRefusals:number` and nothing upstream ever saw the reasons. Proves
  // the per-repo `reconcileRefusalDetails` array is now tagged with `repo` and threaded into this fan-out's own
  // `reconcileRefusals` aggregate, exactly like `dispatched`/`refusals` already are.
  it('threads each repo\'s own reconcileRefusalDetails into a repo-tagged reconcileRefusals aggregate', () => {
    const tick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { dispatched: [], refusals: [], reconcileRefusalDetails: [{ prNumber: 2635, kind: 'owed-ci-rerun', why: 'main was red' }] }
      : { dispatched: [], refusals: [], reconcileRefusalDetails: [] }));
    const out = runReconcileFixDispatchAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.reconcileRefusals).toEqual([
      { repo: 'repo-a', prNumber: 2635, kind: 'owed-ci-rerun', why: 'main was red' },
    ]);
  });

  it('reconcileRefusals is an empty array (never undefined) when a repo result carries no reconcileRefusalDetails at all', () => {
    const tick = vi.fn(() => ({ dispatched: [], refusals: [] })); // no reconcileRefusalDetails key
    const out = runReconcileFixDispatchAllRepos({ repos: ['repo-a'], tick });
    expect(out.reconcileRefusals).toEqual([]);
  });
});

describe('buildCliDaemonEffects — the real-effect factory (heartbeat wiring only; no real dispatch/timer)', () => {
  it('uses its own distinct lease key, never the Dispatcher default sentinel', () => {
    expect(RECONCILE_FIX_DISPATCH_LEASE_KEY).toBe('<conveyor:reconcile-fix-dispatch-daemon-lease>');
  });

  it('defaults the interval to DEFAULT_INTERVAL_MS, matching runner.mjs\'s own tick cadence', () => {
    const effects = buildCliDaemonEffects({ owner: 'x' });
    expect(effects.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(DEFAULT_INTERVAL_MS).toBe(120_000);
  });

  it('exposes the shape runDaemonLoop needs', () => {
    const effects = buildCliDaemonEffects({ owner: 'x' });
    expect(typeof effects.tickOnce).toBe('function');
    expect(typeof effects.sleep).toBe('function');
    expect(typeof effects.heartbeat).toBe('function');
    expect(typeof effects.onTick).toBe('function');
    expect(typeof effects.onTickError).toBe('function');
  });

  it('onTick logs per-repo dispatched/refused counts, mirroring review-daemon\'s own tick log shape (#x1rr9rh)', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [{ repo: 'web-everything/web-everything', result: {} }, { repo: 'plateauapp/plateau-app', error: 'gh: rate limited' }],
      dispatched: [{ pr: 1, repo: 'web-everything/web-everything' }],
      refusals: [{ kind: 'unsupported-repo', prNumber: 2, repo: 'plateauapp/plateau-app' }],
    });
    expect(log.error).toHaveBeenCalledWith(
      'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything, plateauapp/plateau-app) — dispatched 1, refused 1',
    );
    expect(log.error).toHaveBeenCalledWith(
      'reconcile-fix-dispatch-daemon: plateauapp/plateau-app tick failed (non-fatal, other repos unaffected): gh: rate limited',
    );
  });

  // #x0mn6x0 (epic #4075/#3383) — LIVE INCIDENT 2026-09-25: PRs #2635/#2636/#2653 sat `ci:failed` for a full
  // day with the daemon logging only "dispatched 0, refused N" — no way to tell WHY without a live overlay
  // probe. This is the fix: one printed line per refusal, both the dispatch-layer ones (`refusals`) and the
  // reconcile-layer ones that used to be silently collapsed to a count (`reconcileRefusals`).
  it('onTick prints ONE LINE PER REFUSAL (kind, repo, PR, why) — never just the summary count', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [{ repo: 'web-everything/web-everything', result: {} }],
      dispatched: [],
      refusals: [{ kind: 'no-lane', pr: 2636, repo: 'web-everything/web-everything', why: 'no free lane to dispatch a CI-heal agent for PR #2636' }],
      reconcileRefusals: [],
    });
    expect(log.error).toHaveBeenCalledWith(
      'reconcile-fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2636 — no free lane to dispatch a CI-heal agent for PR #2636',
    );
  });

  it('onTick ALSO prints the reconcile-layer refusals (owed-ci-rerun etc.) — previously a bare count, now the real reason', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [{ repo: 'web-everything/web-everything', result: {} }],
      dispatched: [],
      refusals: [],
      reconcileRefusals: [{
        kind: 'owed-ci-rerun', prNumber: 2635, repo: 'web-everything/web-everything',
        why: "the required check failed at 2026-09-25T01:57:47Z, while main's own CI was red",
      }],
    });
    expect(log.error).toHaveBeenCalledWith(
      "reconcile-fix-dispatch-daemon: reconcile-refused owed-ci-rerun web-everything/web-everything PR #2635 — the required check failed at 2026-09-25T01:57:47Z, while main's own CI was red",
    );
  });

  it('onTick never double-prints a tick-failed refusal — the per-repo loop already covers it', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [{ repo: 'frontier-ui/frontierui', error: 'gh: rate limited' }],
      dispatched: [],
      refusals: [{ repo: 'frontier-ui/frontierui', prNumber: null, kind: 'tick-failed', why: 'gh: rate limited' }],
      reconcileRefusals: [],
    });
    const calls = log.error.mock.calls.map((c) => c[0]);
    expect(calls.filter((line) => line.includes('gh: rate limited'))).toHaveLength(1);
  });

  it('onTick tolerates a tick result with no reconcileRefusals key at all (older/injected callers)', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    expect(() => effects.onTick({ repos: [], dispatched: [], refusals: [] })).not.toThrow();
  });
});

// #x0mn6x0 (epic #4075/#3383) — the shared per-refusal-line formatter `onTick` uses for BOTH populations.
describe('formatRefusalLine — one printable line per refusal, whatever layer produced it', () => {
  it('names the live-process holder with its pid and cwd (#5143)', () => {
    expect(formatRefusalLine('reconcile-refused', {
      kind: 'live-process', prNumber: 3794, repo: 'we',
      why: 'a bound session has a LIVE pid', name: 'review-3794', pid: 12345, cwd: '/pool/lane-8',
    })).toBe('reconcile-fix-dispatch-daemon: reconcile-refused live-process we PR #3794 — a bound session has a LIVE pid [name=review-3794 pid=12345 cwd=/pool/lane-8]');
  });

  it('uses readable placeholders for missing live-process holder fields', () => {
    expect(formatRefusalLine('reconcile-refused', { kind: 'live-process', pr: 3794, repo: 'we' }))
      .toBe('reconcile-fix-dispatch-daemon: reconcile-refused live-process we PR #3794 — (no reason given) [name=? pid=absent cwd=?]');
  });

  it('reads pr OR prNumber (the two field names actually used across the fix/ci-heal/reconcile layers)', () => {
    expect(formatRefusalLine('refused', { kind: 'no-lane', pr: 5, repo: 'we', why: 'no free lane' }))
      .toBe('reconcile-fix-dispatch-daemon: refused no-lane we PR #5 — no free lane');
    expect(formatRefusalLine('refused', { kind: 'held', prNumber: 6, repo: 'we', why: 'already in flight' }))
      .toBe('reconcile-fix-dispatch-daemon: refused held we PR #6 — already in flight');
  });

  it('falls back to readable placeholders for a refusal missing a PR number or a reason', () => {
    expect(formatRefusalLine('reconcile-refused', { kind: 'stood-down', repo: 'we' }))
      .toBe('reconcile-fix-dispatch-daemon: reconcile-refused stood-down we (no PR) — (no reason given)');
  });
});

describe('realSleep — regression, live-caught 2026-09-22', () => {
  // The daemon's FIRST real run (launchd-managed, real gh/claude calls) exited right after tick 1 instead of
  // looping: `.unref()`-ing this timer told Node it was fine to exit before it fired, and nothing else in the
  // process keeps the event loop alive between ticks (the spawned agent's stdio is `ignore`d — no other ref'd
  // handle exists). A unit test that only checked `realSleep`'s PROMISE resolved (as this file's earlier tests
  // effectively did, via fakes) could never catch this — the bug is specifically about whether the underlying
  // Node `Timeout` object is ref'd, which only a real, unmocked `setTimeout` reveals.
  it('realSleep\'s own timer is REF\'d — a resident daemon must not let Node exit before it fires', () => {
    const real = global.setTimeout;
    let captured;
    global.setTimeout = (fn, ms) => { captured = real(fn, ms); return captured; };
    try {
      realSleep(60_000); // never awaited — only the timer's own ref state is asserted, then cleared
      expect(captured.hasRef()).toBe(true); // FAILS if realSleep re-adds `.unref()`
    } finally {
      clearTimeout(captured);
      global.setTimeout = real;
    }
  });

  it('realSleep resolves after the real delay and leaves no unref\'d timer behind (smoke test, short delay)', async () => {
    const start = Date.now();
    await realSleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15); // loose bound — real timers, not fake ones
  });
});

// #xngv3vn (epic #3383/#4075) — LIVE incident: an adversarial review found `we:scripts/operations
// /ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch` had NO CALLER in any running daemon, so a PR that fell
// `ci:failed` and was owed a `ci-heal` dispatch by `runReconcilePass`'s own plan just sat there — nothing ever
// ran it. `runReconcileCiHealDispatchAllRepos` is the per-repo fan-out (this daemon's `fix` half already has
// one, `runReconcileFixDispatchAllRepos`); `runTickAllRepos` is what actually reaches the daemon's tick.
describe('runReconcileCiHealDispatchAllRepos — one runReconcileCiHealDispatch call per watched repo, SEQUENTIALLY awaited (#xngv3vn)', () => {
  it('ticks every repo in the list, awaiting each async call, and merges dispatched/refusals with repo attached', async () => {
    const calls = [];
    const tick = vi.fn(async ({ repo }) => {
      calls.push(repo);
      return repo === 'repo-a'
        ? { dispatched: [{ pr: 10 }], refusals: [] }
        : { dispatched: [], refusals: [{ kind: 'unsupported-repo', prNumber: 20 }] };
    });
    const out = await runReconcileCiHealDispatchAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-b' });
    expect(calls).toEqual(['repo-a', 'repo-b']); // sequential, not raced
    expect(out.dispatched).toEqual([{ pr: 10, repo: 'repo-a' }]);
    expect(out.refusals).toEqual([{ kind: 'unsupported-repo', prNumber: 20, repo: 'repo-b' }]);
  });

  it('one repo\'s rejected promise (a gh outage, a stale-checkout refusal) never stops the others — isolated per repo', async () => {
    const tick = vi.fn(async ({ repo }) => {
      if (repo === 'repo-bad') throw new Error('ci-heal-pr-dispatch: behind origin/main');
      return { dispatched: [{ pr: 1 }], refusals: [] };
    });
    const out = await runReconcileCiHealDispatchAllRepos({ repos: ['repo-bad', 'repo-good'], tick });
    expect(out.dispatched).toEqual([{ pr: 1, repo: 'repo-good' }]);
    expect(out.refusals).toEqual([{ repo: 'repo-bad', prNumber: null, kind: 'tick-failed', why: 'ci-heal-pr-dispatch: behind origin/main' }]);
    expect(out.repos[0]).toEqual({ repo: 'repo-bad', error: 'ci-heal-pr-dispatch: behind origin/main' });
  });

  it('defaults to FIX_DISPATCH_DAEMON_REPOS and to the real runReconcileCiHealDispatch when nothing is injected', async () => {
    const tick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const out = await runReconcileCiHealDispatchAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
    expect(out.repos.map((r) => r.repo)).toEqual(FIX_DISPATCH_DAEMON_REPOS);
  });

  // #x0mn6x0 (epic #4075/#3383) — mirrors the fix-side proof above for the ci-heal half.
  it('threads each repo\'s own reconcileRefusalDetails into a repo-tagged reconcileRefusals aggregate', async () => {
    const tick = vi.fn(async ({ repo }) => (repo === 'repo-a'
      ? { dispatched: [], refusals: [], reconcileRefusalDetails: [{ prNumber: 2653, kind: 'nothing-owed', why: 'already queued' }] }
      : { dispatched: [], refusals: [], reconcileRefusalDetails: [] }));
    const out = await runReconcileCiHealDispatchAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.reconcileRefusals).toEqual([
      { repo: 'repo-a', prNumber: 2653, kind: 'nothing-owed', why: 'already queued' },
    ]);
  });
});

// xd1sfms (#4075/#3383) — `runTickAllRepos` now defaults its THIRD tick (hung-ci-recovery) to the REAL
// `sweepHungCiRecovery` too, exactly as it already defaults `fixTick`/`ciHealTick` to their real dispatch
// functions. Every pre-existing test below that supplies fakes for the other two halves must supply one for
// this third half as well, or it falls through to the real (network-calling) implementation — this no-op fake
// is the shared "nothing hung, nothing to do" stand-in for tests that aren't exercising this half at all.
const noopHungCiTick = () => ({ dispatch: [], refusals: [], applied: [] });
const noopMainRedRebaseTick = () => ({ dispatch: [], refusals: [], applied: [] });
// xi4od2p (#4075/#3383) — the daemon's SIXTH half (missing-run recovery). Same reason as the two `noop*Tick`
// stand-ins just above: every pre-existing `runTickAllRepos` call in this suite must supply a fake for this
// half too, or it falls through to the real (network-calling) `sweepMissingRunRecovery` — forbidden in tests.
const noopMissingRunTick = () => ({ dispatch: [], refusals: [], applied: [] });
// #4191 (epic #4075/#3383) — the daemon's fifth half (notes). Every pre-existing `runTickAllRepos` call in this
// describe block predates it and injects only the first four ticks; without also injecting this one, the REAL
// default (`defaultReadNotesForRepo`, a genuine `runReconcilePass` call) runs against these fixtures' fake repo
// names and throws `not a constellation repo` — a tick-failed refusal these tests never expected. See this
// file's own sibling suite (`reconcile-fix-dispatch-daemon-notes.test.mjs`) for the notes half's OWN coverage.
const noopNotesTick = () => ({ notes: [], prsByNumber: new Map() });
// draft-first PRs (operator-approved 2026-09-27) — the daemon's SEVENTH half (promote-draft). Same reason as
// every `noop*Tick` stand-in above: every pre-existing `runTickAllRepos` call in this suite must supply a fake
// for this half too, or it falls through to the real (network-calling) `runReconcilePromoteDraftDispatch`
// against these fixtures' fake repo names and throws `not a constellation repo` — a tick-failed refusal these
// tests never expected.
const noopPromoteDraftTick = () => ({ dispatched: [], refusals: [] });

describe('runTickAllRepos — the daemon tick now runs BOTH fix and ci-heal dispatch, merged (#xngv3vn)', () => {
  it('awaits the async ci-heal half and merges both halves\' dispatched/refusals into one result', async () => {
    const fixTick = vi.fn(({ repo }) => ({ dispatched: repo === 'repo-a' ? [{ pr: 1 }] : [], refusals: [] }));
    const ciHealTick = vi.fn(async ({ repo }) => ({ dispatched: repo === 'repo-b' ? [{ pr: 2 }] : [], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(fixTick).toHaveBeenCalledTimes(2);
    expect(ciHealTick).toHaveBeenCalledTimes(2);
    expect(out.dispatched).toEqual([{ pr: 1, repo: 'repo-a' }, { pr: 2, repo: 'repo-b' }]);
    expect(out.refusals).toEqual([]);
    expect(out.repos.map((r) => r.repo)).toEqual(['repo-a', 'repo-b']);
    expect(out.ciHeal.dispatched).toEqual([{ pr: 2, repo: 'repo-b' }]); // the ci-heal half's own detail survives the merge
  });

  it('a fix-side failure for one repo does not skip that SAME repo\'s ci-heal attempt, and vice versa', async () => {
    const fixTick = vi.fn(({ repo }) => { if (repo === 'repo-a') throw new Error('fix broke'); return { dispatched: [], refusals: [] }; });
    const ciHealTick = vi.fn(async ({ repo }) => {
      if (repo === 'repo-b') throw new Error('ci-heal broke');
      return { dispatched: [{ pr: 9, repo }], refusals: [] };
    });
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(ciHealTick).toHaveBeenCalledWith({ repo: 'repo-a' }); // ci-heal still ran for repo-a despite fix's own failure there
    expect(fixTick).toHaveBeenCalledWith({ repo: 'repo-b' }); // fix still ran for repo-b despite ci-heal's own failure there
    expect(out.refusals).toEqual(expect.arrayContaining([
      { repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'fix broke' },
      { repo: 'repo-b', prNumber: null, kind: 'tick-failed', why: 'ci-heal broke' },
    ]));
    // repo-a's ci-heal succeeded (dispatched a fix's own {pr:9, repo:'repo-a'}) even though repo-a's fix failed.
    expect(out.dispatched).toEqual(expect.arrayContaining([{ pr: 9, repo: 'repo-a' }]));
  });

  // #x0mn6x0 (epic #4075/#3383) — proves runTickAllRepos merges BOTH halves' own reconcileRefusals arrays,
  // exactly as it already merges dispatched/refusals.
  it('merges both halves\' own reconcileRefusals arrays into one', async () => {
    const fixTick = vi.fn(({ repo }) => ({
      dispatched: [], refusals: [],
      reconcileRefusalDetails: repo === 'repo-a' ? [{ prNumber: 1, kind: 'owed-ci-rerun', why: 'fix-side' }] : [],
    }));
    const ciHealTick = vi.fn(async ({ repo }) => ({
      dispatched: [], refusals: [],
      reconcileRefusalDetails: repo === 'repo-b' ? [{ prNumber: 2, kind: 'nothing-owed', why: 'ci-heal-side' }] : [],
    }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(out.reconcileRefusals).toEqual([
      { repo: 'repo-a', prNumber: 1, kind: 'owed-ci-rerun', why: 'fix-side' },
      { repo: 'repo-b', prNumber: 2, kind: 'nothing-owed', why: 'ci-heal-side' },
    ]);
  });

  it('a ci-heal-side stale-main refusal is visible to hasStaleMainRefusal exactly like a fix-side one', async () => {
    let message = null;
    try { assertMainNotStale('/repo', () => ({ action: 'warn', reason: 'diverged', behind: 1, ahead: 5, dirty: false })); }
    catch (e) { message = e.message; }
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    // The ci-heal half throws the REAL `assertMainNotStale` refusal — `ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch`
    // calls that same guard near its own top, exactly as `runReconcileFixDispatch` already does.
    const ciHealTick = vi.fn(async () => { throw new Error(message); });
    const out = await runTickAllRepos({
      repos: ['web-everything/web-everything'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    // Proves the WIRING: hasStaleMainRefusal reads whatever `runTickAllRepos` puts in `.refusals`, regardless
    // of which half (fix or ci-heal) produced it — a ci-heal-side entry is never dropped or siloed from the
    // SAME self-resync signal (`withSelfSync`'s `hasStaleRefusal` option) a fix-side one already triggers.
    expect(hasStaleMainRefusal(out)).toBe(true);
  });
});

describe('runTickAllRepos — dispatch-time review-status tagging (#3383 follow-up, live-caught 2026-09-26: a ci-heal dispatched for PR #2771 by THIS daemon at 18:06 ET carried no review-status label while the separate Review daemon\'s own tick was stuck behind an unbounded session-reap)', () => {
  it('omitting tagDispatchStatus (every pre-existing caller/test) never calls it — byte-identical to before this option existed', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [{ pr: 1 }], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(out.statusTags).toEqual([]);
  });

  it('tags every dispatched fix AND ci-heal PR this tick, right at dispatch — never waiting on the Review daemon\'s own tick', async () => {
    const fixTick = vi.fn(({ repo }) => ({ dispatched: repo === 'repo-a' ? [{ pr: 1 }] : [], refusals: [] }));
    const ciHealTick = vi.fn(async ({ repo }) => ({ dispatched: repo === 'repo-b' ? [{ pr: 2771 }] : [], refusals: [] }));
    const tagDispatchStatus = vi.fn(({ pr }) => ({ changed: true, label: `review-status:fixing`, removed: [], pr }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
      tagDispatchStatus,
    });
    expect(tagDispatchStatus).toHaveBeenCalledWith({ pr: 1, repo: 'repo-a' });
    expect(tagDispatchStatus).toHaveBeenCalledWith({ pr: 2771, repo: 'repo-b' });
    expect(out.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ pr: 1, repo: 'repo-a', changed: true, label: 'review-status:fixing' }),
      expect.objectContaining({ pr: 2771, repo: 'repo-b', changed: true, label: 'review-status:fixing' }),
    ]));
  });

  it('a tag failure is cosmetic — reported in statusTags, never thrown, never drops the dispatch itself', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [{ pr: 7 }], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const tagDispatchStatus = vi.fn(() => { throw new Error('gh: rate limited'); });
    const out = await runTickAllRepos({
      repos: ['repo-a'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
      tagDispatchStatus,
    });
    expect(out.dispatched).toEqual([{ pr: 7, repo: 'repo-a' }]); // the dispatch itself is unaffected
    expect(out.statusTags).toEqual([{ pr: 7, repo: 'repo-a', changed: false, error: 'gh: rate limited' }]);
  });

  it('never tags a mechanical hungCi/mainRedRebase/missingRun action — those carry no live session for review-status to describe', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const hungCiTick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [{ prNumber: 55, ok: true, action: 'cancel-rerun' }] }));
    const tagDispatchStatus = vi.fn();
    const out = await runTickAllRepos({
      repos: ['repo-a'], fixTick, ciHealTick, hungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
      tagDispatchStatus,
    });
    expect(tagDispatchStatus).not.toHaveBeenCalled();
    expect(out.statusTags).toEqual([]);
  });

  it('defaultTagDispatchStatus calls the real applyReviewStatus with state "fixing"', () => {
    expect(defaultTagDispatchStatus).toBeTypeOf('function');
    // Source-contract proof (real `gh`/label IO is unsafe to run in a unit test — same norm this file's own
    // #xngv3vn suite above already documents): confirms the wiring without executing it.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');
    const start = src.indexOf('export function defaultTagDispatchStatus(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/applyReviewStatus\(\{ pr, repo, state: 'fixing' \}\)/);
  });
});

// Card x5kagse (epic #4075/#3383) — the follow-up to #2717: while the operator's Claude login is broken, `fix`
// and `ci-heal` (the two halves that dispatch a FRESH Claude session) must be skipped OUTRIGHT, never merely
// attempted — see `we:scripts/conveyor/claude-auth-health.mjs`'s own file header for the full incident and
// design. `authGateOverride` is this test suite's injection point for the gate decision.
describe('runTickAllRepos — the Claude-auth-broken gate skips fix/ci-heal dispatch outright (card x5kagse)', () => {
  it('paused: neither fixTick nor ciHealTick is ever called, and both report empty dispatched/refusals', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [{ pr: 999 }], refusals: [{ kind: 'should-never-run' }] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [{ pr: 998 }], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick,
      hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
      authGateOverride: () => ({ paused: true, reason: 'paused: Claude login expired — run /login' }),
    });
    expect(fixTick).not.toHaveBeenCalled();
    expect(ciHealTick).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
    expect(out.refusals).toEqual([]);
    expect(out.authPaused).toBe(true);
    expect(out.authPauseReason).toBe('paused: Claude login expired — run /login');
    // the mechanical (non-dispatching) halves still ran — the login break does not touch them.
    expect(out.repos.map((r) => r.repo)).toEqual(['repo-a', 'repo-b']);
  });

  it('not paused: authGateOverride reporting healthy runs fix/ci-heal exactly as before (no behavior change)', async () => {
    const fixTick = vi.fn(({ repo }) => ({ dispatched: repo === 'repo-a' ? [{ pr: 1 }] : [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick,
      hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
      authGateOverride: () => ({ paused: false, reason: null }),
    });
    expect(fixTick).toHaveBeenCalledTimes(2);
    expect(ciHealTick).toHaveBeenCalledTimes(2);
    expect(out.dispatched).toEqual([{ pr: 1, repo: 'repo-a' }]);
    expect(out.authPaused).toBe(false);
    expect(out.authPauseReason).toBeNull();
  });

  it('with neither fixTick nor ciHealTick nor authGateOverride injected, the gate defaults to not-paused rather than shelling out (test hermeticity)', async () => {
    // Both dispatch ticks ARE injected here (fixTick/ciHealTick), so per this file's own "only read when a real
    // tick runs" rule the gate never calls the real IO-backed `planClaudeAuthDispatchGate` — proven indirectly:
    // this test has no `claude`/`gh` on PATH beyond whatever the host happens to have, and it still resolves
    // instantly to unpaused rather than blocking on/erroring out of a real child-process probe.
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(out.authPaused).toBe(false);
    expect(fixTick).toHaveBeenCalledTimes(1);
    expect(ciHealTick).toHaveBeenCalledTimes(1);
  });
});

describe('buildCliDaemonEffects — onTick logs the exact pause line when authPaused (card x5kagse)', () => {
  it('logs the required wording when result.authPaused is true', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'test-owner', log });
    effects.onTick({
      repos: [{ repo: 'web-everything/web-everything' }], dispatched: [], refusals: [], reconcileRefusals: [],
      authPaused: true, authPauseReason: 'paused: Claude login expired — run /login',
    });
    expect(log.error).toHaveBeenCalledWith('reconcile-fix-dispatch-daemon: paused: Claude login expired — run /login');
  });

  it('logs nothing extra when not paused', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'test-owner', log });
    effects.onTick({
      repos: [{ repo: 'web-everything/web-everything' }], dispatched: [], refusals: [], reconcileRefusals: [], authPaused: false,
    });
    expect(log.error.mock.calls.some((c) => String(c[0]).includes('paused: Claude login expired'))).toBe(false);
  });
});

// #xngv3vn — SOURCE-CONTRACT proof that the REAL `buildCliDaemonEffects` (no injection point for its own
// `tickOnce`, which always builds the real dispatch functions — see this file's existing `buildCliDaemonEffects`
// suite, which deliberately never CALLS `tickOnce`, only checks its shape, for the same reason) is wired to
// `runTickAllRepos` and not to the old fix-only `runReconcileFixDispatchAllRepos()` call it used to make. This
// mirrors this repo's own established norm for proving a call-site wiring fact inside code that is expensive or
// unsafe to execute directly in a unit test (see e.g. `merge-ai-prs-ai-detection-and-drain-ordering.test.mjs`'s
// #984 F2 block, or this fix's sibling `merge-ai-prs-merge-trace-post-confirm.test.mjs`).
describe('withFixDispatchClaimRefresh — dup-heal-dispatch: refreshes live claims before the wrapped tick runs', () => {
  it('calls refresh BEFORE delegating to the wrapped tickOnce, and forwards its result', async () => {
    const order = [];
    const effects = {
      tickOnce: async () => { order.push('tick'); return { ok: true }; },
      other: 'kept-as-is',
    };
    const refresh = () => { order.push('refresh'); return { checked: 1, refreshed: [{ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A' }] }; };
    const wrapped = withFixDispatchClaimRefresh(effects, { log: { error: vi.fn() }, refresh });
    expect(wrapped.other).toBe('kept-as-is'); // every other effect passes through untouched.
    const result = await wrapped.tickOnce();
    expect(order).toEqual(['refresh', 'tick']);
    expect(result).toEqual({ ok: true });
  });

  it('logs settled overlap releases before running the next admission pass', async () => {
    const log = { error: vi.fn() };
    const refresh = () => ({ refreshed: [], released: [{ repo: 'we', pr: 3103, kind: 'fix' }] });
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: async () => {
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('released settled claim fix-3103 (we) — overlap slot free'));
    } }, { log, refresh });
    await wrapped.tickOnce();
  });

  it('logs one line per refreshed claim', async () => {
    const log = { error: vi.fn() };
    const refresh = () => ({ checked: 1, refreshed: [{ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'Mac:123' }] });
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: async () => ({}) }, { log, refresh });
    await wrapped.tickOnce();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('refreshed live claim ci-heal-2784'));
  });

  it('a refresh failure is logged, non-fatal — the wrapped tick still runs', async () => {
    const log = { error: vi.fn() };
    const refresh = () => { throw new Error('claude agents hiccup'); };
    let ticked = false;
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: async () => { ticked = true; return {}; } }, { log, refresh });
    await wrapped.tickOnce();
    expect(ticked).toBe(true);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('fix-dispatch claim refresh failed (non-fatal)'));
  });

  // PR #2789 review (antigravity) — an async refresh must be awaited, never iterate a Promise (TypeError).
  it('an ASYNC refresh is awaited — its refreshed rows are logged and the tick still runs', async () => {
    const log = { error: vi.fn() };
    const refresh = async () => ({ checked: 1, refreshed: [{ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A' }] });
    let ticked = false;
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: async () => { ticked = true; return {}; } }, { log, refresh });
    await wrapped.tickOnce();
    expect(ticked).toBe(true);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('refreshed live claim ci-heal-2784'));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('refresh failed'));
  });
});

describe('buildCliDaemonEffects — tickOnce is wired to runTickAllRepos, not the old fix-only call (#xngv3vn)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');

  it('tickOnce calls runTickAllRepos(), wired to the real dispatch-time status-tag effect (#3383 follow-up)', () => {
    const m = src.match(/tickOnce: \(\) => (\w+)\(([^)]*)\),/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('runTickAllRepos');
    // #3383 follow-up (live-caught 2026-09-26, PR #2771) — the real daemon must opt INTO dispatch-time status
    // tagging (`runTickAllRepos`'s own `tagDispatchStatus` stays `null`-default for every OTHER caller/test —
    // see that param's own docblock), never leave it at the pure core's safe-for-tests default.
    expect(m[2]).toMatch(/tagDispatchStatus:\s*defaultTagDispatchStatus/);
  });

  it('runTickAllRepos itself calls BOTH runReconcileFixDispatchAllRepos and runReconcileCiHealDispatchAllRepos', () => {
    const start = src.indexOf('export async function runTickAllRepos(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/runReconcileFixDispatchAllRepos\(/);
    expect(body).toMatch(/await runReconcileCiHealDispatchAllRepos\(/);
  });
});

// xd1sfms (epic #4075/#3383) — LIVE INCIDENT 2026-09-25: PR #2636's `test-shard (1)` job (run 36161558017) sat
// `in_progress` 3h+ with NO daemon ever noticing, because `we:scripts/conveyor/ci-red-recovery-watch.mjs
// #sweepHungCiRecovery` (the hung-run cancel+rerun pass) had no live caller — its own `daemon-manifest.mjs`
// entry has no launchd job installed. This daemon (confirmed live and ticking) is where it now runs instead.
// Mirrors `runReconcileCiHealDispatchAllRepos`'s own per-repo fan-out test shape exactly.
describe('runHungCiRecoveryAllRepos — one sweepHungCiRecovery call per watched repo, apply always true (xd1sfms)', () => {
  it('calls tick once per repo, ALWAYS with apply:true — a daemon\'s whole point is to actually act', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    runHungCiRecoveryAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-a', apply: true });
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-b', apply: true });
  });

  it('maps each applied action to a repo-tagged dispatched row, kind reflecting ok vs the failed action', () => {
    const tick = vi.fn(({ repo }) => ({
      dispatch: [], refusals: [],
      applied: repo === 'repo-a'
        ? [{ prNumber: 1, runId: 10, ok: true, action: 'cancelled-and-rerun', why: 'stuck' }]
        : [{ prNumber: 2, runId: 20, ok: false, action: 'cancel-failed', error: 'boom', why: 'stuck too' }],
    }));
    const out = runHungCiRecoveryAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.dispatched).toEqual([
      { prNumber: 1, runId: 10, ok: true, action: 'cancelled-and-rerun', why: 'stuck', repo: 'repo-a', kind: 'hung-cancel-rerun' },
      { prNumber: 2, runId: 20, ok: false, action: 'cancel-failed', error: 'boom', why: 'stuck too', repo: 'repo-b', kind: 'hung-cancel-failed' },
    ]);
  });

  // xd1sfms follow-up (live 2026-09-25, #2636 hung twice on the same shard) — an applied row's OWN `kind` (the
  // plan's real classification, e.g. `repeat-hang`) must survive this mapping verbatim, never overwritten by
  // the ok/action heuristic — the heuristic is a fallback for an older fixture that supplies no `kind` at all.
  it('preserves an applied row\'s OWN kind (e.g. repeat-hang) rather than re-deriving it from ok/action', () => {
    const tick = vi.fn(() => ({
      dispatch: [], refusals: [],
      applied: [{
        prNumber: 2636, runId: 36187480460, ok: true, action: 'cancelled-no-rerun', kind: 'repeat-hang', why: 'job hung twice',
      }],
    }));
    const out = runHungCiRecoveryAllRepos({ repos: ['web-everything/web-everything'], tick });
    expect(out.dispatched).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'repeat-hang', action: 'cancelled-no-rerun' })]);
  });

  it('drops the ordinary not-hung refusal (the expected case for almost every PR on almost every tick) but keeps a real one', () => {
    const tick = vi.fn(() => ({
      dispatch: [], applied: [],
      refusals: [
        { prNumber: 1, kind: 'not-hung', why: 'fine' },
        { prNumber: 2, kind: 'hung-cap-exhausted', why: 'cap hit' },
      ],
    }));
    const out = runHungCiRecoveryAllRepos({ repos: ['repo-a'], tick });
    expect(out.refusals).toEqual([{ prNumber: 2, kind: 'hung-cap-exhausted', why: 'cap hit', repo: 'repo-a' }]);
  });

  it('one repo\'s sweep failure never blocks another repo\'s — reported as tick-failed', () => {
    const tick = vi.fn(({ repo }) => { if (repo === 'repo-bad') throw new Error('gh outage'); return { dispatch: [], refusals: [], applied: [] }; });
    const out = runHungCiRecoveryAllRepos({ repos: ['repo-bad', 'repo-good'], tick });
    expect(out.refusals).toEqual([{ repo: 'repo-bad', prNumber: null, kind: 'tick-failed', why: 'gh outage' }]);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-good', apply: true });
  });

  it('defaults repos to FIX_DISPATCH_DAEMON_REPOS — every watched repo, not just WE', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    runHungCiRecoveryAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
  });
});

describe('runTickAllRepos — now runs THREE halves: fix, ci-heal, and hung-ci-recovery (xd1sfms)', () => {
  it('merges the hung-ci half\'s dispatched/refusals into the tick\'s own top-level arrays, and keeps its own detail at .hungCi', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const hungCiTick = vi.fn(({ repo }) => ({
      dispatch: [], refusals: [],
      applied: repo === 'repo-a' ? [{ prNumber: 5, runId: 50, ok: true, action: 'cancelled-and-rerun', why: 'stuck' }] : [],
    }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(out.dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ prNumber: 5, runId: 50, repo: 'repo-a', kind: 'hung-cancel-rerun' }),
    ]));
    expect(out.hungCi.dispatched).toEqual([
      expect.objectContaining({ prNumber: 5, runId: 50, repo: 'repo-a' }),
    ]);
  });

  it('a hung-ci-side failure for one repo does not skip that SAME repo\'s fix/ci-heal attempt, and vice versa', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const hungCiTick = vi.fn(({ repo }) => { if (repo === 'repo-a') throw new Error('hung-ci broke'); return { dispatch: [], refusals: [], applied: [] }; });
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(fixTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(ciHealTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(out.refusals).toEqual(expect.arrayContaining([{ repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'hung-ci broke' }]));
  });
});

describe('formatHungActionLine — one printable line per hung-run action, with its reason (xd1sfms)', () => {
  it('prints a successful action with its reason', () => {
    const line = formatHungActionLine({
      repo: 'web-everything/web-everything', prNumber: 2636, runId: 36161558017, ok: true, action: 'cancelled-and-rerun', why: 'stuck 3h',
    });
    expect(line).toContain('PR #2636');
    expect(line).toContain('run 36161558017');
    expect(line).toContain('applied cancelled-and-rerun');
    expect(line).toContain('stuck 3h');
  });

  it('prints a FAILED action with its error AND its reason — never silently dropped', () => {
    const line = formatHungActionLine({
      repo: 'web-everything/web-everything', prNumber: 2636, runId: 1, ok: false, action: 'cancel-failed', error: 'gh: not found', why: 'stuck 3h',
    });
    expect(line).toContain('FAILED cancel-failed');
    expect(line).toContain('gh: not found');
    expect(line).toContain('stuck 3h');
  });
});

// SOURCE-CONTRACT proof, mirroring this file's own existing `buildCliDaemonEffects` wiring suite above: proves
// `runTickAllRepos` really calls `runHungCiRecoveryAllRepos`, not just that a test CAN inject a fake for it.
describe('runTickAllRepos — source contract: really calls runHungCiRecoveryAllRepos (xd1sfms)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');

  it('runTickAllRepos itself calls runHungCiRecoveryAllRepos', () => {
    const start = src.indexOf('export async function runTickAllRepos(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/runHungCiRecoveryAllRepos\(/);
  });

  it('onTick logs one line per hung-run action via formatHungActionLine', () => {
    expect(src).toMatch(/for \(const a of \(hungCi\?\.dispatched \?\? \[\]\)\) log\.error\(formatHungActionLine\(a\)\);/);
  });
});

// x5uqim1 follow-up (#4075/#3383) — LIVE INCIDENT 2026-09-25 ~18:52 ET: PR #2685 logged `reconcile-refused
// owed-ci-rerun` on EVERY tick of this exact daemon while nothing performed the mechanical rebase it names.
// `sweepCiRedRecovery` already existed but had no caller in any running process — this daemon is now that
// caller, mirroring `runHungCiRecoveryAllRepos`'s own wiring exactly (both ride this same live daemon because
// their own `daemon-manifest.mjs` entries have no launchd job installed).
describe('runMainRedRebaseAllRepos — one sweepCiRedRecovery call per watched repo, apply always true (x5uqim1 follow-up)', () => {
  it('calls tick once per repo, ALWAYS with apply:true — nothing else ever performs this rebase', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    runMainRedRebaseAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-a', apply: true });
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-b', apply: true });
  });

  it('maps each applied rebase to a repo-tagged dispatched row', () => {
    const tick = vi.fn(({ repo }) => ({
      dispatch: [], refusals: [],
      applied: repo === 'repo-a' ? [{ prNumber: 2685, headRefName: 'lane/xgqz204', ok: true, action: 'rebased' }] : [],
    }));
    const out = runMainRedRebaseAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.dispatched).toEqual([
      { prNumber: 2685, headRefName: 'lane/xgqz204', ok: true, action: 'rebased', repo: 'repo-a', kind: 'rebase-onto-main' },
    ]);
  });

  it('one repo\'s sweep failure never blocks another repo\'s — reported as tick-failed', () => {
    const tick = vi.fn(({ repo }) => { if (repo === 'repo-bad') throw new Error('gh outage'); return { dispatch: [], refusals: [], applied: [] }; });
    const out = runMainRedRebaseAllRepos({ repos: ['repo-bad', 'repo-good'], tick });
    expect(out.refusals).toEqual([{ repo: 'repo-bad', prNumber: null, kind: 'tick-failed', why: 'gh outage' }]);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-good', apply: true });
  });

  it('defaults repos to FIX_DISPATCH_DAEMON_REPOS — every watched repo, not just WE (part (c): frontierui/plateau-app too)', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    runMainRedRebaseAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
  });
});

describe('runTickAllRepos — now runs FOUR halves: fix, ci-heal, hung-ci-recovery, and main-red-rebase (x5uqim1 follow-up)', () => {
  it('merges the main-red-rebase half\'s dispatched/refusals into the tick\'s own top-level arrays, and keeps its own detail at .mainRedRebase', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const mainRedRebaseTick = vi.fn(({ repo }) => ({
      dispatch: [], refusals: [],
      applied: repo === 'repo-a' ? [{ prNumber: 2685, headRefName: 'lane/xgqz204', ok: true, action: 'rebased' }] : [],
    }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick,
      missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(out.dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ prNumber: 2685, repo: 'repo-a', kind: 'rebase-onto-main' }),
    ]));
    expect(out.mainRedRebase.dispatched).toEqual([
      expect.objectContaining({ prNumber: 2685, repo: 'repo-a' }),
    ]);
  });

  it('a main-red-rebase-side failure for one repo does not skip that SAME repo\'s other halves, and vice versa', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const mainRedRebaseTick = vi.fn(({ repo }) => { if (repo === 'repo-a') throw new Error('rebase broke'); return { dispatch: [], refusals: [], applied: [] }; });
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick, mainRedRebaseTick,
      missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(fixTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(ciHealTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(out.refusals).toEqual(expect.arrayContaining([{ repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'rebase broke' }]));
  });
});

describe('formatMainRedRebaseActionLine — one printable line per mechanical-rebase action (x5uqim1 follow-up)', () => {
  it('prints a successful action', () => {
    const line = formatMainRedRebaseActionLine({
      repo: 'web-everything/web-everything', prNumber: 2685, headRefName: 'lane/xgqz204', ok: true, action: 'rebased',
    });
    expect(line).toContain('PR #2685');
    expect(line).toContain('lane/xgqz204');
    expect(line).toContain('applied rebased');
  });

  it('prints a FAILED action with its error', () => {
    const line = formatMainRedRebaseActionLine({
      repo: 'web-everything/web-everything', prNumber: 2685, headRefName: 'lane/xgqz204', ok: false, action: 'error', error: 'merge conflict',
    });
    expect(line).toContain('FAILED error');
    expect(line).toContain('merge conflict');
  });
});

// SOURCE-CONTRACT proof, mirroring the hung-ci-recovery suite above.
describe('runTickAllRepos — source contract: really calls runMainRedRebaseAllRepos (x5uqim1 follow-up)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');

  it('runTickAllRepos itself calls runMainRedRebaseAllRepos', () => {
    const start = src.indexOf('export async function runTickAllRepos(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/runMainRedRebaseAllRepos\(/);
  });

  it('onTick logs one line per rebase action via formatMainRedRebaseActionLine', () => {
    expect(src).toMatch(/for \(const a of \(mainRedRebase\?\.dispatched \?\? \[\]\)\) log\.error\(formatMainRedRebaseActionLine\(a\)\);/);
  });
});

// xi4od2p (#4075/#3383) — the daemon's SIXTH half: missing-run recovery (PR web-everything/web-everything#2729's LIVE
// incident — a required check that never even started). Mirrors {@link runMainRedRebaseAllRepos}'s own suite
// shape exactly: per-repo isolation via injected `tick`, then a `runTickAllRepos` merge proof, then a
// source-contract proof — same reason this half rides THIS daemon (no launchd job installs `pass-daemon.mjs`
// for its own `daemon-manifest.mjs` entry).
describe('runMissingRunRecoveryAllRepos — one sweepMissingRunRecovery call per watched repo, apply always true (xi4od2p)', () => {
  it('calls tick once per repo, ALWAYS with apply:true — nothing else ever performs this trigger', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    runMissingRunRecoveryAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-a', apply: true });
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-b', apply: true });
  });

  it('maps each applied trigger to a repo-tagged dispatched row', () => {
    const tick = vi.fn(({ repo }) => ({
      dispatch: [], refusals: [],
      applied: repo === 'repo-a' ? [{ prNumber: 2729, headRefName: 'lane/4166-x', ok: true, action: 'update-branch', labelCleared: true }] : [],
    }));
    const out = runMissingRunRecoveryAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.dispatched).toEqual([
      { prNumber: 2729, headRefName: 'lane/4166-x', ok: true, action: 'update-branch', labelCleared: true, repo: 'repo-a', kind: 'trigger-ci' },
    ]);
  });

  it('one repo\'s sweep failure never blocks another repo\'s — reported as tick-failed', () => {
    const tick = vi.fn(({ repo }) => { if (repo === 'repo-bad') throw new Error('gh outage'); return { dispatch: [], refusals: [], applied: [] }; });
    const out = runMissingRunRecoveryAllRepos({ repos: ['repo-bad', 'repo-good'], tick });
    expect(out.refusals).toEqual([{ repo: 'repo-bad', prNumber: null, kind: 'tick-failed', why: 'gh outage' }]);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-good', apply: true });
  });

  it('drops a not-overdue refusal from its own refusals (the ordinary case for almost every open PR on almost every tick)', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [{ prNumber: 1, kind: 'not-overdue', why: 'too soon' }], applied: [] }));
    const out = runMissingRunRecoveryAllRepos({ repos: ['repo-a'], tick });
    expect(out.refusals).toEqual([]);
  });

  it('defaults repos to FIX_DISPATCH_DAEMON_REPOS — every watched repo', () => {
    const tick = vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    runMissingRunRecoveryAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
  });
});

describe('runTickAllRepos — now runs SIX halves, missing-run-recovery included (xi4od2p)', () => {
  it('merges the missing-run half\'s dispatched/refusals into the tick\'s own top-level arrays, and keeps its own detail at .missingRun', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const missingRunTick = vi.fn(({ repo }) => ({
      dispatch: [], refusals: [],
      applied: repo === 'repo-a' ? [{ prNumber: 2729, headRefName: 'lane/4166-x', ok: true, action: 'update-branch', labelCleared: true }] : [],
    }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick,
      mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(out.dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ prNumber: 2729, repo: 'repo-a', kind: 'trigger-ci' }),
    ]));
    expect(out.missingRun.dispatched).toEqual([
      expect.objectContaining({ prNumber: 2729, repo: 'repo-a' }),
    ]);
  });

  it('a missing-run-side failure for one repo does not skip that SAME repo\'s other halves, and vice versa', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const missingRunTick = vi.fn(({ repo }) => { if (repo === 'repo-a') throw new Error('trigger broke'); return { dispatch: [], refusals: [], applied: [] }; });
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick,
      mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick, notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick,
    });
    expect(fixTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(ciHealTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(out.refusals).toEqual(expect.arrayContaining([{ repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'trigger broke' }]));
  });
});

// draft-first PRs (operator-approved 2026-09-27) — a same-day coordinator review caught that the promotion
// effect (`gh pr ready` on a draft whose required checks are all green) had been wired ONLY into
// `skills-src/conveyor/runner.mjs`, the headless conveyor runner — which has NO LIVE SINGLETON LEASE on this
// host today. THIS daemon (`reconcile-fix-dispatch-daemon.mjs`) is the one confirmed live, so the promotion
// pass now rides its tick too, mirroring `missingRun`'s own precedent exactly. These tests prove THIS daemon's
// tick actually performs the promotion — not merely that the underlying dispatcher can (that is
// `promote-draft-pr-dispatch.test.mjs`'s job).
describe('runPromoteDraftDispatchAllRepos (draft-first PRs)', () => {
  it('calls the tick once per repo and merges dispatched/refusals, repo-tagged', () => {
    const tick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { dispatched: [{ pr: 101, kind: 'promote-draft' }], refusals: [] }
      : { dispatched: [], refusals: [{ pr: 202, kind: 'ready-failed', why: 'gh hiccup' }] }));
    const out = runPromoteDraftDispatchAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(out.dispatched).toEqual([{ pr: 101, kind: 'promote-draft', repo: 'repo-a' }]);
    expect(out.refusals).toEqual([{ pr: 202, kind: 'ready-failed', why: 'gh hiccup', repo: 'repo-b' }]);
  });

  it('a per-repo tick failure isolates to that repo, as `tick-failed`, never aborting the rest', () => {
    const tick = vi.fn(({ repo }) => { if (repo === 'repo-a') throw new Error('promote broke'); return { dispatched: [], refusals: [] }; });
    const out = runPromoteDraftDispatchAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.refusals).toEqual([{ repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'promote-draft half: promote broke' }]);
  });

  it('defaults repos to FIX_DISPATCH_DAEMON_REPOS — every watched repo', () => {
    const tick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    runPromoteDraftDispatchAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
  });
});

// LIVE INCIDENT 2026-10-03 (PR #3806, the fix for main's red CI, sat green-but-draft 15+ min): the promote half
// threw the stale-main guard every tick and the daemon logged NOTHING for it — a `tick-failed` refusal from any
// half but the fix half was skipped as "already printed". Every promote outcome must reach the log.
describe('onTick — every promote-draft outcome is logged (#3806 incident)', () => {
  const REPO = 'web-everything/web-everything';
  const tickOf = (over) => {
    const log = { error: vi.fn() };
    buildCliDaemonEffects({ owner: 'x', log }).onTick({ repos: [{ repo: REPO, result: {} }], dispatched: [], refusals: [], reconcileRefusals: [], ...over });
    return log.error.mock.calls.map((c) => c[0]);
  };

  it('logs a promote-half tick failure (stale-main) that the fix half\'s per-repo error line does not cover', () => {
    const lines = tickOf({ refusals: [{ repo: REPO, prNumber: null, kind: 'tick-failed', why: 'promote-draft half: promote-draft: the dispatching checkout is 2 commit(s) behind origin/main' }] });
    expect(lines).toContain(`reconcile-fix-dispatch-daemon: refused tick-failed ${REPO} (no PR) — promote-draft half: promote-draft: the dispatching checkout is 2 commit(s) behind origin/main`);
  });

  it('does not print the same tick failure twice when the fix half already printed it per repo', () => {
    const lines = tickOf({
      repos: [{ repo: REPO, error: 'boom' }],
      refusals: [{ repo: REPO, prNumber: null, kind: 'tick-failed', why: 'boom' }],
    });
    expect(lines.filter((l) => l.includes('boom'))).toHaveLength(1);
  });

  it('logs one line per promoted draft', () => {
    const lines = tickOf({ promoteDraft: { dispatched: [{ pr: 3806, kind: 'promote-draft', repo: REPO }] }, dispatched: [{ pr: 3806, kind: 'promote-draft', repo: REPO }] });
    expect(lines).toContain(formatPromoteActionLine({ pr: 3806, repo: REPO }));
    expect(formatPromoteActionLine({ pr: 3806, repo: REPO })).toMatch(/promoted web-everything\/web-everything PR #3806 to ready for review/);
  });

  it('logs a draft the promote half did not promote, with its reason', () => {
    const lines = tickOf({ refusals: [{ repo: REPO, pr: 3805, kind: 'draft-not-promoted', why: 'draft left as is: its required checks read pending, not green' }] });
    expect(lines.some((l) => l.includes('refused draft-not-promoted') && l.includes('PR #3805') && l.includes('pending'))).toBe(true);
  });
});

describe('runTickAllRepos — draft-first PRs: the promote-draft half rides THIS daemon\'s tick (operator-approved 2026-09-27)', () => {
  it('THE PROOF: a draft PR promote-draft dispatch reaches the tick\'s own top-level dispatched array and its own .promoteDraft detail', async () => {
    const fixTick = vi.fn(() => ({ dispatched: [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const promoteDraftTick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { dispatched: [{ pr: 2813, kind: 'promote-draft' }], refusals: [] }
      : { dispatched: [], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick,
      mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick,
      promoteDraftTick,
    });
    expect(promoteDraftTick).toHaveBeenCalledTimes(2);
    expect(out.dispatched).toEqual(expect.arrayContaining([
      { pr: 2813, kind: 'promote-draft', repo: 'repo-a' },
    ]));
    expect(out.promoteDraft.dispatched).toEqual([{ pr: 2813, kind: 'promote-draft', repo: 'repo-a' }]);
  });

  it('a promote-draft-side failure for one repo does not skip that SAME repo\'s other halves, and vice versa', async () => {
    const fixTick = vi.fn(({ repo }) => ({ dispatched: repo === 'repo-a' ? [{ pr: 1 }] : [], refusals: [] }));
    const ciHealTick = vi.fn(async () => ({ dispatched: [], refusals: [] }));
    const promoteDraftTick = vi.fn(({ repo }) => { if (repo === 'repo-a') throw new Error('promote broke'); return { dispatched: [], refusals: [] }; });
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], fixTick, ciHealTick, hungCiTick: noopHungCiTick,
      mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick: noopNotesTick,
      promoteDraftTick,
    });
    expect(fixTick).toHaveBeenCalledWith({ repo: 'repo-a' });
    expect(out.dispatched).toEqual(expect.arrayContaining([{ pr: 1, repo: 'repo-a' }]));
    expect(out.refusals).toEqual(expect.arrayContaining([{ repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'promote-draft half: promote broke' }]));
  });

  it('is UNPAUSED by the Claude-auth-broken gate — no Claude session is ever spawned by this half', async () => {
    const promoteDraftTick = vi.fn(({ repo }) => (repo === 'repo-a' ? { dispatched: [{ pr: 2813, kind: 'promote-draft' }], refusals: [] } : { dispatched: [], refusals: [] }));
    const out = await runTickAllRepos({
      repos: ['repo-a', 'repo-b'], hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick,
      missingRunTick: noopMissingRunTick, notesTick: noopNotesTick, promoteDraftTick,
      authGateOverride: () => ({ paused: true, reason: 'paused: Claude login expired' }),
    });
    expect(out.authPaused).toBe(true);
    expect(promoteDraftTick).toHaveBeenCalledTimes(2); // NOT skipped, unlike fix/ci-heal
    expect(out.dispatched).toEqual(expect.arrayContaining([{ pr: 2813, kind: 'promote-draft', repo: 'repo-a' }]));
  });
});

describe('formatMissingRunActionLine — one printable line per missing-run-trigger action, including the label-clear note (xi4od2p)', () => {
  it('prints a successful action with the label-cleared note', () => {
    const line = formatMissingRunActionLine({
      repo: 'web-everything/web-everything', prNumber: 2729, headRefName: 'lane/4166-x', ok: true, action: 'update-branch',
      labelCleared: true, why: 'no run at all',
    });
    expect(line).toContain('PR #2729');
    expect(line).toContain('lane/4166-x');
    expect(line).toContain('applied update-branch');
    expect(line).toContain('cleared stale checking label');
    expect(line).toContain('no run at all');
  });

  it('prints a FAILED action with its error, and no label-cleared note when nothing was cleared', () => {
    const line = formatMissingRunActionLine({
      repo: 'web-everything/web-everything', prNumber: 2729, headRefName: 'lane/4166-x', ok: false, action: 'workflow-dispatch',
      labelCleared: false, error: 'workflow not found',
    });
    expect(line).toContain('FAILED workflow-dispatch');
    expect(line).toContain('workflow not found');
    expect(line).not.toContain('cleared stale checking label');
  });
});

// SOURCE-CONTRACT proof, mirroring the main-red-rebase suite above.
describe('runTickAllRepos — source contract: really calls runMissingRunRecoveryAllRepos (xi4od2p)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');

  it('runTickAllRepos itself calls runMissingRunRecoveryAllRepos', () => {
    const start = src.indexOf('export async function runTickAllRepos(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/runMissingRunRecoveryAllRepos\(/);
  });

  it('onTick logs one line per missing-run action via formatMissingRunActionLine', () => {
    expect(src).toMatch(/for \(const a of \(missingRun\?\.dispatched \?\? \[\]\)\) log\.error\(formatMissingRunActionLine\(a\)\);/);
  });
});

 it('logs computed scope ranks from the real per-repo tick result shape', () => {
  const log = { error: vi.fn() };
  buildCliDaemonEffects({ owner: 'x', log }).onTick({ repos: [{ repo: 'web-everything/web-everything',
    result: { scopeRanks: [{ pr: 3311, rank: 1, blocks: 5, ageHours: 2, score: 7, aged: false }] } }] });
  expect(log.error).toHaveBeenCalledWith('reconcile-fix-dispatch-daemon: scope-rank web-everything/web-everything PR #3311 — rank 1, blocks 5, age 2h, score 7, aged-FIFO false');
});

// #5137 slices 2+3 review — the verify-verdict pass is wired FIRST in the tick, and a paused login defers only
// the resume (`allowResume`), never the push. Without this a dropped/reordered call leaves every test green while
// fixers end their turn awaiting a verdict nothing acts on.
describe('runTickAllRepos — the await-verify verdict pass wiring (#5137)', () => {
  const tickOpts = (calls, extra = {}) => ({
    repos: ['repo-a'],
    fixTick: vi.fn(() => { calls.push('fix'); return { dispatched: [], refusals: [] }; }),
    ciHealTick: vi.fn(async () => { calls.push('ci-heal'); return { dispatched: [], refusals: [] }; }),
    hungCiTick: noopHungCiTick, mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick,
    notesTick: noopNotesTick, promoteDraftTick: noopPromoteDraftTick, ...extra,
  });

  it('unpaused login: the pass runs BEFORE the dispatch ticks with allowResume true, and its rows ride on the result', async () => {
    const calls = [];
    const awaitVerifyTick = vi.fn(async (arg) => { calls.push('await-verify'); return { rows: [{ pr: 7, action: 'push', arg }] }; });
    const out = await runTickAllRepos(tickOpts(calls, { awaitVerifyTick, authGateOverride: () => ({ paused: false, reason: null }) }));
    expect(awaitVerifyTick).toHaveBeenCalledTimes(1);
    expect(awaitVerifyTick).toHaveBeenCalledWith({ allowResume: true });
    expect(calls).toEqual(['await-verify', 'fix', 'ci-heal']);
    expect(out.awaitVerify.rows).toHaveLength(1);
  });

  it('paused login: the pass STILL runs (the push needs no login) but is told allowResume false', async () => {
    const calls = [];
    const awaitVerifyTick = vi.fn(async () => { calls.push('await-verify'); return { rows: [] }; });
    const out = await runTickAllRepos(tickOpts(calls, { awaitVerifyTick, authGateOverride: () => ({ paused: true, reason: 'paused' }) }));
    expect(awaitVerifyTick).toHaveBeenCalledWith({ allowResume: false });
    expect(calls).toEqual(['await-verify']); // dispatch halves skipped while paused, the pass was not
    expect(out.awaitVerify).toEqual({ rows: [] });
  });
});

// xn025gx — the push-on-green loop and the active-only fix slot are wired into the real tick and main().
// PR #4510 review (correctness, test-coverage): the glue was guarded only by source-text regexes, which a refactor that
// keeps the text but changes behaviour would pass. The glue is now three factories, each driven here with real behaviour.
describe('xn025gx glue — buildAwaitVerifyStep, buildFixThrottle, buildDaemonExits', () => {
  it('buildAwaitVerifyStep forwards allowResume exactly as given and hands the core the legacy pass as its fallback', async () => {
    const run = vi.fn(async () => ({ rows: [] }));
    const legacyPass = vi.fn();
    const step = buildAwaitVerifyStep({ run, legacyPass });
    await step({ allowResume: false });
    await step({ allowResume: true });
    expect(run.mock.calls).toEqual([[{ allowResume: false, legacyPass }], [{ allowResume: true, legacyPass }]]);
  });
  it('buildAwaitVerifyStep over the real core, every push-on-green setting off: the legacy pass runs with the allowResume it was given', async () => {
    const { runTickAwaitVerify } = await import('../../../scripts/conveyor/await-verify-loop.mjs');
    const legacyPass = vi.fn(async () => ({ rows: [{ legacy: true }] }));
    // every setting off → the core calls the legacy pass with the allowResume it was given
    const env = { WE_AWAIT_VERIFY_LOOP_SECONDS: '0', WE_FIX_PARKED_RELEASES_SLOT: 'off', WE_FIX_RELEASE_ON_COMPLETION: 'off' };
    const out = await buildAwaitVerifyStep({ run: (a) => runTickAwaitVerify({ ...a, env }), legacyPass })({ allowResume: false });
    expect(out).toEqual({ rows: [{ legacy: true }] });
    expect(legacyPass).toHaveBeenCalledWith({ allowResume: false });
  });
  it('buildFixThrottle counts the fix cap with the injected active-only claim list, not the raw one', () => {
    const fix = { meta: { kind: 'fix', repo: 'we', pr: 1 } };
    const base = { env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '1' }, sample: () => null, loadavg: () => 0, cpuCount: () => 8, alive: () => true };
    const full = buildFixThrottle({ ...base, slotClaims: () => [fix] }).tryAdmit('fix');
    expect(full).toMatchObject({ admit: false, kind: 'fix-cap' });
    const parkedGaveItBack = buildFixThrottle({ ...base, slotClaims: () => [] }).tryAdmit('fix');
    expect(parkedGaveItBack.admit).toBe(true);
  });
  it('buildDaemonExits: both exits stop the loop child BEFORE releasing the lease and exiting; a second signal is a no-op', () => {
    const calls = [];
    const make = () => buildDaemonExits({
      awaitLoop: { stop: () => calls.push('stop') }, releaseLease: () => calls.push('release'), exit: (c) => calls.push(`exit:${c}`), log: { error: (l) => calls.push(`log:${l.split(' — ')[0].split(': ')[1]}`) },
    });
    const a = make();
    expect(a.isStopping()).toBe(false);
    a.shutdown('SIGTERM');
    a.shutdown('SIGINT');
    expect(calls).toEqual(['stop', 'log:SIGTERM', 'release', 'exit:0']);
    expect(a.isStopping()).toBe(true);
    calls.length = 0;
    const b = make();
    b.restartOntoNewCode();
    expect(calls).toEqual(['stop', 'release', 'exit:0']);
    expect(b.isStopping()).toBe(true);
  });
  it('buildDaemonExits.loopEnded: the third exit (runDaemonLoop returned on its own) also stops the loop child, then releases the lease; after a signal it only stops', () => {
    const calls = [];
    const make = () => buildDaemonExits({
      awaitLoop: { stop: () => calls.push('stop') }, releaseLease: () => calls.push('release'), exit: (c) => calls.push(`exit:${c}`), log: { error: (l) => calls.push(l.includes('loop stopped (crashed)') ? 'log:loop-stopped' : 'log:other') },
    });
    make().loopEnded('crashed');
    expect(calls).toEqual(['stop', 'log:loop-stopped', 'release']);
    calls.length = 0;
    const b = make();
    b.shutdown('SIGTERM');
    calls.length = 0;
    b.loopEnded('signal');
    expect(calls).toEqual(['stop']); // shutdown already released and exited
  });
  it('the tick and main() call the factories (thin call-site checks; the behaviour is above)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');
    expect(src).toMatch(/buildAwaitVerifyStep\(\)\(\{ allowResume: !authGate\.paused \}\)/);
    expect(src).toMatch(/queueAdmission \? buildFixThrottle\(\) : null/);
    expect(src).toMatch(/const exits = buildDaemonExits\(\{ awaitLoop,/);
    expect(src).toMatch(/\n  awaitLoop\.start\(\);\n/);
  });
});
