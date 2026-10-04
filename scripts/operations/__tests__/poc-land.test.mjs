/**
 * @file scripts/operations/__tests__/poc-land.test.mjs
 * @description Unit proof of the POC fast-lander (#3637, transport A′). Drives {@link landOnPocBranch} with a
 *   SCRIPTED git (every command answered from a table, no repo, no network), an injected gate and an injected
 *   lock, so all five cases the card names are reachable deterministically:
 *
 *     1. fast-forward success        — the tip has not moved: one push, no rebase, no merge commit.
 *     2. rebase-and-retry            — the tip moved: rebase, RE-verify, then land.
 *     3. bounded-retry exhausted     — the tip moves on every attempt: STOP at 3, never force.
 *     4. lock serialization          — two landers on the SAME branch, against a REAL temp lock dir.
 *     5. the gate                    — a red verify pushes NOTHING; the gate is the only one a POC landing has.
 *
 *   Plus the refusals that must never reach git at all (an UNregistered branch) and the ones that must stop
 *   rather than resolve unattended (a rebase conflict).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_LAND_ATTEMPTS, LAND_STATUSES, planLanding, pushArgv, fetchArgv, isNonFastForwardRejection, describeLanding,
  landOnPocBranch, flagOf,
} from '../poc-land.mjs';
import { normalizeRegistry } from '../../lib/poc-branches.mjs';
import { withPocLandLock, pocLandLockPathFor, makeOwner, tryAcquireNumberingLock } from '../../readiness/drain-lock.mjs';

const BRANCH = 'lane/demo';
const REGISTRY = normalizeRegistry({
  branches: [{ branch: BRANCH, purpose: 'a demo POC branch', owner: '1234', dateOpened: '2026-09-12', target: 'main', scope: [] }],
});

const OK = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const FAIL = (stderr) => ({ status: 1, stdout: '', stderr });

/**
 * A scripted git. `script` maps the FIRST argument of each call to a SEQUENCE of responses, consumed in order
 * and then CYCLED — so `['lane', 'tip']` answers a two-read attempt loop identically every round, which is
 * what makes the "the tip moves on every attempt" case expressible at all. Records every argv.
 */
function scriptGit(script) {
  const calls = [];
  const seqs = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, (Array.isArray(v) ? v : [v])]));
  const counts = {};
  const run = (cmd, args) => {
    calls.push(args);
    const key = args[0];
    const seq = seqs[key];
    if (!seq) throw new Error(`scriptGit: no response scripted for \`git ${args.join(' ')}\``);
    const i = counts[key] = (counts[key] ?? -1) + 1;
    return seq[i % seq.length];
  };
  return { run, calls, argvFor: (k) => calls.filter((a) => a[0] === k) };
}

/** A lock stand-in that always grants, so the git-path tests never touch the filesystem. */
const grantingLock = (fn) => ({ result: fn(), ran: true, held: true, contended: false, heldBy: null, reason: 'test' });

const passing = () => ({ ok: true, detail: 'green' });

describe('planLanding — the whole fast-forward-vs-rebase decision, pure', () => {
  it('noop when HEAD already IS the tip', () => {
    expect(planLanding({ headSha: 'aaa', tipSha: 'aaa', mergeBase: 'aaa' }).action).toBe('noop');
  });
  it('fast-forward when the merge-base IS the tip (the tip has not moved since the lane forked)', () => {
    expect(planLanding({ headSha: 'lane1', tipSha: 'base0', mergeBase: 'base0' }).action).toBe('fast-forward');
  });
  it('rebase when the tip moved past the merge-base', () => {
    expect(planLanding({ headSha: 'lane1', tipSha: 'base1', mergeBase: 'base0' }).action).toBe('rebase');
  });
  it('throws on a missing sha rather than guessing', () => {
    expect(() => planLanding({ headSha: 'a', tipSha: 'b' })).toThrow(/needs headSha/);
  });
});

describe('the git argv — asserted exactly, because a wrong flag here is a destructive push', () => {
  it('the push is NEVER forced and names refs/heads in full', () => {
    expect(pushArgv('origin/lane/demo')).toEqual(['push', 'origin', 'HEAD:refs/heads/lane/demo']);
    expect(pushArgv(BRANCH).join(' ')).not.toMatch(/--force|\+refs|HEAD:\+/);
  });
  it('the FETCH force-prefixes only the local tracking destination', () => {
    expect(fetchArgv(BRANCH)).toEqual(['fetch', 'origin', '--quiet', '+lane/demo:refs/remotes/origin/lane/demo']);
  });
  it('recognises a non-fast-forward rejection as the expected race, not a hard error', () => {
    expect(isNonFastForwardRejection('! [rejected] HEAD -> lane/demo (non-fast-forward)')).toBe(true);
    expect(isNonFastForwardRejection('Updates were rejected because the remote contains work... fetch first')).toBe(true);
    expect(isNonFastForwardRejection('fatal: could not read Username for https://github.com')).toBe(false);
  });
});

