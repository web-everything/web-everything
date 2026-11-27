/**
 * @file scripts/lib/__tests__/daemon-last-good.test.mjs
 * @description x5wbsbc (epic #4075) — `../daemon-last-good.mjs` (the ONE read both `main-staleness.mjs` and
 *   `daemon-rebuild.mjs` share for "is this managed clone running its last smoke-verified build?") plus the
 *   managed-clone last-good fallback branch of `../main-staleness.mjs#assertMainNotStale`. Real temp git fixtures
 *   for the `cloneKeyOf` cross-check and the `assertMainNotStale` behavioral tests; everything else is pure.
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { once } from 'node:events';
import { spawnKeepAlive } from '../test-keepalive.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  cloneKeyOf, decideLastGood, lastGoodForClone, lastGoodMaxAgeMs, LAST_GOOD_MAX_AGE_ENV, DEFAULT_LAST_GOOD_MAX_AGE_MS,
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

describe('BUILD-LEASE-SMOKE-AWARE reader', () => {
  const minute = 60_000;
  const now = Date.parse('2026-11-27T21:21:54.737Z');
  const iso = (t) => new Date(t).toISOString();
  let root, env;
  beforeEach(() => {
    root = mktemp('we-heartbeat-reader-');
    env = { WE_DAEMON_STATE_DIR: mktemp('we-heartbeat-state-'), WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-heartbeat-lock-') };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  const fixture = () => {
    const building = { token: '123-deadbeef', pid: 123, host: 'fixture-host', startedAt: iso(now - 35 * minute) };
    return {
      headSha: '2996145c', state: { adopted: { head: '2996145c', at: iso(now - 120 * minute) }, building },
      dirty: false, nowMs: now, maxAgeMs: 24 * 60 * minute, freshAdoptMs: 60 * minute,
      heartbeat: { ...building, at: iso(now - 24_737) }, ownerAlive: () => true, thisHost: 'fixture-host',
    };
  };
  const heartbeatFile = (token) => join(env.WE_DAEMON_STATE_DIR, `${cloneKey(root)}.build-heartbeat.${token}.json`);

  it.each([
    ['T1', '2026-11-27T20:20:16Z', '2026-11-27T20:46:06Z', '2026-11-27T21:21:54.737Z'],
    ['T2', '2026-11-27T17:52:00Z', '2026-11-27T19:39:41Z', '2026-11-27T20:15:53Z'],
  ])('%s incident replay holds only with the live heartbeat', (_id, adoptedAt, startedAt, at) => {
    const o = fixture();
    o.nowMs = Date.parse(at);
    o.state.adopted.at = adoptedAt;
    o.state.building.startedAt = startedAt;
    o.heartbeat.startedAt = startedAt;
    o.heartbeat.at = iso(o.nowMs - 24_737);
    expect(decideLastGood({ ...o, heartbeat: null }).onLastGood).toBe(false);
    expect(decideLastGood(o)).toMatchObject({ onLastGood: true, holdingBy: 'heartbeat', heartbeatAgeMs: 24_737,
      buildAgeMs: o.nowMs - Date.parse(startedAt) });
  });
  it('T3a dead owner cannot extend a 35-minute lease', () => {
    expect(decideLastGood({ ...fixture(), ownerAlive: () => false }).onLastGood).toBe(false);
  });
  it('T3b dead owner still holds by the unchanged 20-minute lease floor', () => {
    const o = fixture();
    o.state.building.startedAt = iso(now - 19 * minute);
    expect(decideLastGood({ ...o, ownerAlive: () => false })).toMatchObject({ onLastGood: true, holdingBy: 'lease' });
  });
  it.each([['T4a', 5 * minute + 1000, false], ['T4b', 4 * minute, true],
    ['heartbeat age zero', 0, true], ['heartbeat age 5 min', 5 * minute, true],
    ['heartbeat age 5 min - 1 ms', 5 * minute - 1, true],
    ['heartbeat age 5 min + 1 ms', 5 * minute + 1, false], ['heartbeat age -1 ms', -1, false],
  ])('%s heartbeat freshness boundary', (_id, age, holds) => {
    const o = fixture(); o.heartbeat.at = iso(now - age);
    expect(decideLastGood(o).onLastGood).toBe(holds);
  });
  it.each([['T5a', 91 * minute, false], ['T5b', 89 * minute, true],
    ['build age 90 min', 90 * minute, true], ['build age 90 min + 1 ms', 90 * minute + 1, false],
    ['build age 90 min - 1 ms', 90 * minute - 1, true],
  ])('%s absolute build cap', (_id, age, holds) => {
    const o = fixture(); o.state.building.startedAt = iso(now - age); o.heartbeat.startedAt = o.state.building.startedAt;
    expect(decideLastGood(o).onLastGood).toBe(holds);
  });
  it('T6 dirty tree refuses', () => expect(decideLastGood({ ...fixture(), dirty: true }).onLastGood).toBe(false));
  it('T7 different HEAD refuses', () => expect(decideLastGood({ ...fixture(), headSha: 'other' }).onLastGood).toBe(false));
  it.each([
    ['token', (o) => { o.heartbeat.token = '123-cafebabe'; }],
    ['pid', (o) => { o.heartbeat.pid++; }],
    ['heartbeat host', (o) => { o.heartbeat.host = 'other-host'; }],
    ['foreign lease host', (o) => { o.state.building.host = o.heartbeat.host = 'other-host'; }],
    ['adoptOnly', (o) => { o.state.building.adoptOnly = true; }],
    ['no lease', (o) => { o.state.building = null; }],
    ['invalid token', (o) => { o.state.building.token = o.heartbeat.token = '../escape'; }],
    ['null host', (o) => { o.thisHost = o.state.building.host = o.heartbeat.host = null; }],
    ['string pid', (o) => { o.state.building.pid = o.heartbeat.pid = '123'; }],
    ['zero pid', (o) => { o.state.building.pid = o.heartbeat.pid = 0; }],
    ['missing token', (o) => { delete o.state.building.token; delete o.heartbeat.token; }],
    ['missing heartbeat', (o) => { o.heartbeat = null; }],
    ['unknown liveness', (o) => { delete o.ownerAlive; }],
    ['ambiguous liveness', (o) => { o.ownerAlive = () => 'unknown'; }],
    ['throwing liveness', (o) => { o.ownerAlive = () => { throw new Error('unreadable'); }; }],
  ])('T8 %s refuses heartbeat', (_id, mutate) => {
    const o = fixture(); mutate(o);
    expect(decideLastGood(o).onLastGood).toBe(false);
  });
  it.each(['future', 'invalid heartbeat', 'invalid build'])('T9 %s clock refuses', (kind) => {
    const o = fixture();
    if (kind === 'future') o.heartbeat.at = iso(now + 2 * minute);
    if (kind === 'invalid heartbeat') o.heartbeat.at = 'unparseable';
    if (kind === 'invalid build') o.state.building.startedAt = 'unparseable';
    expect(decideLastGood(o).onLastGood).toBe(false);
  });
  it('T10 IO shell reads its lease token file and refuses after owner exit', async () => {
    const child = spawnKeepAlive({ cwd: root, env, anchorPid: process.pid });
    try {
      await once(child, 'spawn');
      const o = fixture();
      Object.assign(o.state.building, { pid: child.pid, host: hostname() });
      const hb = { ...o.state.building, at: iso(now) };
      writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKey(root)}.rebuild.json`), JSON.stringify(o.state));
      writeFileSync(heartbeatFile(hb.token), JSON.stringify(hb));
      const read = () => lastGoodForClone({ root, env, headSha: o.headSha, now });
      expect(read()).toMatchObject({ onLastGood: true, holdingBy: 'heartbeat' });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      expect(read().onLastGood).toBe(false);
    } finally { child.kill('SIGKILL'); }
  });
  it.each(['{', '{}', 'null', '[]', '{"at":"2026-11-27T21:21:54Z"}', null])('T11 malformed/absent file %s equals no heartbeat', (content) => {
    const o = fixture(); o.state.building.host = hostname();
    writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKey(root)}.rebuild.json`), JSON.stringify(o.state));
    if (content !== null) writeFileSync(heartbeatFile(o.state.building.token), content);
    const opts = { root, env, headSha: o.headSha, now, ownerAlive: () => true };
    expect(lastGoodForClone(opts)).toEqual(lastGoodForClone({ ...opts, readHeartbeat: () => null }));
  });
  it('T11 reads only the exact valid lease token, never a foreign file or traversal', () => {
    const o = fixture(); o.state.building.host = hostname();
    writeFileSync(heartbeatFile('123-cafebabe'), JSON.stringify({ ...o.state.building, at: iso(now) }));
    const read = () => lastGoodForClone({ root, env, headSha: o.headSha, now, ownerAlive: () => true });
    for (const token of ['123-deadbeef', '../escape', null]) {
      o.state.building.token = token;
      writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKey(root)}.rebuild.json`), JSON.stringify(o.state));
      expect(read().onLastGood).toBe(false);
    }
  });
  it('T11 unreadable heartbeat and injected reader errors leave the old rule unchanged', () => {
    const o = fixture(); o.state.building.host = hostname();
    writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKey(root)}.rebuild.json`), JSON.stringify(o.state));
    mkdirSync(heartbeatFile(o.state.building.token));
    const opts = { root, env, headSha: o.headSha, now, ownerAlive: () => true };
    const absent = lastGoodForClone({ ...opts, readHeartbeat: () => null });
    expect(lastGoodForClone(opts)).toEqual(absent);
    expect(lastGoodForClone({ ...opts, readHeartbeat: () => { throw new Error('read failed'); } })).toEqual(absent);
  });
  it('T12 heartbeat never extends rebuild grace', () => {
    const o = fixture();
    expect(decideRebuildGrace({ ...o, graceMs: 60 * minute })).toMatchObject({ grace: false, reason: 'build-lease-stale' });
  });
  it('T13 restart without a live build still refuses', () => {
    const o = fixture(); o.state.building = null; o.heartbeat = null;
    o.state.adopted.at = '2026-11-27T17:52:00Z'; o.nowMs = Date.parse('2026-11-27T19:30:00Z');
    expect(decideLastGood(o).onLastGood).toBe(false);
  });
  it.each([['T14a', 'heartbeat', true], ['T14b', 'held', false]])('%s dispatch log tag and source', (_id, holdingBy, tagged) => {
    vi.stubEnv('WE_DAEMON_MANAGED_CLONE', '1');
    const writes = [];
    const st = assertMainNotStale(root, () => ({ action: 'warn', behind: 12, dirty: false }), {
      codeRoot: root, armed: false, reexeced: false, reexec: () => { throw new Error('unexpected reexec'); },
      listBehindFiles: () => ['scripts/dispatch.mjs'], treeDirtyForCode: () => false,
      rebuildGrace: () => ({ grace: false }), changedFiles: () => [],
      lastGood: () => ({ onLastGood: true, lastGood: '2996145c', holdingBy, heartbeatAgeMs: 24_737, buildAgeMs: 35 * minute }),
      write: (s) => writes.push(s),
    });
    expect(writes.join('')).toContain('LAST-KNOWN-GOOD');
    if (tagged) expect(writes.join('')).toContain('rebuild in flight (heartbeat 25s ago, build 35 min old)');
    else expect(writes.join('')).not.toContain('rebuild in flight');
    if (tagged) expect(st.holdingBy).toBe(holdingBy);
  });
  it('holding sources prefer held, lease, heartbeat, then fresh adoption', () => {
    const o = fixture(); o.state.adopted.at = iso(now);
    expect(decideLastGood(o).holdingBy).toBe('heartbeat');
    o.state.building.startedAt = iso(now);
    expect(decideLastGood(o).holdingBy).toBe('lease');
    o.state.held = { since: iso(now) };
    expect(decideLastGood(o).holdingBy).toBe('held');
    o.state.held = null; o.state.building = null;
    expect(decideLastGood(o).holdingBy).toBe('fresh-adoption');
    o.state.adopted.at = iso(now - 120 * minute);
    expect(decideLastGood(o).holdingBy).toBeNull();
  });
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

describe('fresh adoption between rebuilds — PR #4624 live replay', () => {
  const head = '26442e4a'.padEnd(40, '0');
  const nowMs = Date.parse('2026-10-09T19:18:00Z');
  const options = {
    headSha: head, state: { adopted: { head, at: '2026-10-09T19:09:36.000Z' } },
    nowMs, maxAgeMs: DEFAULT_LAST_GOOD_MAX_AGE_MS, freshAdoptMs: 3_600_000,
  };
  it('accepts a just-adopted clean build with neither held nor building state', () => {
    expect(decideLastGood(options)).toMatchObject({ onLastGood: true, held: null, ageMs: null, overAge: false });
  });
  it('keeps grace opt-in for the pure decision', () => {
    expect(decideLastGood({ ...options, freshAdoptMs: 0 }).onLastGood).toBe(false);
    expect(decideLastGood({ ...options, freshAdoptMs: undefined }).onLastGood).toBe(false);
  });
  it.each([
    ['two-hour-old adoption', { state: { adopted: { head, at: '2026-10-09T17:18:00Z' } } }],
    ['dirty tree', { dirty: true }],
    ['different HEAD', { headSha: 'b'.repeat(40) }],
    ['invalid adoption time', { state: { adopted: { head, at: 'invalid' } } }],
  ])('refuses %s despite a one-hour grace', (_name, override) => {
    expect(decideLastGood({ ...options, ...override }).onLastGood).toBe(false);
  });
});
