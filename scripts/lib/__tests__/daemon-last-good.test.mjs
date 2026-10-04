/**
 * @file scripts/lib/__tests__/daemon-last-good.test.mjs
 * @description x5wbsbc (epic #4075) — `../daemon-last-good.mjs` (the ONE read both `main-staleness.mjs` and
 *   `daemon-rebuild.mjs` share for "is this managed clone running its last smoke-verified build?") plus the
 *   managed-clone last-good fallback branch of `../main-staleness.mjs#assertMainNotStale`. Real temp git fixtures
 *   for the `cloneKeyOf` cross-check and the `assertMainNotStale` behavioral tests; everything else is pure.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  cloneKeyOf, decideLastGood, lastGoodMaxAgeMs, LAST_GOOD_MAX_AGE_ENV, DEFAULT_LAST_GOOD_MAX_AGE_MS,
  daemonConveyorStateRoot, daemonStateDir, CONVEYOR_STATE_ROOT_ENV,
  decideRebuildGrace, rebuildGraceForClone, staleGuardRebuildGraceMs, STALE_GUARD_REBUILD_GRACE_ENV,
  DEFAULT_STALE_GUARD_REBUILD_GRACE_MS,
} from '../daemon-last-good.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { assertMainNotStale, STALE_MAIN_REFUSAL_MARKER } from '../main-staleness.mjs';
import { STATE_ROOT_ENV } from '../../conveyor/queue-store.mjs';

// ── fixture helpers ──────────────────────────────────────────────────────────────────────────────────────────

const tempDirs = [];

function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** A real {origin (bare), clone} pair whose clone's HEAD is exactly `origin/main` (no divergence) — so
 *  `main-staleness.mjs#behindFiles` (which `assertMainNotStale` calls for every managed clone) returns an empty
 *  list rather than `null`, and the #4044 "behind in non-code files only" branch it feeds never fires and
 *  never overrides the injected `checkStaleness` this suite exercises. */
