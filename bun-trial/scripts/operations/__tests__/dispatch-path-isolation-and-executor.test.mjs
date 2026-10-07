/**
 * @file dispatch-path-isolation-and-executor.test.mjs — build-path-codex-isolation.
 *
 * Three fixes, one live incident (2026-09-27, #3604): `run.mjs dispatch-lane` was run from a checkout 449
 * commits behind origin/main, so a codex-marked card ran as a `claude --bg` session that then stalled on Claude
 * Code's "Call EnterWorktree first" guard.
 *
 *   (a) EVERY dispatch path (build, ci-heal, fix, review) turns the bg-isolation guard off for its own session
 *       through the ONE shared helper `isolateDispatchSession` — proven per path with the REAL helper writing a
 *       real `settings.local.json` into a temp session cwd, plus the `--settings` flag on the real argv.
 *   (b) The run record names what ran the dispatch in ONE field, `executor`, reported by the provider that
 *       started it (a codex-marked mechanical build says `codex`; a `claude --bg` spawn says `claude`).
 *   (c) `dispatch-lane` refuses to run from stale code (`assertDispatcherFresh`, wired by `run.mjs#cliPreflight`).
 */

import { describe, it, test, expect, afterEach, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DISPATCH_EFFECT } from '../../../../scripts/operations/dispatch-lane.mjs';
import {
  assertDispatcherFresh, createDispatchSinks, dispatchExecutorFor, routeDispatchProvider,
} from '../../../../scripts/operations/dispatch-lane-io.mjs';
import { wrapperExecutorFor } from '../../../../scripts/operations/detached-dispatch.mjs';
import { deliverItemDetachedProvider } from '../../../../scripts/operations/dispatch-providers/build.mjs';
import { dispatchCiHeal } from '../../../../scripts/operations/ci-heal-pr-dispatch.mjs';
import { dispatchReview } from '../../../../scripts/operations/review-dispatch.mjs';
import { dispatchFix } from '../../../../scripts/conveyor/reconcile-fix-dispatch.mjs';
import { isolateDispatchSession } from '../../../../scripts/lib/dispatch-bg-isolation.mjs';
import { cliPreflight } from '../../../../scripts/operations/run.mjs';

const tmps = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), `build-path-codex-isolation-${p}-`)); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop(), { recursive: true, force: true }); });

const onDisk = (cwd) => JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
const settingsArg = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]);
const FRESH = () => ({ fresh: true, behind: 0 });

describe('isolateDispatchSession — the one shared helper', () => {
  it('writes the override into the session cwd AND returns the --settings patch', () => {
    const cwd = tmp('helper');
    const out = isolateDispatchSession(cwd);
    expect(out.worktreeSettings).toEqual({ bgIsolation: 'none' });
    expect(out.write.ok).toBe(true);
    expect(onDisk(cwd).worktree).toEqual({ bgIsolation: 'none' });
  });
});

