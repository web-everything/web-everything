/**
 * @file scripts/lib/__tests__/daemon-live-smoke.test.mjs
 * @description #3383 — the live smoke gate a daemon clone runs after a self-sync merge, before restarting onto
 *   it. Every check runs through an INJECTED `runChild` here (never a real child process) so this suite is
 *   hermetic and fast; the real live behavior (a real lane-pool lease, a real `gh` call, a real reconcile-pass
 *   dry-run) is proven separately as a one-off script against a real/throwaway clone (see the PR body), not in
 *   vitest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  decideSmokeVerdict, resolveSmokeBudgets, SMOKE_BUDGET_ENV, isSmokeGateDisabled, SMOKE_KILL_SWITCH_ENV,
  runLiveSmoke, SMOKE_CHECKS, rollbackToSha, readRejectedSha, recordRejectedSha, clearRejectedSha,
  smokeStatePath, gateMergedCommit,
} from '../daemon-live-smoke.mjs';

describe('decideSmokeVerdict — pure', () => {
  it('every check passing → pass', () => expect(decideSmokeVerdict([{ ok: true }, { ok: true }])).toBe(true));
  it('one check failing → fail', () => expect(decideSmokeVerdict([{ ok: true }, { ok: false }])).toBe(false));
  it('an empty result set is never a pass — no checks run is not "nothing to complain about"', () => expect(decideSmokeVerdict([])).toBe(false));
});

describe('isSmokeGateDisabled / resolveSmokeBudgets — pure, env-driven', () => {
  it('unset → not disabled', () => expect(isSmokeGateDisabled({})).toBe(false));
  it.each(['1', 'true', 'yes', 'TRUE', 'Yes'])('%s → disabled', (v) => expect(isSmokeGateDisabled({ [SMOKE_KILL_SWITCH_ENV]: v })).toBe(true));
  it.each(['0', 'false', 'no', ''])('%j → not disabled', (v) => expect(isSmokeGateDisabled({ [SMOKE_KILL_SWITCH_ENV]: v })).toBe(false));

  it('every budget has a sane positive default with no env set', () => {
    const b = resolveSmokeBudgets({});
    for (const v of Object.values(b)) expect(v).toBeGreaterThan(0);
  });
  it('each budget is independently overridable via its own env var', () => {
    for (const [key, envVar] of Object.entries(SMOKE_BUDGET_ENV)) {
      const b = resolveSmokeBudgets({ [envVar]: '12345' });
      expect(b[key]).toBe(12345);
    }
  });
  it('a non-numeric override falls back to the default rather than NaN/0', () => {
    const b = resolveSmokeBudgets({ [SMOKE_BUDGET_ENV.ghApiMs]: 'not-a-number' });
    expect(b.ghApiMs).toBe(30_000);
  });
});

describe('runLiveSmoke — injected runChild', () => {
  const passingRunChild = vi.fn(async (cmd, args) => {
    if (cmd === 'node' && args[0] === 'scripts/lane-pool.mjs' && args[1] === 'list') return '[]';
    if (cmd === 'node' && args[1] === 'acquire') return JSON.stringify({ lane: 7 });
    return '';
  });

  it('the kill switch skips every check and passes unconditionally', async () => {
    const runChild = vi.fn();
    const result = await runLiveSmoke({ root: '/x', env: { [SMOKE_KILL_SWITCH_ENV]: '1' }, runChild });
    expect(result).toEqual({ pass: true, disabled: true, results: [], sessionSlug: null });
    expect(runChild).not.toHaveBeenCalled();
  });

  it('every check passing → pass, one result row per check, in order', async () => {
    const result = await runLiveSmoke({ root: '/x', env: {}, runChild: passingRunChild });
    expect(result.pass).toBe(true);
    expect(result.disabled).toBe(false);
    expect(result.results.map((r) => r.name)).toEqual(SMOKE_CHECKS.map((c) => c.name));
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(typeof result.sessionSlug).toBe('string');
  });

  it('the lane acquire uses a unique --session slug and is released with the SAME lane number + slug', async () => {
    const calls = [];
    const runChild = vi.fn(async (cmd, args) => {
      calls.push(args);
      if (args[1] === 'list') return '[]';
      if (args[1] === 'acquire') return JSON.stringify({ lane: 12 });
      return '';
    });
    await runLiveSmoke({ root: '/x', env: {}, runChild });
    const acquireArgs = calls.find((a) => a[1] === 'acquire');
    const releaseArgs = calls.find((a) => a[1] === 'release');
    const sessionFromAcquire = acquireArgs.find((a) => a.startsWith('--session='));
    const sessionFromRelease = releaseArgs.find((a) => a.startsWith('--session='));
    expect(sessionFromAcquire).toBeDefined();
    expect(sessionFromAcquire).toBe(sessionFromRelease);
    expect(releaseArgs).toContain('--lane=12');
  });

  it('a single failing check fails the WHOLE gate, but every other check still runs (no fail-fast)', async () => {
    const runChild = vi.fn(async (cmd, args) => {
      if (cmd === 'node' && args[1] === 'list') throw new Error('boom: list failed');
      if (cmd === 'node' && args[1] === 'acquire') return JSON.stringify({ lane: 1 });
      return '';
    });
    const result = await runLiveSmoke({ root: '/x', env: {}, runChild });
    expect(result.pass).toBe(false);
    expect(result.results).toHaveLength(SMOKE_CHECKS.length); // every check still ran
    expect(result.results.find((r) => r.name === 'lane-pool-list').ok).toBe(false);
    expect(result.results.filter((r) => r.name !== 'lane-pool-list').every((r) => r.ok)).toBe(true);
  });

  it('a lane acquired but never released fails the gate (a leaked lease is a real problem, not a footnote)', async () => {
    const runChild = vi.fn(async (cmd, args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'acquire') return JSON.stringify({ lane: 3 });
      if (args[1] === 'release') throw new Error('release timed out');
      return '';
    });
    const result = await runLiveSmoke({ root: '/x', env: {}, runChild });
    const laneCheck = result.results.find((r) => r.name === 'lane-acquire-release');
    expect(laneCheck.ok).toBe(false);
    expect(laneCheck.detail).toMatch(/release failed/);
    expect(result.pass).toBe(false);
  });

  it('a check that THROWS is caught and recorded as a failure, not an uncaught rejection', async () => {
    const runChild = vi.fn(async () => { throw new Error('spawn ENOENT'); });
    const result = await runLiveSmoke({ root: '/x', env: {}, runChild });
    expect(result.pass).toBe(false);
    expect(result.results.every((r) => typeof r.detail === 'string')).toBe(true);
  });

  it('the reconcile check runs one dry-run per configured repo and reports how many failed', async () => {
    const seenRepos = [];
    const runChild = vi.fn(async (cmd, args) => {
      if (args[0] === 'scripts/conveyor/reconcile-pass.mjs') {
        seenRepos.push(args[1]);
        if (args[1].includes('frontierui')) throw new Error('gh: 401');
        return '{}';
      }
      if (args[1] === 'list') return '[]';
      if (args[1] === 'acquire') return JSON.stringify({ lane: 1 });
      return '';
    });
    const result = await runLiveSmoke({ root: '/x', env: {}, runChild });
    expect(seenRepos.length).toBe(3); // we, frontierui, plateau-app
    const reconcileCheck = result.results.find((r) => r.name === 'reconcile-dry-run');
    expect(reconcileCheck.ok).toBe(false);
    expect(reconcileCheck.detail).toMatch(/1\/3/);
  });
});

describe('rollbackToSha — fail-closed on an unverified tree', () => {
  it('no sha at all → refuses', () => expect(rollbackToSha({ root: '/x', sha: null })).toEqual({ ok: false, reason: 'no-sha' }));
  it('a dirty tree is never reset', () => {
    const run = vi.fn(() => ({ status: 0, stdout: ' M file.txt\n' }));
    expect(rollbackToSha({ root: '/x', sha: 'abc', run })).toEqual({ ok: false, reason: 'dirty' });
  });
  it('an unreadable tree state (status failed) is never reset — fails closed, not "assume clean"', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '' }));
    expect(rollbackToSha({ root: '/x', sha: 'abc', run })).toEqual({ ok: false, reason: 'status-failed' });
  });
  it('a clean tree resets to the given sha', () => {
    const calls = [];
    const run = vi.fn((args) => { calls.push(args); return { status: 0, stdout: '' }; });
    expect(rollbackToSha({ root: '/x', sha: 'abc123', run })).toEqual({ ok: true });
    expect(calls).toContainEqual(['reset', '--hard', 'abc123']);
  });
  it('a failed reset is reported, not silently swallowed', () => {
    const run = vi.fn((args) => (args[0] === 'reset' ? { status: 1, stdout: '' } : { status: 0, stdout: '' }));
    expect(rollbackToSha({ root: '/x', sha: 'abc', run })).toEqual({ ok: false, reason: 'reset-failed' });
  });
});

describe('reject-cache — read/record/clear, keyed by clone path, OUTSIDE the checkout', () => {
  let stateDir;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'smoke-state-')); });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it('nothing recorded yet → null', () => expect(readRejectedSha('/some/clone', { WE_DAEMON_SMOKE_STATE_DIR: stateDir })).toBeNull());

  it('record then read round-trips the sha', () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    expect(recordRejectedSha('/some/clone', 'deadbeef', { env })).toBe(true);
    expect(readRejectedSha('/some/clone', env)).toBe('deadbeef');
  });

  it('clear resets it back to null', () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    recordRejectedSha('/some/clone', 'deadbeef', { env });
    clearRejectedSha('/some/clone', env);
    expect(readRejectedSha('/some/clone', env)).toBeNull();
  });

  it('two different clone roots never collide', () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    recordRejectedSha('/clone/a', 'sha-a', { env });
    recordRejectedSha('/clone/b', 'sha-b', { env });
    expect(readRejectedSha('/clone/a', env)).toBe('sha-a');
    expect(readRejectedSha('/clone/b', env)).toBe('sha-b');
  });

  it('the state file lives OUTSIDE the given root — it would never show up in that clone\'s own `git status`', () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    const root = '/some/clone/under/test';
    const p = smokeStatePath(root, env);
    expect(p.startsWith(root)).toBe(false);
    expect(p.startsWith(stateDir)).toBe(true);
  });

  it('an unreadable/corrupt cache file reads as null, never throws', () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: join(stateDir, 'does-not-exist') };
    expect(() => readRejectedSha('/x', env)).not.toThrow();
    expect(readRejectedSha('/x', env)).toBeNull();
  });
});

describe('gateMergedCommit — the one entry point daemon-self-sync.mjs and daemon-load-overlay.mjs both call', () => {
  let stateDir;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'gate-state-')); });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  const cleanRun = vi.fn((args) => (args[0] === 'status' ? { status: 0, stdout: '' } : { status: 0, stdout: '' }));

  it('kill switch → adopts unconditionally, never even reads the reject-cache or runs a child', async () => {
    const runChild = vi.fn();
    const verdict = await gateMergedCommit({
      root: '/x', preMergeSha: 'pre', mergedIdentitySha: 'merged', env: { [SMOKE_KILL_SWITCH_ENV]: '1' }, runChild, run: cleanRun,
    });
    expect(verdict).toEqual({ adopt: true, reason: 'kill-switch-disabled' });
    expect(runChild).not.toHaveBeenCalled();
  });

  it('smoke passes → adopts, and clears any prior rejection for this clone', async () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    recordRejectedSha('/x', 'some-older-bad-sha', { env });
    const runChild = vi.fn(async () => JSON.stringify({ lane: 1 }));
    const verdict = await gateMergedCommit({ root: '/x', preMergeSha: 'pre', mergedIdentitySha: 'good-sha', env, runChild, run: cleanRun });
    expect(verdict.adopt).toBe(true);
    expect(readRejectedSha('/x', env)).toBeNull();
  });

  it('smoke fails → rejects, rolls back to preMergeSha, and records the rejected sha', async () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    const resetCalls = [];
    const run = (args) => { if (args[0] === 'reset') resetCalls.push(args); return { status: 0, stdout: '' }; };
    const runChild = vi.fn(async (cmd, args) => { if (args[1] === 'list') throw new Error('broken'); if (args[1] === 'acquire') return JSON.stringify({ lane: 1 }); return ''; });
    const verdict = await gateMergedCommit({ root: '/x', preMergeSha: 'pre-sha', mergedIdentitySha: 'bad-sha', env, runChild, run });
    expect(verdict.adopt).toBe(false);
    expect(verdict.reason).toBe('smoke-fail');
    expect(resetCalls).toContainEqual(['reset', '--hard', 'pre-sha']);
    expect(readRejectedSha('/x', env)).toBe('bad-sha');
  });

  it('the SAME rejected sha on a later call short-circuits — rolls back WITHOUT re-running the live smoke', async () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    recordRejectedSha('/x', 'still-bad', { env });
    const runChild = vi.fn();
    const resetCalls = [];
    const run = (args) => { if (args[0] === 'reset') resetCalls.push(args); return { status: 0, stdout: '' }; };
    const verdict = await gateMergedCommit({ root: '/x', preMergeSha: 'pre-sha-2', mergedIdentitySha: 'still-bad', env, runChild, run });
    expect(verdict.adopt).toBe(false);
    expect(verdict.reason).toBe('still-rejected');
    expect(runChild).not.toHaveBeenCalled(); // no live smoke re-run
    expect(resetCalls).toContainEqual(['reset', '--hard', 'pre-sha-2']);
  });

  it('a DIFFERENT sha than the one on record re-runs the smoke (main moved) rather than short-circuiting', async () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    recordRejectedSha('/x', 'old-bad-sha', { env });
    const runChild = vi.fn(async () => JSON.stringify({ lane: 1 }));
    const verdict = await gateMergedCommit({ root: '/x', preMergeSha: 'pre', mergedIdentitySha: 'a-new-sha', env, runChild, run: cleanRun });
    expect(runChild).toHaveBeenCalled();
    expect(verdict.adopt).toBe(true);
  });

  it('a failed rollback is reported, never silently swallowed', async () => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: stateDir };
    const run = (args) => (args[0] === 'reset' ? { status: 1, stdout: '' } : { status: 0, stdout: '' });
    const runChild = vi.fn(async (cmd, args) => { if (args[1] === 'list') throw new Error('broken'); if (args[1] === 'acquire') return JSON.stringify({ lane: 1 }); return ''; });
    const log = { error: vi.fn() };
    const verdict = await gateMergedCommit({ root: '/x', preMergeSha: 'pre', mergedIdentitySha: 'bad', env, runChild, run, log });
    expect(verdict.rollback).toEqual({ ok: false, reason: 'reset-failed' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK FAILED'));
  });
});