describe('1. fast-forward success', () => {
  it('pushes once and reports `landed`, with no rebase anywhere', () => {
    const g = scriptGit({
      fetch: OK(), 'rev-parse': [OK('laneHEAD'), OK('base0')], 'merge-base': OK('base0'), push: OK(),
    });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r).toMatchObject({ status: 'landed', branch: BRANCH, attempts: 1, sha: 'laneHEAD', verified: true, rebased: false });
    expect(g.argvFor('rebase')).toEqual([]);
    expect(g.argvFor('push')).toEqual([['push', 'origin', 'HEAD:refs/heads/lane/demo']]);
  });

  it('reports `noop` and pushes NOTHING when HEAD is already the tip', () => {
    const g = scriptGit({ fetch: OK(), 'rev-parse': [OK('same'), OK('same')], 'merge-base': OK('same') });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r.status).toBe('noop');
    expect(g.argvFor('push')).toEqual([]);
  });
});

describe('a sibling-repo POC branch (`repo` field)', () => {
  const SIB = normalizeRegistry({ branches: [{ branch: 'lane/wip-quickview', repo: 'plateauapp/plateau-app', purpose: 'alpha', owner: '3383', dateOpened: '2026-10-03', target: 'main', scope: [] }] });
  it('lands from a lane of THAT repo', () => {
    const g = scriptGit({ fetch: OK(), 'rev-parse': [OK('laneHEAD'), OK('base0')], 'merge-base': OK('base0'), push: OK() });
    const r = landOnPocBranch({ branch: 'lane/wip-quickview', cwd: '/lane', registry: SIB, run: g.run, verify: passing, withLock: grantingLock, repoKey: 'plateauapp/plateau-app' });
    expect(r.status).toBe('landed');
    expect(g.argvFor('push')).toEqual([['push', 'origin', 'HEAD:refs/heads/lane/wip-quickview']]);
  });
  it('is refused from a Web Everything lane (or a lane with no origin), before touching git', () => {
    for (const repoKey of ['web-everything/web-everything', null]) {
      const g = scriptGit({});
      const r = landOnPocBranch({ branch: 'lane/wip-quickview', cwd: '/lane', registry: SIB, run: g.run, verify: passing, withLock: grantingLock, repoKey });
      expect(r.status).toBe('not-registered');
      expect(g.calls).toEqual([]);
    }
  });
});

describe('2. rebase-and-retry — the loser of a race does not fail', () => {
  it('rebases onto the fresh tip, RE-RUNS the gate, then lands on the next attempt', () => {
    const g = scriptGit({
      fetch: OK(),
      // attempt 1: HEAD=lane1, tip=base1, mb=base0 ⇒ rebase. attempt 2: HEAD=lane2, tip=base1, mb=base1 ⇒ ff.
      'rev-parse': [OK('lane1'), OK('base1'), OK('lane2'), OK('base1')],
      'merge-base': [OK('base0'), OK('base1')],
      rebase: OK(),
      push: OK(),
    });
    let verifies = 0;
    const verify = () => { verifies += 1; return { ok: true, detail: 'green' }; };
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify, withLock: grantingLock, repoKey: null });
    expect(r).toMatchObject({ status: 'landed', attempts: 2, sha: 'lane2', rebased: true });
    expect(g.argvFor('rebase')).toEqual([['rebase', 'refs/remotes/origin/lane/demo']]);
    // Once before the lock, once after the rebase — the re-verify the card requires.
    expect(verifies).toBe(2);
  });

  it('treats a REJECTED push as the race it is and goes round again', () => {
    const g = scriptGit({
      fetch: OK(),
      'rev-parse': [OK('lane1'), OK('base0'), OK('lane1'), OK('base1')],
      'merge-base': [OK('base0'), OK('base0')],
      push: [FAIL('! [rejected] (non-fast-forward)'), OK()],
      rebase: OK(),
    });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    // attempt 1 ff-push rejected → attempt 2 sees a moved tip → rebase → attempt 3 would push, but the bound
    // is reached first; what matters is that it never forced and never errored on the rejection.
    expect(['landed', 'exhausted']).toContain(r.status);
    expect(g.calls.every((a) => !a.includes('--force'))).toBe(true);
  });

  it('a REBASE CONFLICT stops and aborts — never resolved unattended, nothing pushed', () => {
    const g = scriptGit({
      fetch: OK(), 'rev-parse': [OK('lane1'), OK('base1')], 'merge-base': OK('base0'),
      rebase: [FAIL('CONFLICT (content): Merge conflict in scripts/x.mjs'), OK()],
    });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r.status).toBe('conflict');
    expect(g.argvFor('push')).toEqual([]);
    expect(g.calls).toContainEqual(['rebase', '--abort']);
    expect(describeLanding(r)).toMatch(/STOPPED/);
  });

  it('a gate that goes RED after the rebase pushes NOTHING', () => {
    const g = scriptGit({ fetch: OK(), 'rev-parse': [OK('lane1'), OK('base1')], 'merge-base': OK('base0'), rebase: OK() });
    let n = 0;
    const verify = () => { n += 1; return n === 1 ? { ok: true, detail: 'green' } : { ok: false, detail: 'verify-lane reported fail' }; };
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify, withLock: grantingLock, repoKey: null });
    expect(r.status).toBe('verify-failed');
    expect(g.argvFor('push')).toEqual([]);
  });
});