function makeRealRepoWithOrigin() {
  const base = mktemp('we-last-good-repo-');
  const originDir = join(base, 'origin.git');
  gitOk(base, ['init', '--bare', '-q', '-b', 'main', originDir]);
  const seedDir = join(base, 'seed');
  mkdirSync(seedDir, { recursive: true });
  gitOk(seedDir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(seedDir, 'a.mjs'), 'export const x = 1;\n');
  gitOk(seedDir, ['add', '-A']);
  gitOk(seedDir, ['commit', '-q', '-m', 'seed']);
  gitOk(seedDir, ['remote', 'add', 'origin', originDir]);
  gitOk(seedDir, ['push', '-q', '-u', 'origin', 'main']);
  const cloneDir = join(base, 'clone');
  gitOk(base, ['clone', '-q', '-b', 'main', originDir, cloneDir]);
  return cloneDir;
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

// ── a. cloneKeyOf matches daemon-overlays.mjs#cloneKey ─────────────────────────────────────────────────────

describe('cloneKeyOf matches daemon-overlays.mjs#cloneKey (the two per-clone state files must key identically)', () => {
  it('is identical for the same directory', () => {
    const dir = mktemp('we-last-good-clonekey-');
    expect(cloneKeyOf(dir)).toBe(cloneKey(dir));
  });

  it('is identical through a symlink to the same directory', () => {
    const real = mktemp('we-last-good-clonekey-real-');
    const parent = mktemp('we-last-good-clonekey-link-');
    const link = join(parent, 'link');
    symlinkSync(real, link, 'dir');
    expect(cloneKeyOf(link)).toBe(cloneKey(link));
    expect(cloneKeyOf(link)).toBe(cloneKeyOf(real));
    expect(cloneKey(link)).toBe(cloneKey(real));
  });
});

// ── a2. daemonConveyorStateRoot — the ONE #4052 state-root resolver every reader shares ────────────────────

describe('CONVEYOR_STATE_ROOT_ENV matches queue-store.mjs#STATE_ROOT_ENV (re-stated, not imported — same '
  + 'convention as cloneKeyOf above)', () => {
  it('is the identical string', () => { expect(CONVEYOR_STATE_ROOT_ENV).toBe(STATE_ROOT_ENV); });
});

describe('daemonConveyorStateRoot — #4052 pinned daemon state root', () => {
  it('CONVEYOR_STATE_ROOT, when set, wins over the out-of-tree default', () => {
    expect(daemonConveyorStateRoot({ CONVEYOR_STATE_ROOT: '  /pinned/root  ' })).toBe(join('/pinned/root'));
  });

  it('unset: falls back to <daemonStateDir>/conveyor-state — never a checkout-relative path', () => {
    const env = {};
    expect(daemonConveyorStateRoot(env)).toBe(join(daemonStateDir(env), 'conveyor-state'));
  });

  it('WE_DAEMON_STATE_DIR moves the same default daemonStateDir moves', () => {
    const env = { WE_DAEMON_STATE_DIR: '/alt/state' };
    expect(daemonConveyorStateRoot(env)).toBe(join('/alt/state', 'conveyor-state'));
  });

  it('an empty/whitespace-only CONVEYOR_STATE_ROOT is treated as unset', () => {
    expect(daemonConveyorStateRoot({ CONVEYOR_STATE_ROOT: '   ' })).toBe(join(daemonStateDir({}), 'conveyor-state'));
  });
});

// ── b. decideLastGood — pure ─────────────────────────────────────────────────────────────────────────────────

describe('decideLastGood — pure', () => {
  it('onLastGood is false when the clone is merely behind — no held record, no build in flight (#3383 I-18)', () => {
    expect(decideLastGood({
      headSha: 'abc123', state: { adopted: { head: 'abc123' } }, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false);
    expect(decideLastGood({
      headSha: 'abc123', state: { adopted: { head: 'abc123' }, held: null, building: null }, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false);
    // A candidate smoke in flight (a fresh build lease) holds the clone too…
    const building = { token: 't', startedAt: new Date(0).toISOString() };
    expect(decideLastGood({
      headSha: 'abc123', state: { adopted: { head: 'abc123' }, building }, dirty: false, nowMs: 60_000, maxAgeMs: 1000,
    }).onLastGood).toBe(true);
    // …but a leftover lease past the stale window (a crashed/unreleased build) does not.
    expect(decideLastGood({
      headSha: 'abc123', state: { adopted: { head: 'abc123' }, building }, dirty: false, nowMs: 21 * 60_000, maxAgeMs: 1000,
    }).onLastGood).toBe(false);
    expect(decideLastGood({
      headSha: 'abc123', state: { adopted: { head: 'abc123' }, building: { token: 't' } }, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false); // no startedAt — unreadable, not a hold
  });

  it('onLastGood is true only when held, head===adopted.head AND the tree is clean', () => {
    const state = { adopted: { head: 'abc123' }, held: { since: new Date(0).toISOString(), reason: 'smoke-rejected' } };
    expect(decideLastGood({
      headSha: 'abc123', state, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(true);
    expect(decideLastGood({
      headSha: 'abc123', state, dirty: true, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false); // dirty
    expect(decideLastGood({
      headSha: 'def456', state, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false); // head mismatch
    expect(decideLastGood({
      headSha: null, state, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false); // no head
    expect(decideLastGood({
      headSha: 'abc123', state: null, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false); // no state at all
    expect(decideLastGood({
      headSha: 'abc123', state: { adopted: null, held: state.held }, dirty: false, nowMs: 0, maxAgeMs: 1000,
    }).onLastGood).toBe(false); // nothing ever adopted
  });

  it('lastGood echoes state.adopted.head, or null with no adopted record', () => {
    expect(decideLastGood({
      headSha: 'a', state: { adopted: { head: 'z' } }, nowMs: 0, maxAgeMs: 1000,
    }).lastGood).toBe('z');
    expect(decideLastGood({ headSha: 'a', state: null, nowMs: 0, maxAgeMs: 1000 }).lastGood).toBeNull();
  });

  it('ageMs is derived from held.since, and null with no held record', () => {
    const since = new Date(1_000_000).toISOString();
    const state = { adopted: { head: 'a' }, held: { since, reason: 'smoke-rejected' } };
    const held = decideLastGood({
      headSha: 'a', state, dirty: false, nowMs: 1_005_000, maxAgeMs: 999_999_999,
    });
    expect(held.heldSince).toBe(since);
    expect(held.ageMs).toBe(5000);

    const noHeld = decideLastGood({
      headSha: 'a', state: { adopted: { head: 'a' } }, dirty: false, nowMs: 1_005_000, maxAgeMs: 999,
    });
    expect(noHeld.ageMs).toBeNull();
    expect(noHeld.heldSince).toBeNull();
  });

  it('overAge is true only when onLastGood AND ageMs exceeds maxAgeMs', () => {
    const since = new Date(0).toISOString();
    const state = { adopted: { head: 'a' }, held: { since } };
    const under = decideLastGood({
      headSha: 'a', state, dirty: false, nowMs: 1000, maxAgeMs: 2000,
    });
    expect(under.overAge).toBe(false);
    const over = decideLastGood({
      headSha: 'a', state, dirty: false, nowMs: 3000, maxAgeMs: 2000,
    });
    expect(over.overAge).toBe(true);
    // Not onLastGood (dirty tree) — never overAge, however old `held.since` is.
    const dirtyOver = decideLastGood({
      headSha: 'a', state, dirty: true, nowMs: 3000, maxAgeMs: 2000,
    });
    expect(dirtyOver.overAge).toBe(false);
    // Not onLastGood (head mismatch) — same.
    const mismatchOver = decideLastGood({
      headSha: 'b', state, dirty: false, nowMs: 3000, maxAgeMs: 2000,
    });
    expect(mismatchOver.overAge).toBe(false);
  });
});

describe('lastGoodMaxAgeMs', () => {
  it('defaults to 24h with no env override', () => {
    expect(lastGoodMaxAgeMs({})).toBe(24 * 60 * 60_000);
    expect(lastGoodMaxAgeMs({})).toBe(DEFAULT_LAST_GOOD_MAX_AGE_MS);
  });

  it('honors a positive numeric env override', () => {
    expect(lastGoodMaxAgeMs({ [LAST_GOOD_MAX_AGE_ENV]: '1000' })).toBe(1000);
  });

  it('falls back to the default on a non-positive or non-numeric override', () => {
    expect(lastGoodMaxAgeMs({ [LAST_GOOD_MAX_AGE_ENV]: '0' })).toBe(DEFAULT_LAST_GOOD_MAX_AGE_MS);
    expect(lastGoodMaxAgeMs({ [LAST_GOOD_MAX_AGE_ENV]: '-5' })).toBe(DEFAULT_LAST_GOOD_MAX_AGE_MS);
    expect(lastGoodMaxAgeMs({ [LAST_GOOD_MAX_AGE_ENV]: 'not-a-number' })).toBe(DEFAULT_LAST_GOOD_MAX_AGE_MS);
  });
});

// ── c. assertMainNotStale — the x5wbsbc last-good fallback for a managed clone ──────────────────────────────

describe('assertMainNotStale — the x5wbsbc last-good fallback (managed clone)', () => {
  const saved = {};
  beforeEach(() => {
    saved.had = Object.prototype.hasOwnProperty.call(process.env, 'WE_DAEMON_MANAGED_CLONE');
    saved.value = process.env.WE_DAEMON_MANAGED_CLONE;
    process.env.WE_DAEMON_MANAGED_CLONE = '1';
  });
  afterEach(() => {
    if (saved.had) process.env.WE_DAEMON_MANAGED_CLONE = saved.value;
    else delete process.env.WE_DAEMON_MANAGED_CLONE;
  });

  const warnCheck = () => () => ({
    action: 'warn', reason: 'diverged', behind: 3, ahead: 2, dirty: false,
  });

  it('onLastGood true: returns fresh/onLastGood, does NOT throw, writes a LAST-KNOWN-GOOD line (no ALERT)', () => {
    const root = makeRealRepoWithOrigin();
    const writes = [];
    const lastGood = () => ({
      onLastGood: true,
      lastGood: 'a'.repeat(40),
      held: { since: new Date().toISOString(), reason: 'smoke-rejected' },
      heldSince: new Date().toISOString(),
      ageMs: 1000,
      overAge: false,
    });

    const result = assertMainNotStale(root, warnCheck(), { lastGood, write: (s) => writes.push(s) });

    expect(result.fresh).toBe(true);
    expect(result.onLastGood).toBe(true);
    expect(result.lastGood).toBe('a'.repeat(40));
    expect(writes.some((s) => s.includes('LAST-KNOWN-GOOD'))).toBe(true);
    expect(writes.some((s) => s.includes('ALERT'))).toBe(false);
  });

  it('overAge true: ALSO writes an ALERT line, and still returns without throwing', () => {
    const root = makeRealRepoWithOrigin();
    const writes = [];
    const lastGood = () => ({
      onLastGood: true,
      lastGood: 'b'.repeat(40),
      held: { since: new Date(0).toISOString(), reason: 'smoke-rejected' },
      heldSince: new Date(0).toISOString(),
      ageMs: 30 * 3_600_000, // 30h
      overAge: true,
    });

    const result = assertMainNotStale(root, warnCheck(), { lastGood, write: (s) => writes.push(s) });

    expect(result.fresh).toBe(true);
    expect(result.overAge).toBe(true);
    expect(writes.some((s) => s.includes('LAST-KNOWN-GOOD'))).toBe(true);
    expect(writes.some((s) => s.includes('ALERT'))).toBe(true);
  });

  it('onLastGood false: still throws with the STALE code marker', () => {
    const root = makeRealRepoWithOrigin();
    const lastGood = () => ({
      onLastGood: false, lastGood: null, held: null, heldSince: null, ageMs: null, overAge: false,
    });

    expect(() => assertMainNotStale(root, warnCheck(), { lastGood, write: () => {} }))
      .toThrow(STALE_MAIN_REFUSAL_MARKER);
  });

  it('a lastGood that throws is treated the same as onLastGood:false (fail closed) — still throws the STALE marker', () => {
    const root = makeRealRepoWithOrigin();
    const lastGood = () => { throw new Error('boom'); };

    expect(() => assertMainNotStale(root, warnCheck(), { lastGood, write: () => {} }))
      .toThrow(STALE_MAIN_REFUSAL_MARKER);
  });

  it('a non-warn check (fresh/synced) never calls lastGood at all', () => {
    const root = makeRealRepoWithOrigin();
    let called = false;
    const lastGood = () => { called = true; return { onLastGood: true }; };
    const freshCheck = () => ({ fresh: true, behind: 0 });

    const result = assertMainNotStale(root, freshCheck, { lastGood, write: () => {} });

    expect(result.fresh).toBe(true);
    expect(called).toBe(false);
  });
});

describe('decideRebuildGrace — bounded grace while a rebuild of the clone is running (PRs #3923/#3924)', () => {
  const now = Date.parse('2026-10-04T19:00:00Z');
  const state = (o = {}) => ({
    adopted: { head: 'h', at: '2026-10-04T18:25:00Z' },
    building: { pid: 1, host: 'x', startedAt: '2026-10-04T18:50:00Z', target: 't' }, ...o,
  });
  const base = { nowMs: now, graceMs: 60 * 60_000, leaseStaleMs: 20 * 60_000, ownerAlive: () => true };
  it('grants the grace for a live build within the window since the last adoption', () => {
    expect(decideRebuildGrace({ ...base, state: state() })).toMatchObject({ grace: true, target: 't', sinceAdoptMs: 35 * 60_000 });
  });
  it('refuses (fails closed) for every unknown or out-of-bounds case', () => {
    expect(decideRebuildGrace({ ...base, state: null }).grace).toBe(false);
    expect(decideRebuildGrace({ ...base, state: state({ building: null }) }).reason).toBe('no-build-running');
    expect(decideRebuildGrace({ ...base, state: state(), graceMs: 0 }).reason).toBe('grace-off');
    expect(decideRebuildGrace({ ...base, state: state(), ownerAlive: () => false }).reason).toBe('build-owner-gone');
    expect(decideRebuildGrace({ ...base, state: state({ adopted: { head: 'h' } }) }).reason).toBe('no-adoption-time');
    expect(decideRebuildGrace({ ...base, state: state(), graceMs: 30 * 60_000 }).reason).toBe('grace-expired');
    expect(decideRebuildGrace({ ...base, state: state({ building: { pid: 1, startedAt: '2026-10-04T18:30:00Z' } }) }).reason)
      .toBe('build-lease-stale');
  });
  it('the grace window is a WE_* knob (0 = off, junk = default)', () => {
    expect(staleGuardRebuildGraceMs({})).toBe(DEFAULT_STALE_GUARD_REBUILD_GRACE_MS);
    expect(staleGuardRebuildGraceMs({ [STALE_GUARD_REBUILD_GRACE_ENV]: '0' })).toBe(0);
    expect(staleGuardRebuildGraceMs({ [STALE_GUARD_REBUILD_GRACE_ENV]: '5000' })).toBe(5000);
    expect(staleGuardRebuildGraceMs({ [STALE_GUARD_REBUILD_GRACE_ENV]: 'nope' })).toBe(DEFAULT_STALE_GUARD_REBUILD_GRACE_MS);
  });
  it('rebuildGraceForClone reads the clone\'s rebuild state and never throws', () => {
    expect(rebuildGraceForClone({ root: '/x', env: {}, now, readState: () => state(), ownerAlive: () => true }).grace).toBe(true);
    expect(rebuildGraceForClone({ root: '/x', env: {}, now, readState: () => { throw new Error('boom'); } }).grace).toBe(false);
  });
});
