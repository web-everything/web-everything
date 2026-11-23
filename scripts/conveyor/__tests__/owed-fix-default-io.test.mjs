import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as underTest from '../../lib/under-test.mjs';
import { runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';
import { acquireFixDispatchClaim } from '../fix-dispatch-claim.mjs';
import { fixDispatchClaimRoot, fixDispatchResource, readFixDispatchClaim } from '../fix-claim-store.mjs';
import { lockDirFor, reserve } from '../../readiness/file-locks.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { rememberOwedFixRecoveryInput } from '../reconcile-pass.mjs';
import { recoveryTransaction } from '../owed-fix-recovery.mjs';

const head = 'a'.repeat(40), start = Date.parse('2026-11-20T12:00:00Z'), minute = 60_000;
let root;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function fixture(claimKind = 'fixing') {
  root = mkdtempSync(join(tmpdir(), 'owed-default-io-'));
  vi.stubEnv('WE_COORDINATION_ROOT', join(root, 'coordination'));
  vi.stubEnv('WE_DAEMON_STATE_DIR', join(root, 'daemon'));
  vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', join(root, 'gh-throttle'));
  vi.stubEnv('WE_MAINTENANCE_MARKER', join(root, 'maintenance.json'));
  vi.stubEnv('WE_NEEDS_YOU_FEED', join(root, 'needs-you.jsonl'));
  // Isolate the default handoff path without replacing its resolver or changing HOME.
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  // Exercise the consumer's omitted-option default; leave every recovery IO function at its production default.
  vi.spyOn(underTest, 'isUnderTest').mockReturnValue(false);
  const facts = { headRefOid: head, state: 'OPEN', isDraft: false, labels: [{ name: 'review:changes' }] };
  const gh = vi.fn((command, args, options) => {
    expect(command).toBe('gh');
    expect(args).toEqual(['pr', 'view', '7307', '--repo', 'web-everything/web-everything',
      '--json', 'headRefOid,state,isDraft,labels']);
    expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.stringify(facts);
  });
  const auth = vi.fn((command, args, options) => {
    expect(command).toBe('claude');
    expect(args).toEqual(['auth', 'status', '--json']);
    expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 64 * 1024 });
    return JSON.stringify({ loggedIn: true });
  });
  // Patch the native exports as well as the module object: setup can preload parts of the daemon graph.
  // Both gh's capture/spawn and direct-exec branches are intercepted; every other process call is blocked.
  const unexpected = vi.fn(() => { throw new Error('unexpected external command'); });
  for (const method of ['exec', 'execSync', 'execFile', 'spawn', 'fork']) vi.spyOn(childProcess, method).mockImplementation(unexpected);
  vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args, options) =>
    command === 'gh' ? gh(command, args, options) : command === 'claude' ? auth(command, args, options) : unexpected());
  vi.spyOn(childProcess, 'spawnSync').mockImplementation((command, args, options) => command === 'gh'
    ? { status: 0, signal: null, stdout: gh(command, args, options), stderr: '' } : unexpected());
  syncBuiltinESMExports();
  // Fix/CI-heal use their real producer. The fixing record uses the same reserve primitive and
  // fix-procedure's metadata shape; this test never invokes fix-begin or changes PR labels.
  const acquired = claimKind === 'fixing'
    ? reserve(fixDispatchClaimRoot(), fixDispatchResource({ repo: 'we', pr: 7307, kind: claimKind }),
      'fixer:smoke-owner', start, new Date(start).toISOString(), null, 'unknown', 10,
      { repo: 'we', pr: 7307, kind: claimKind, who: 'smoke-owner', headSha: head,
        claimedAt: new Date(start).toISOString(), sessionId: null })
    : acquireFixDispatchClaim({ repo: 'we', pr: 7307, kind: claimKind, owner: 'smoke-owner',
      headSha: head, nowMs: start, pid: null });
  expect(acquired.ok).toBe(true);
  const claim = () => readFixDispatchClaim({ repo: 'we', pr: 7307, kind: claimKind });
  const originalClaim = claim();
  const dispatch = vi.fn(async planned => ({ pr: planned.pr, session: 'smoke-launch' }));
  const tick = async elapsed => {
    const input = { repo: 'we', now: start + elapsed * minute, agents: [], requiredChecks: ['test'],
      prs: [{ number: 7307, ...facts, headRefOid: head, headRefName: 'lane/default-io-smoke', comments: [],
        // Only a fixing claim is a planner hold; fix/ci-heal claims are read by default recovery IO.
        fixClaim: claimKind === 'fixing' ? claim()?.meta : null,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }] };
    const plan = { ...planReconcile(input), owedFixRecovery: rememberOwedFixRecoveryInput(input) };
    return runReconcileCiHealDispatch({ root, checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => plan, flushOwed: () => ({}), flushTimeouts: async () => [], pollAttempts: () => [],
      timeoutHold: () => null, salvage: async () => null, pickFreeLanes: () => [3], dispatch,
      resolveWorkUnit: () => null,
      fixLoop: { killed: () => false, readRows: () => [], append: async () => {}, currentBuild: async () => null } });
  };
  const state = () => recoveryTransaction(`we:7307:${head}:ci-heal`, stored => stored);
  return { tick, claim, originalClaim, dispatch, state, gh, auth, unexpected, facts, claimKind };
}