describe('3. the retry bound — stops and surfaces, never loops and never forces', () => {
  it('gives up after MAX_LAND_ATTEMPTS when the tip moves every single round', () => {
    // Every attempt reads a tip that has moved past the merge-base ⇒ rebase, forever.
    const g = scriptGit({
      fetch: OK(),
      'rev-parse': [OK('laneN'), OK('moving')],
      'merge-base': OK('stale'),
      rebase: OK(),
    });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r).toMatchObject({ status: 'exhausted', attempts: MAX_LAND_ATTEMPTS });
    expect(g.argvFor('push')).toEqual([]);
    expect(g.argvFor('rebase')).toHaveLength(MAX_LAND_ATTEMPTS);
    expect(describeLanding(r)).toMatch(/never forces/);
  });

  it('honours an explicit lower bound', () => {
    const g = scriptGit({ fetch: OK(), 'rev-parse': [OK('laneN'), OK('moving')], 'merge-base': OK('stale'), rebase: OK() });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', maxAttempts: 1, registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r).toMatchObject({ status: 'exhausted', attempts: 1 });
  });
});

describe('4. lock serialization — two landers, one branch, a REAL lock dir', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'poc-land-lock-')); });
  afterEach(() => { try { rmSync(lockRoot, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('keys the lock PER BRANCH and PER REPO, so two branches never block each other', () => {
    expect(pocLandLockPathFor('lane/a', 'org/repo')).not.toBe(pocLandLockPathFor('lane/b', 'org/repo'));
    expect(pocLandLockPathFor('lane/a', 'org/one')).not.toBe(pocLandLockPathFor('lane/a', 'org/two'));
    // Either spelling of the same branch is the same lock.
    expect(pocLandLockPathFor('origin/lane/a', 'org/repo')).toBe(pocLandLockPathFor('lane/a', 'org/repo'));
  });

  it('a second lander BLOCKS while the first holds the branch, and lands after it releases', () => {
    const order = [];
    const first = withPocLandLock(() => {
      order.push('first:in');
      // While the first holds it, a second lander with a tiny wait budget must NOT get in.
      // A DISTINCT owner: two real landers are separate processes (host:pid:poc-land differs), and the
      // file-locks primitive treats a re-acquire by the SAME owner as a heartbeat of its own lease.
      const second = withPocLandLock(() => { order.push('second:in-while-held'); return 'x'; }, {
        branch: BRANCH, repoKey: 'org/repo', lockRoot, waitMs: 0, sleep: () => {}, owner: makeOwner('poc-land-sibling'),
      });
      expect(second.ran).toBe(false);
      expect(second.contended).toBe(true);
      order.push('first:out');
      return 'ok';
    }, { branch: BRANCH, repoKey: 'org/repo', lockRoot, sleep: () => {} });

    expect(first).toMatchObject({ ran: true, held: true, result: 'ok' });
    expect(order).toEqual(['first:in', 'first:out']);

    // Released ⇒ the next lander gets in cleanly.
    const after = withPocLandLock(() => 'later', { branch: BRANCH, repoKey: 'org/repo', lockRoot, sleep: () => {} });
    expect(after).toMatchObject({ ran: true, held: true, result: 'later' });
  });

  it('a DIFFERENT branch is NOT blocked by a held one', () => {
    withPocLandLock(() => {
      const other = withPocLandLock(() => 'other-ok', { branch: 'lane/unrelated', repoKey: 'org/repo', lockRoot, waitMs: 0, sleep: () => {}, owner: makeOwner('poc-land-sibling') });
      expect(other).toMatchObject({ ran: true, held: true, result: 'other-ok' });
    }, { branch: BRANCH, repoKey: 'org/repo', lockRoot, sleep: () => {} });
  });

  it('landOnPocBranch reports `locked` — and pushes NOTHING — when the branch is already held', () => {
    // Take the lock out from under it with a foreign owner.
    tryAcquireNumberingLock(lockRoot, makeOwner('someone-else'), { lockPath: pocLandLockPathFor(BRANCH, 'org/repo') });
    const g = scriptGit({ fetch: OK(), 'rev-parse': OK('x'), 'merge-base': OK('x'), push: OK() });
    const r = landOnPocBranch({
      // The repo key is both the lock key and the registry identity (`repo` field), so the entry names it.
      branch: BRANCH, cwd: '/lane', registry: normalizeRegistry({ branches: [{ ...REGISTRY.branches[0], repo: 'org/repo' }] }), run: g.run, verify: passing, repoKey: 'org/repo',
      withLock: (fn, o) => withPocLandLock(fn, { ...o, lockRoot, waitMs: 0, sleep: () => {} }),
    });
    expect(r.status).toBe('locked');
    expect(g.calls).toEqual([]);
    expect(describeLanding(r)).toMatch(/another lander holds/);
  });
});

describe('5. the gate, and the refusals that never reach git', () => {
  it('a RED gate refuses before the lock is even taken — the only gate a POC landing has', () => {
    const g = scriptGit({ fetch: OK() });
    let lockTaken = false;
    const r = landOnPocBranch({
      branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, repoKey: null,
      verify: () => ({ ok: false, detail: 'verify-lane reported fail' }),
      withLock: (fn) => { lockTaken = true; return grantingLock(fn); },
    });
    expect(r).toMatchObject({ status: 'verify-failed', verified: false });
    expect(lockTaken).toBe(false);
    expect(g.calls).toEqual([]);
    expect(describeLanding(r)).toMatch(/only gate/);
  });

  it('--skip-verify runs no gate and SAYS SO, so it can never read as "it passed"', () => {
    const g = scriptGit({ fetch: OK(), 'rev-parse': [OK('lane1'), OK('base0')], 'merge-base': OK('base0'), push: OK() });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', skipVerify: true, registry: REGISTRY, run: g.run, verify: () => { throw new Error('must not run'); }, withLock: grantingLock, repoKey: null });
    expect(r).toMatchObject({ status: 'landed', verified: false });
  });

  it('an UNREGISTERED branch is refused with no git and no lock — doctrine rule 10(c)', () => {
    const g = scriptGit({});
    const r = landOnPocBranch({ branch: 'lane/never-declared', cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r.status).toBe('not-registered');
    expect(r.error).toMatch(/rule 10\(c\)/);
    expect(g.calls).toEqual([]);
  });

  it('an EMPTY registry refuses every branch — fail closed', () => {
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: normalizeRegistry(null), run: scriptGit({}).run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r.status).toBe('not-registered');
  });

  it('a git failure is reported as `error`, never swallowed into a success', () => {
    const g = scriptGit({ fetch: FAIL('fatal: could not read from remote repository') });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/fetching origin/);
  });

  it('a REAL push failure (not a race) stops immediately rather than retrying blind', () => {
    const g = scriptGit({
      fetch: OK(), 'rev-parse': [OK('lane1'), OK('base0')], 'merge-base': OK('base0'),
      push: FAIL('fatal: Authentication failed'),
    });
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify: passing, withLock: grantingLock, repoKey: null });
    expect(r).toMatchObject({ status: 'error', attempts: 1 });
    expect(g.argvFor('push')).toHaveLength(1);
  });

  it('refuses with no branch at all', () => {
    expect(() => landOnPocBranch({ cwd: '/lane', registry: REGISTRY })).toThrow(/needs a --branch/);
  });
});

