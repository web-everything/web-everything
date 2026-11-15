/**
 * @file scripts/conveyor/__tests__/resolve-runner-checkout.test.mjs
 * @description Proof of the runner-checkout resolver (WE #3478) — the fix for the incident where
 *   `queue.mjs add` reported success while writing to a sidecar the live runner never read. Three subjects:
 *
 *   (1) the PURE classifier ({@link classifyRunnerLocks}) — no live lock / exactly one / more than one;
 *   (2) `parseCwdFromLsof` against a captured `lsof -Fn` transcript (no real `lsof` call);
 *   (3) `resolveRunnerCheckout` end-to-end against a REAL temp lock root (via the same `reserve`/`heartbeat`
 *       primitives the runner's own lease uses) with an INJECTED `execFn` standing in for the real `lsof`
 *       shell-out, so the resolution logic is exercised without depending on a live process or a real pid.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserve, makeLockEntry } from '../../readiness/file-locks.mjs';
import {
  classifyRunnerLocks, parseCwdFromLsof, readAllLockEntries, pidToCwd, resolveRunnerCheckout,
  looksLikeRunnerProcess, verifyRunnerProcess, looksLikeCheckout,
} from '../resolve-runner-checkout.mjs';

const T0 = Date.parse('2026-09-05T12:00:00.000Z');
const MIN = 60_000;

describe('classifyRunnerLocks — pure liveness classification', () => {
  it('no entries → no-live-lock', () => {
    expect(classifyRunnerLocks([], T0)).toEqual({ status: 'no-live-lock', live: [] });
  });

  it('one live entry (fresh heartbeat) → resolved', () => {
    const entry = { owner: 'A', pid: 111, heartbeatAt: new Date(T0).toISOString() };
    const out = classifyRunnerLocks([entry], T0 + MIN, 15);
    expect(out.status).toBe('resolved');
    expect(out.entry).toBe(entry);
  });

  it('one entry whose heartbeat is past the lease → stale, so no-live-lock', () => {
    const entry = { owner: 'A', pid: 111, heartbeatAt: new Date(T0).toISOString() };
    const out = classifyRunnerLocks([entry], T0 + 20 * MIN, 15);
    expect(out.status).toBe('no-live-lock');
  });

  it('two live entries → ambiguous', () => {
    const a = { owner: 'A', pid: 111, heartbeatAt: new Date(T0).toISOString() };
    const b = { owner: 'B', pid: 222, heartbeatAt: new Date(T0).toISOString() };
    const out = classifyRunnerLocks([a, b], T0 + MIN, 15);
    expect(out.status).toBe('ambiguous');
    expect(out.live).toEqual([a, b]);
  });

  it('one live + one stale → resolved (the stale one is not counted)', () => {
    const live = { owner: 'FRESH', pid: 111, heartbeatAt: new Date(T0 + 19 * MIN).toISOString() };
    const stale = { owner: 'DEAD', pid: 222, heartbeatAt: new Date(T0).toISOString() };
    const out = classifyRunnerLocks([live, stale], T0 + 20 * MIN, 15);
    expect(out.status).toBe('resolved');
    expect(out.entry.owner).toBe('FRESH');
  });
});

describe('parseCwdFromLsof — `-Fn` transcript parsing', () => {
  it('extracts the path from the `n`-prefixed line', () => {
    const transcript = 'p4242\nftxt\na cwd\nn/Users/example/workspace/some-checkout\n';
    expect(parseCwdFromLsof(transcript)).toBe('/Users/example/workspace/some-checkout');
  });

  it('returns null when no `n` line is present (unexpected shape / pid gone)', () => {
    expect(parseCwdFromLsof('p4242\n')).toBe(null);
    expect(parseCwdFromLsof('')).toBe(null);
  });
});

describe('pidToCwd — injectable exec', () => {
  it('parses whatever the injected execFn returns for the pid', () => {
    const execFn = (pid) => `p${pid}\nn/some/checkout\n`;
    expect(pidToCwd(4242, execFn)).toBe('/some/checkout');
  });

  it('a non-positive-integer pid short-circuits to null without calling execFn', () => {
    let called = false;
    expect(pidToCwd(null, () => { called = true; return ''; })).toBe(null);
    expect(called).toBe(false);
  });

  it('an execFn that throws (pid gone / lsof missing) resolves to null, never throws', () => {
    expect(pidToCwd(1, () => { throw new Error('boom'); })).toBe(null);
  });
});

describe('readAllLockEntries — enumerate every lock dir under a root', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runner-lock-root-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a missing root → []', () => {
    expect(readAllLockEntries(join(root, 'nope'))).toEqual([]);
  });

  it('reads every real lock dir written via the standard reserve/heartbeat primitives', () => {
    reserve(root, '<runner-lease>', 'A', T0, new Date(T0).toISOString(), 111);
    reserve(root, '<some-other-lease>', 'B', T0, new Date(T0).toISOString(), 222);
    const entries = readAllLockEntries(root);
    expect(entries.map((e) => e.owner).sort()).toEqual(['A', 'B']);
  });

  it('skips a corrupt lock.json rather than throwing', () => {
    const dir = join(root, 'garbage-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock.json'), '{ not json', 'utf8');
    expect(() => readAllLockEntries(root)).not.toThrow();
    expect(readAllLockEntries(root)).toEqual([]);
  });
});

describe('resolveRunnerCheckout — end-to-end verdicts (acceptance criteria a/b/c)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runner-lock-root-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('(a) a live lock whose pid resolves and whose process verifies → the resolved checkout, not the caller\'s cwd', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 4242);
    const execFn = (pid) => `p${pid}\nn/workspace/the-runners-real-checkout\n`;
    const out = resolveRunnerCheckout({
      lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15, execFn, verifyProcess: () => true, verifyCheckout: () => true,
    });
    expect(out).toMatchObject({ status: 'resolved', cwd: '/workspace/the-runners-real-checkout', pid: 4242 });
  });

  it('classifies a real live lease as resolved through the REAL default `leaseMinutes` (#3478 review)', () => {
    // No `leaseMinutes` override — every OTHER test in this suite pins one explicitly, so the production
    // default (DEFAULT_LEASE_MINUTES, what queue-work.mjs's bare resolveRunnerCheckout() call actually uses)
    // was previously exercised only for the empty-root case, never for classifying a fresh heartbeat as live.
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 4242);
    const execFn = (pid) => `p${pid}\nn/workspace/the-runners-real-checkout\n`;
    const out = resolveRunnerCheckout({
      lockRoot: root, nowMs: T0 + MIN, execFn, verifyProcess: () => true, verifyCheckout: () => true,
    });
    expect(out.status).toBe('resolved');
  });

  it('(b) no live lock at all → refuses (no-live-lock), never guesses a checkout', () => {
    const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 });
    expect(out).toMatchObject({ status: 'no-live-lock', cwd: null });
  });

  it('(b) only a STALE lock → also no-live-lock (a crashed runner is not "live")', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'DEAD', T0, new Date(T0).toISOString(), 111);
    const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + 20 * MIN, leaseMinutes: 15 });
    expect(out.status).toBe('no-live-lock');
  });

  it('(c) two live locks → ambiguous, refuses rather than picking one', () => {
    reserve(root, '<lease-one>', 'A', T0, new Date(T0).toISOString(), 111);
    reserve(root, '<lease-two>', 'B', T0, new Date(T0).toISOString(), 222);
    const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15 });
    expect(out.status).toBe('ambiguous');
    expect(out.entries).toHaveLength(2);
  });

  it('a live lock with no pid recorded → no-pid, refuses', () => {
    const dir = join(root, 'no-pid-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock.json'), JSON.stringify(makeLockEntry('A', '<x>', new Date(T0).toISOString(), null)), 'utf8');
    const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15 });
    expect(out.status).toBe('no-pid');
  });

  it('a live lock whose pid does not resolve to a cwd (process gone) → cwd-unresolved, refuses', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 9999999);
    const execFn = () => ''; // simulates a gone pid / lsof finding nothing
    const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15, execFn });
    expect(out.status).toBe('cwd-unresolved');
  });

  it('a resolved cwd whose process does NOT verify as the runner → process-mismatch, refuses (pid-reuse guard)', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 4242);
    const execFn = (pid) => `p${pid}\nn/workspace/some-unrelated-process-cwd\n`;
    const out = resolveRunnerCheckout({
      lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15, execFn, verifyProcess: () => false,
    });
    expect(out.status).toBe('process-mismatch');
    expect(out.cwd).toBe('/workspace/some-unrelated-process-cwd'); // reported for diagnostics, never trusted
  });

  it('a recorded pid of exactly 0 is `no-pid`, not `cwd-unresolved` (#3478 review, round 1)', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 0);
    const execFn = () => { throw new Error('must not be called for pid 0'); };
    const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15, execFn });
    expect(out.status).toBe('no-pid');
  });

  it('a resolved cwd + a verified process, but the cwd has no `.git` entry → checkout-unverified, refuses (real fs, default verifyCheckout)', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 4242);
    const notACheckout = mkdtempSync(join(tmpdir(), 'not-a-checkout-')); // deliberately no `.git`
    const execFn = (pid) => `p${pid}\nn${notACheckout}\n`;
    try {
      const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15, execFn, verifyProcess: () => true });
      expect(out).toMatchObject({ status: 'checkout-unverified', cwd: notACheckout, pid: 4242 });
    } finally { rmSync(notACheckout, { recursive: true, force: true }); }
  });

  it('a resolved cwd that IS a real checkout (has `.git`) → resolved, using the real default verifyCheckout', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 4242);
    const realCheckout = mkdtempSync(join(tmpdir(), 'a-real-checkout-'));
    mkdirSync(join(realCheckout, '.git'), { recursive: true });
    const execFn = (pid) => `p${pid}\nn${realCheckout}\n`;
    try {
      const out = resolveRunnerCheckout({ lockRoot: root, nowMs: T0 + MIN, leaseMinutes: 15, execFn, verifyProcess: () => true });
      expect(out).toMatchObject({ status: 'resolved', cwd: realCheckout, pid: 4242 });
    } finally { rmSync(realCheckout, { recursive: true, force: true }); }
  });

  it('CONVEYOR_RUNNER_LOCK_ROOT is used when no lockRoot is passed — the default-wiring path (#3478 review)', () => {
    reserve(root, '<conveyor:runner-singleton-lease>', 'RUNNER', T0, new Date(T0).toISOString(), 4242);
    const execFn = (pid) => `p${pid}\nn/from/env/override\n`;
    const prev = process.env.CONVEYOR_RUNNER_LOCK_ROOT;
    process.env.CONVEYOR_RUNNER_LOCK_ROOT = root;
    try {
      const out = resolveRunnerCheckout({
        nowMs: T0 + MIN, leaseMinutes: 15, execFn, verifyProcess: () => true, verifyCheckout: () => true,
      });
      expect(out).toMatchObject({ status: 'resolved', cwd: '/from/env/override' });
    } finally {
      if (prev === undefined) delete process.env.CONVEYOR_RUNNER_LOCK_ROOT; else process.env.CONVEYOR_RUNNER_LOCK_ROOT = prev;
    }
  });
});

describe('pidToCwd — the REAL default `lsof` shell-out (#3478 review: never exercised without an execFn override)', () => {
  let fakeBin, prevPath;
  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'fake-lsof-bin-'));
    prevPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${prevPath}`;
  });
  afterEach(() => {
    process.env.PATH = prevPath;
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it('shells the real default execFn (no override) — a fake `lsof` on PATH answering cleanly resolves', () => {
    writeFileSync(join(fakeBin, 'lsof'), '#!/bin/sh\nprintf "p1\\nn/from/real/lsof\\n"\n' /* sh, not node: no cold-start under CI shard load (main-fix 74fcb99b7) */, 'utf8');
    chmodSync(join(fakeBin, 'lsof'), 0o755);
    expect(pidToCwd(4242)).toBe('/from/real/lsof');
  });

  it('a `lsof` that exits non-zero (pid gone / unsupported flags) resolves to null, never throws', () => {
    writeFileSync(join(fakeBin, 'lsof'), '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(join(fakeBin, 'lsof'), 0o755);
    expect(pidToCwd(4242)).toBe(null);
  });
});