describe('(a) every dispatch path isolates its session through the shared helper', () => {
  it('build — the dispatch-lane sink', async () => {
    const cwd = tmp('build');
    let seen = null;
    const sinks = createDispatchSinks({
      root: '/repo', modes: {}, mintSessionId: () => 'sid-build',
      sessionCwdFor: () => cwd, ensureSessionCwd: (d) => d,
      grantLanePermission: () => {}, resolveSettingsEnv: () => null,
      spawnAgent: (argv) => { seen = argv; return 'backgrounded · 1ae0905c · conveyor-9001\n'; },
    });
    await sinks[DISPATCH_EFFECT]({ prompt: '# build 9001', sessionSlug: 'conveyor-9001', num: '9001', launchKind: 'build', lane: 3 });
    expect(onDisk(cwd).worktree).toEqual({ bgIsolation: 'none' });
    expect(settingsArg(seen).worktree).toEqual({ bgIsolation: 'none' });
  });

  it('ci-heal — dispatchCiHeal through the same sink', async () => {
    const cwd = tmp('ciheal');
    let seen = null;
    const sinks = createDispatchSinks({
      root: '/repo', modes: {}, mintSessionId: () => 'sid-ciheal',
      sessionCwdFor: () => cwd, ensureSessionCwd: (d) => d,
      grantLanePermission: () => {}, resolveSettingsEnv: () => null,
      spawnAgent: (argv) => { seen = argv; return 'backgrounded · 2be0905c · ci-heal-743\n'; },
    });
    await dispatchCiHeal(
      { itemNum: '2638', pr: 743, laneRef: 'lane/2638-x', scope: ['we:scripts/a.mjs'], lane: 9 },
      {
        readBrief: () => 'heal #{{ITEM_NUM}} pr={{PR_NUM}} ref={{LANE_REF}} lane={{LANE}} slug={{SESSION_SLUG}} scope={{SCOPE}} why={{REASON}}',
        sinks, claimRoot: tmp('ciheal-claims'),
      },
    );
    expect(seen).not.toBeNull();
    expect(onDisk(cwd).worktree).toEqual({ bgIsolation: 'none' });
    expect(settingsArg(seen).worktree).toEqual({ bgIsolation: 'none' });
  });

  it('fix — reconcile-fix-dispatch#dispatchFix (the conveyor fix path; had NO override before)', () => {
    const cwd = tmp('fix');
    const isolateSession = mock(isolateDispatchSession);
    let seen = null;
    dispatchFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-x', scope: ['we:x'], lane: 9 },
      {
        root: '/repo', mintSessionId: () => 'sid-fix', claimRoot: tmp('fix-claims'),
        readBrief: () => '# fix {{PR_NUM}} {{ITEM_NUM}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}',
        sessionCwdFor: () => cwd, ensureSessionCwd: (d) => d, resolveSettingsEnv: () => null,
        spawnAgent: (argv) => { seen = argv; return ''; },
        isolateSession,
      },
    );
    expect(isolateSession).toHaveBeenCalledWith(cwd);
    expect(onDisk(cwd).worktree).toEqual({ bgIsolation: 'none' });
    expect(settingsArg(seen).worktree).toEqual({ bgIsolation: 'none' });
  });

  it('review — review-dispatch#dispatchReview (had NO override before)', () => {
    const cwd = tmp('review');
    const isolateSession = mock(isolateDispatchSession);
    let seen = null;
    dispatchReview({
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo', checkStaleness: FRESH,
      ciGate: () => ({ allowed: true, headSha: 'a'.repeat(40) }),
      readBrief: () => '# review {{PR}} {{REPO}} {{SESSION_SLUG}}',
      mintSessionId: () => 'sid-review',
      sessionCwdFor: () => cwd, ensureSessionCwd: (d) => d, resolveSettingsEnv: () => null,
      spawnAgent: (argv) => { seen = argv; return ''; },
      isolateSession,
    });
    expect(isolateSession).toHaveBeenCalledWith(cwd);
    expect(onDisk(cwd).worktree).toEqual({ bgIsolation: 'none' });
    expect(settingsArg(seen).worktree).toEqual({ bgIsolation: 'none' });
  });
});