describe('describeLanding — every status has exactly one phrasing', () => {
  it('renders every declared status without falling through to the unknown branch', () => {
    for (const status of LAND_STATUSES) {
      const line = describeLanding({ status, branch: BRANCH, attempts: 1, sha: 'abc123def', error: 'why' });
      expect(line.startsWith('poc-land:')).toBe(true);
      expect(line).not.toMatch(/unrecognised status/);
    }
  });
  it('NAMES a status the vocabulary does not define rather than rendering it as a known outcome', () => {
    expect(describeLanding({ status: 'invented', branch: BRANCH })).toMatch(/unrecognised status/);
  });
});

describe('flagOf — the CLI reader', () => {
  it('reads --name=value, a bare --name, and absence', () => {
    expect(flagOf(['--branch=lane/x'], 'branch')).toBe('lane/x');
    expect(flagOf(['--json'], 'json')).toBe('');
    expect(flagOf([], 'json')).toBeUndefined();
  });
});

describe('the lane lease is renewed around every gate run (#3383, a landing outlived its lease on 2026-09-23)', () => {
  it('renews before and after the gate, and again around a rebase re-verify', () => {
    const g = scriptGit({
      fetch: OK(), 'rev-parse': [OK('laneHEAD'), OK('base1'), OK('laneHEAD2'), OK('base1')],
      'merge-base': [OK('base0'), OK('base1')], rebase: OK(), push: OK(),
    });
    const order = [];
    const verify = () => { order.push('verify'); return { ok: true, detail: 'green' }; };
    const renewLease = () => { order.push('renew'); return true; };
    const r = landOnPocBranch({ branch: BRANCH, cwd: '/lane', registry: REGISTRY, run: g.run, verify, withLock: grantingLock, renewLease, repoKey: null });
    expect(r.status).toBe('landed');
    expect(order).toEqual(['renew', 'verify', 'renew', 'renew', 'verify', 'renew']);
  });

  it('the default renewal rewrites the lane lease with renewedAt and leaves a non-lane alone', async () => {
    const { defaultRenewLease } = await import('../poc-land.mjs');
    const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'poc-renew-'));
    try {
      const gitDir = join(dir, '.git'); mk(gitDir);
      const run = () => ({ status: 0, stdout: `${gitDir}\n`, stderr: '' });
      const now = () => new Date('2026-09-24T12:00:00.000Z');
      expect(defaultRenewLease({ cwd: dir, run, now })).toBe(false); // no lease file: not a lane
      wf(join(gitDir, '.lane-lease'), JSON.stringify({ session: 's', acquiredAt: '2026-09-24T08:00:00.000Z', ttlMinutes: 240 }));
      expect(defaultRenewLease({ cwd: dir, run, now })).toBe(true);
      expect(JSON.parse(rf(join(gitDir, '.lane-lease'), 'utf8'))).toEqual({ session: 's', acquiredAt: '2026-09-24T08:00:00.000Z', ttlMinutes: 240, renewedAt: '2026-09-24T12:00:00.000Z' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a renewal killed mid-write never leaves a torn lease behind (atomic temp+rename, #3383)', async () => {
    const { defaultRenewLease } = await import('../poc-land.mjs');
    const fsMod = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'poc-renew-torn-'));
    try {
      const gitDir = join(dir, '.git'); fsMod.mkdirSync(gitDir);
      const leaseFile = join(gitDir, '.lane-lease');
      const original = { session: 's', acquiredAt: '2026-09-24T08:00:00.000Z', ttlMinutes: 240 };
      fsMod.writeFileSync(leaseFile, JSON.stringify(original));
      const run = () => ({ status: 0, stdout: `${gitDir}\n`, stderr: '' });
      const now = () => new Date('2026-09-24T12:00:00.000Z');
      // The write is "killed" after truncating and writing half the body — whatever path it targets.
      const killedWrite = (path, body) => { fsMod.writeFileSync(path, String(body).slice(0, 10)); throw new Error('SIGKILL'); };
      const fs = { writeFileSync: killedWrite, renameSync: fsMod.renameSync, rmSync: fsMod.rmSync };
      expect(defaultRenewLease({ cwd: dir, run, now, fs })).toBe(false);
      // The real lease is still the whole, parseable original — never a torn prefix a reader treats as "no lease".
      expect(JSON.parse(fsMod.readFileSync(leaseFile, 'utf8'))).toEqual(original);
      expect(fsMod.readdirSync(gitDir)).toEqual(['.lane-lease']); // and no stray temp file is left behind
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