describe('owed-fix-default-io-smoke', () => {
  it.each(['fixing', 'fix', 'ci-heal'])('releases a production %s claim once and publishes the second miss once', async kind => {
    const f = fixture(kind);
    expect((await f.tick(29)).dispatched).toEqual([]);
    expect(f.claim()).toEqual(f.originalClaim);
    const recovered = await f.tick(30);
    expect(recovered.dispatched, JSON.stringify(recovered)).toHaveLength(1);
    expect(f.claim()).toBeNull();
    expect(f.state()).toMatchObject({ since: start, retryAt: start + 30 * minute });
    expect(fixDispatchClaimRoot()).toBe(join(root, 'coordination', 'fix-dispatch-claims'));
    expect(existsSync(join(root, 'coordination', 'owed-fix-recovery'))).toBe(true);
    expect((await f.tick(31)).dispatched).toEqual([]);
    expect((await f.tick(60)).dispatched).toEqual([]);
    expect((await f.tick(90)).dispatched).toEqual([]);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.gh).toHaveBeenCalledTimes(3);
    expect(f.auth).toHaveBeenCalledTimes(1);
    expect(f.unexpected).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ attention: true, update: true });
    const feed = readFileSync(join(root, 'needs-you.jsonl'), 'utf8').trim().split('\n');
    const updates = readFileSync(join(root, 'workspace', '.operations', 'handoff', 'updates', 'stream.jsonl'), 'utf8').trim().split('\n');
    expect(feed).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0])).toMatchObject({ pr: 7307, head, kind: 'needs-you' });
  });

  it.each(['auth', 'head', 'json', 'claim', 'missing-claim'])('refuses %s failure with production recovery IO', async fault => {
    const f = fixture();
    if (fault === 'auth') f.auth.mockReturnValue('{"loggedIn":false}');
    if (fault === 'head') f.gh.mockReturnValue(JSON.stringify({ ...f.facts, headRefOid: 'b'.repeat(40) }));
    if (fault === 'json') f.gh.mockReturnValue('{broken');
    if (fault === 'claim' || fault === 'missing-claim') {
      const dir = lockDirFor(fixDispatchClaimRoot(), fixDispatchResource({ repo: 'we', pr: 7307, kind: 'fix' }));
      mkdirSync(dir, { recursive: true });
      if (fault === 'claim') writeFileSync(join(dir, 'lock.json'), '{broken');
    }
    expect((await f.tick(30)).dispatched).toEqual([]);
    expect((await f.tick(61)).dispatched).toEqual([]);
    expect(f.claim()).toEqual(f.originalClaim);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
    expect(f.state().retryAt).toBeUndefined();
    expect(existsSync(join(root, 'needs-you.jsonl'))).toBe(false);
    expect(existsSync(join(root, 'workspace', '.operations', 'handoff', 'updates', 'stream.jsonl'))).toBe(false);
  });
});