describe('looksLikeCheckout — cheap `.git`-marker check that a resolved cwd is a real checkout', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'looks-like-checkout-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a directory with a `.git` entry looks like a checkout', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(looksLikeCheckout(dir)).toBe(true);
  });

  it('a `.git` FILE (worktree-style, not a directory) still counts — existence is all that is checked', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n', 'utf8');
    expect(looksLikeCheckout(dir)).toBe(true);
  });

  it('a directory with no `.git` entry does not look like a checkout', () => {
    expect(looksLikeCheckout(dir)).toBe(false);
  });

  it('a nonexistent path does not throw — resolves false', () => {
    expect(looksLikeCheckout(join(dir, 'nonexistent-nested', 'path'))).toBe(false);
  });
});

describe('looksLikeRunnerProcess / verifyRunnerProcess — pid-reuse identity guard (#3478 review, rounds 2-3)', () => {
  it('a command line naming the runner script looks like the runner', () => {
    expect(looksLikeRunnerProcess('node /Users/x/workspace/webeverything/skills-src/conveyor/runner.mjs --json')).toBe(true);
  });

  it('an unrelated command line does not', () => {
    expect(looksLikeRunnerProcess('node /Users/x/some-other-project/server.mjs')).toBe(false);
    expect(looksLikeRunnerProcess('')).toBe(false);
    expect(looksLikeRunnerProcess(null)).toBe(false);
  });

  it('a bare substring in an unrelated argv position (a flag/log path) is rejected — no whole-line substring match', () => {
    expect(looksLikeRunnerProcess('node some-unrelated-tool.mjs --log=/var/log/conveyor/runner.mjs.log')).toBe(false);
    expect(looksLikeRunnerProcess('node some-unrelated-tool.mjs --comment=conveyor/runner.mjs')).toBe(false);
  });

  it('an interpreter flag ahead of the script path still matches — no fixed argv position (#3478 review, round 3)', () => {
    expect(looksLikeRunnerProcess('node --experimental-vm-modules /x/skills-src/conveyor/runner.mjs --json')).toBe(true);
  });

  it('a space in an ancestor directory still matches — the check scans every token, not one fixed slot', () => {
    expect(looksLikeRunnerProcess('node /Users/Jane Doe/workspace/skills-src/conveyor/runner.mjs --json')).toBe(true);
  });

  it('verifyRunnerProcess parses whatever the injected execFn returns for the pid', () => {
    const execFn = () => 'node skills-src/conveyor/runner.mjs --json\n';
    expect(verifyRunnerProcess(4242, execFn)).toBe(true);
    expect(verifyRunnerProcess(4242, () => 'node unrelated.mjs\n')).toBe(false);
  });

  it('a non-positive-integer pid short-circuits to false without calling execFn', () => {
    let called = false;
    expect(verifyRunnerProcess(0, () => { called = true; return ''; })).toBe(false);
    expect(called).toBe(false);
  });

  it('an execFn that throws (pid gone / ps missing) resolves to false, never throws', () => {
    expect(verifyRunnerProcess(1, () => { throw new Error('boom'); })).toBe(false);
  });
});

describe('verifyRunnerProcess — the REAL default `ps` shell-out (#3478 review, rounds 2-3)', () => {
  let fakeBin, prevPath;
  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'fake-ps-bin-'));
    prevPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${prevPath}`;
  });
  afterEach(() => {
    process.env.PATH = prevPath;
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it('shells the real default execFn (no override) — a fake `ps` on PATH naming the runner verifies true', () => {
    writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nprintf "node skills-src/conveyor/runner.mjs --json\\n"\n' /* sh, not node: the failing CI case (74fcb99b7) */, 'utf8');
    chmodSync(join(fakeBin, 'ps'), 0o755);
    expect(verifyRunnerProcess(4242)).toBe(true);
  });

  it('a fake `ps` naming an unrelated process verifies false', () => {
    writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nprintf "node some-other-script.mjs\\n"\n', 'utf8');
    chmodSync(join(fakeBin, 'ps'), 0o755);
    expect(verifyRunnerProcess(4242)).toBe(false);
  });
});
