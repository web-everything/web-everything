/** Real CLI acceptance tests: parked fixers must not force a rescan/retry storm. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';

const SCRIPT = resolve('scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }).trim();
let fixtureRoot, sharedFixture, origin, reference, base, pool, bin, preload, audit;
const lane = (n) => join(pool, 'holdtest', `lane-${n}`);
const lease = (n) => join(lane(n), '.git', '.lane-lease');
const argsForRepo = () => [`--origin=${origin}`, `--reference=${reference}`, '--name=holdtest', '--branch=main', '--no-install', '--no-reap'];

function run(args, observe = false, extraEnv = {}) {
  const result = spawnSync(process.execPath, [ ...(observe ? ['--require', preload] : []), SCRIPT, ...args, ...argsForRepo() ], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANE_POOL_ROOT: pool,
      LANE_POOL_NO_RECOVER: '1', LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '0',
      WE_LANE_HOLD: 'enforce', WE_AWAIT_VERIFY_STORE: join(base, 'await-store'),
      LANE_POOL_ACQUIRE_DEBUG: '1', TEST_ACQUIRE_AUDIT: audit, ...extraEnv },
  });
  expect(result.error, 'CLI must exit normally, never hit the fixture timeout').toBeUndefined();
  return { code: result.status, out: result.stdout, err: result.stderr };
}
function provision(count) {
  const result = run(['provision', `--count=${count}`]);
  expect(result.code, result.err).toBe(0);
}
function park(n) {
  const record = JSON.stringify({ v: 1, pr: 123, requestedAt: new Date().toISOString(), session: `fixer-${n}` });
  writeFileSync(join(lane(n), '.git', '.fix-await-verify'), record);
  return record;
}
const events = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map((s) => JSON.parse(s)) : [];
const acquire = (waitMs, extra = [], extraEnv = {}) => run(['acquire', '--no-free-list', '--json', '--session=acceptance-picker', `--wait-ms=${waitMs}`, ...extra], true, extraEnv);

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-hold-fixture-'));
  origin = join(fixtureRoot, 'origin.git');
  reference = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'file.txt'), 'main tip\n');
  git(['add', 'file.txt'], reference);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'fixture'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  sharedFixture = sharedRepos(fixtureRoot, [origin, reference]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-hold-acquire-'));
  pool = join(base, 'pool');
  bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  audit = join(base, 'audit.jsonl');
  preload = join(base, 'observe.cjs');
  // Observe the actual shared-scan lock, not a hypothetical future debug API. Only the CLI
  // process loads this hook; git children and the host clock remain untouched. Advancing the
  // clock at synchronous waits guarantees multiple poll rounds without wall-clock races.
  writeFileSync(preload, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const audit = process.env.TEST_ACQUIRE_AUDIT;
const record = (event) => fs.appendFileSync(audit, JSON.stringify(event) + '\\n');
const mkdir = fs.mkdirSync;
fs.mkdirSync = function(path, ...args) {
  const result = mkdir.call(this, path, ...args);
  if (String(path).endsWith('/.list-acquirable.lock')) record({ kind: 'scan' });
  return result;
};
syncBuiltinESMExports();
let now = Date.now();
Date.now = () => now;
let draws = 0;
Math.random = () => (++draws % 2 ? 0.2 : 0.8);
const wait = Atomics.wait;
Atomics.wait = function(array, index, value, ms) {
  const stack = new Error().stack;
  const kind = stack.includes('acquirableListCached') ? 'lock-wait' : stack.includes('cmdAcquire') ? 'acquire-wait' : null;
  if (!kind) return wait.call(this, array, index, value, ms);
  record({ kind, ms, at: now });
  now += Math.max(1, Math.ceil(ms));
  return 'timed-out';
};
`);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); sharedFixture.restore(); });

describe('lane-pool acquire after lane-hold reset refusal', () => {
  it('skips an index.lock provision failure, releases the claim, takes the next lane and logs both diagnostics', () => {
    provision(2);
    const lock = join(lane(1), '.git', 'index.lock');
    writeFileSync(lock, 'leftover index lock\n');
    const result = acquire(0, ['--cache-ttl-ms=0']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).lane).toBe(2);
    expect(existsSync(lease(1))).toBe(false);
    expect(existsSync(lease(2))).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('leftover index lock\n');
    expect(result.err).toContain('lane-1: stale .git/index.lock - skipped; needs cleanup');
    expect(result.err).toMatch(/lane-1 claimed but failed to provision \([^\n]*\) — releasing it and trying another candidate/);
    expect(events().filter((e) => e.kind === 'scan')).toHaveLength(1);
  }, 60_000);

  it.each(['1', ''])('prints __SCAN_LOCK_HELD_MS__ only with LANE_POOL_ACQUIRE_DEBUG=1 (value=%j)', (debug) => {
    provision(1);
    const result = acquire(0, ['--cache-ttl-ms=0'], { LANE_POOL_ACQUIRE_DEBUG: debug });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).lane).toBe(1);
    expect(events().filter((e) => e.kind === 'scan')).toHaveLength(1);
    if (debug === '1') expect(result.err).toMatch(/^__SCAN_LOCK_HELD_MS__=\d+$/m);
    else expect(result.err).not.toContain('__SCAN_LOCK_HELD_MS__');
  }, 60_000);

  it('tries two refused lanes then the healthy lane from ONE scan snapshot and releases failed claims', () => {
    provision(3);
    const records = [park(1), park(2)];
    // Disable cross-snapshot caching so it cannot hide a second scan invocation. A single
    // acquire must consume its own snapshot even when the shared cache is disabled/expired.
    const result = acquire(0, ['--cache-ttl-ms=0']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).lane).toBe(3);
    expect(result.err.match(/reset REFUSED — lane-hold:/g)).toHaveLength(2);
    expect(existsSync(lease(1))).toBe(false);
    expect(existsSync(lease(2))).toBe(false);
    expect(readFileSync(join(lane(1), '.git', '.fix-await-verify'), 'utf8')).toBe(records[0]);
    expect(readFileSync(join(lane(2), '.git', '.fix-await-verify'), 'utf8')).toBe(records[1]);
    expect(events().filter((e) => e.kind === 'scan'), 'one actual full-scan lock acquisition').toHaveLength(1);
  }, 60_000);

  it('exits 1 (not the environmental 75) when the only lane is held by a foreign live lease', () => {
    provision(1);
    const held = run(['acquire', '--lane=1', '--session=foreign-live-owner', '--json']);
    expect(held.code, held.err).toBe(0);
    const result = acquire(0);
    expect(result.code).toBe(1);
  }, 60_000);

  it('does not retry a lane-hold-refused lane across acquire poll rounds', () => {
    provision(1);
    park(1);
    const result = acquire(2500);
    expect(result.code, 'only lane-hold refusals => environmental-only exit 75').toBe(75);
    expect(events().filter((e) => e.kind === 'acquire-wait').length).toBeGreaterThanOrEqual(2);
    expect(result.err.match(/lane-1: reset REFUSED — lane-hold:/g), 'sticky refusal exclusion').toHaveLength(1);
    expect(existsSync(lease(1))).toBe(false);
    expect(result.out.trim()).toBe('');
  }, 60_000);

  it('exits 1 rather than 75 when a hold refusal is mixed with a non-hold index.lock provision failure', () => {
    provision(2);
    const parked = park(1);
    const lock = join(lane(2), '.git', 'index.lock');
    writeFileSync(lock, 'leftover index lock\n');
    const result = acquire(0, ['--cache-ttl-ms=0']);
    expect(result.code, result.err).toBe(1);
    expect(result.err.match(/lane-1: reset REFUSED — lane-hold:/g)).toHaveLength(1);
    expect(result.err).toContain('lane-2: stale .git/index.lock - skipped; needs cleanup');
    expect(result.err).toMatch(/lane-2 claimed but failed to provision \([^\n]*\) — releasing it and trying another candidate/);
    expect(existsSync(lease(1))).toBe(false);
    expect(existsSync(lease(2))).toBe(false);
    expect(readFileSync(join(lane(1), '.git', '.fix-await-verify'), 'utf8')).toBe(parked);
    expect(readFileSync(lock, 'utf8')).toBe('leftover index lock\n');
    expect(result.out.trim()).toBe('');
  }, 60_000);

  it('never hands out or modifies a lane held by a live foreign lease', () => {
    provision(2);
    const held = run(['acquire', '--lane=1', '--session=foreign-live-owner', '--json']);
    expect(held.code, held.err).toBe(0);
    const original = readFileSync(lease(1), 'utf8');
    const result = acquire(0);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).lane).toBe(2);
    expect(readFileSync(lease(1), 'utf8')).toBe(original);
  }, 60_000);

  it.each(['acquire-wait', 'lock-wait'])('%s uses varying jittered delays capped by the remaining wait-ms deadline', (kind) => {
    provision(1);
    if (kind === 'lock-wait') {
      const lock = join(pool, 'holdtest', '.list-acquirable.lock');
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }));
    } else {
      const held = run(['acquire', '--lane=1', '--session=foreign-live-owner', '--json']);
      expect(held.code, held.err).toBe(0);
    }
    const result = acquire(2500);
    expect(result.code, result.err).toBe(kind === 'lock-wait' ? 75 : 1);
    const waits = events().filter((e) => e.kind === kind);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(waits.map((e) => e.ms)).size, 'poll intervals must vary with injected random draws').toBeGreaterThan(1);
    const deadline = waits[0].at + 2500;
    for (const wait of waits) {
      expect(wait.ms).toBeGreaterThan(0);
      expect(wait.at + wait.ms, 'sleep must not extend beyond caller deadline').toBeLessThanOrEqual(deadline);
    }
  }, 60_000);
});