describe('(b) the run record names the executor in ONE field', () => {
  it('a codex-marked mechanical build reports executor=codex, and the record carries no routed/executed pair', async () => {
    const spawned = [];
    const registry = {
      build: {
        kind: 'build', modeEnv: 'WE_BUILD_DISPATCH_MODE', defaultMode: 'agent', runScript: '/fake/deliver-item-run.mjs',
        provider: (request) => deliverItemDetachedProvider(request, {
          spawnDetached: (argv) => { spawned.push(argv); return { pid: 4242 }; },
          logPathFor: () => '/dev/null',
          readDeliveryAgentMarker: () => 'codex',
        }),
      },
    };
    const sinks = createDispatchSinks({
      root: '/repo', modes: { build: 'mechanical' }, registry, scriptExists: () => true,
      mintSessionId: () => 'sid-exec', sessionCwdFor: () => tmp('exec'), ensureSessionCwd: (d) => d,
      grantLanePermission: () => {}, resolveSettingsEnv: () => null,
      spawnAgent: () => { throw new Error('the claude path must not run for a mechanical build'); },
    });
    const out = await sinks[DISPATCH_EFFECT]({
      prompt: '# build 3604', sessionSlug: 'conveyor-3604', num: '3604', launchKind: 'build', lane: 3, scope: 'plateau-app:src/x.ts',
      routing: { routed: 'claude', executed: 'codex' },
    });
    expect(spawned[0]).toContain('--provider=codex');
    expect(out.dispatch.executor).toBe('codex');
    expect(out.dispatch.route).toBe('detached');
    expect(out.dispatch).not.toHaveProperty('routedProvider');
    expect(out.dispatch).not.toHaveProperty('executedProvider');
    expect(out.dispatch.criteriaRecommendation).toBe('claude');
  });

  it('a claude --bg spawn reports executor=claude', async () => {
    const sinks = createDispatchSinks({
      root: '/repo', modes: {}, mintSessionId: () => 'sid-c', sessionCwdFor: () => tmp('execc'), ensureSessionCwd: (d) => d,
      grantLanePermission: () => {}, resolveSettingsEnv: () => null,
      spawnAgent: () => 'backgrounded · 3ce0905c · conveyor-9002\n',
    });
    const out = await sinks[DISPATCH_EFFECT]({ prompt: '# b', sessionSlug: 'conveyor-9002', num: '9002', launchKind: 'build', lane: 4 });
    expect(out.dispatch.executor).toBe('claude');
  });

  it('dispatchExecutorFor / wrapperExecutorFor — the pure answers', () => {
    expect(dispatchExecutorFor({ route: 'detached', reported: 'codex' })).toBe('codex');
    expect(dispatchExecutorFor({ route: 'claude-bg' })).toBe('claude');
    expect(dispatchExecutorFor({ route: 'detached' })).toBe('unknown');
    expect(wrapperExecutorFor('codex')).toBe('codex');
    expect(wrapperExecutorFor('claude-restricted')).toBe('claude');
    expect(wrapperExecutorFor(null)).toBe('claude');
  });

  it('routeDispatchProvider still sends an agent-mode build to the claude path', () => {
    const agent = mock(() => 'h');
    routeDispatchProvider({ launchKind: 'build' }, { modes: { build: 'agent' }, agent });
    expect(agent).toHaveBeenCalledTimes(1);
  });
});

describe('(c) dispatch-lane refuses to run from stale code', () => {
  it('the #3604 case: a DETACHED HEAD that origin/main has moved code past is refused', () => {
    expect(() => assertDispatcherFresh('/primary', {
      assertNotStale: () => ({ fresh: true }),
      headBranch: () => null,
      behindCodeFiles: () => ['scripts/operations/dispatch-provider-registry.mjs', 'scripts/lib/dispatch-bg-isolation.mjs'],
    })).toThrow(/DETACHED.*STALE code/s);
  });

  it('the shared chokepoint guard runs first, and its refusal stands', () => {
    expect(() => assertDispatcherFresh('/primary', {
      assertNotStale: () => { throw new Error('dispatch-lane: the dispatching checkout is 1292 commit(s) behind'); },
      headBranch: () => { throw new Error('must not be reached'); },
    })).toThrow(/1292 commit\(s\) behind/);
  });

  it('a checkout ON main is judged by the shared guard alone (no second check)', () => {
    const behindCodeFiles = mock(() => ['x.mjs']);
    expect(assertDispatcherFresh('/daemon', { assertNotStale: () => ({ fresh: true }), headBranch: () => 'main', behindCodeFiles }))
      .toEqual({ ok: true });
    expect(behindCodeFiles).not.toHaveBeenCalled();
  });

  it('a branch only AHEAD of origin/main (an unmerged fix) may dispatch; an unreadable diff fails soft', () => {
    const base = { assertNotStale: () => ({ fresh: true }), headBranch: () => 'lane/build-path-codex-isolation' };
    expect(assertDispatcherFresh('/c', { ...base, behindCodeFiles: () => [] })).toEqual({ ok: true });
    expect(assertDispatcherFresh('/c', { ...base, behindCodeFiles: () => null })).toEqual({ ok: true });
  });

  it('run.mjs#cliPreflight arms re-exec and runs the freshness check for dispatch-lane only', () => {
    const arm = mock();
    const assertFresh = mock();
    expect(cliPreflight('dispatch-lane', { arm, assertFresh })).toBe(true);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(assertFresh).toHaveBeenCalledTimes(1);
    expect(cliPreflight('pr-status', { arm, assertFresh })).toBe(false);
    expect(assertFresh).toHaveBeenCalledTimes(1);
  });
});

// These legacy cases exercise the native adapter; Codex routing has a dedicated dry-run suite.
mock.module('../../../../scripts/lib/dispatch-provider-availability.mjs', () => ({ dispatchProviderAvailable: provider => provider === 'claude' }));
