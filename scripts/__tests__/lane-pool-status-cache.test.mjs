/**
 * @file scripts/__tests__/lane-pool-status-cache.test.mjs
 * @description Host churn cut (2026-10-04) — `lane-pool.mjs status --max-age-ms=N` reuses a recent,
 *   signature-matched per-lane probe (`../lib/lane-status-cache.mjs`) instead of re-running `git status` over
 *   every lane. Pinned against a real throwaway pool, with a PATH-shimmed git that logs every spawn:
 *   1. a second `status --max-age-ms` call within the window spawns ZERO git children in any lane;
 *   2. the default (no flag, no env) still probes every lane fresh — today's behaviour is unchanged;
 *   3. any git-level change (a commit) invalidates that lane's row immediately, even inside the window;
 *   4. an expired row is re-probed.
 *   On main before this change, `--max-age-ms` is an unknown flag (non-zero exit) — red at assertion 1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachedGitFields, laneGitSignature, resolveStatusMaxAgeMs } from '../lib/lane-status-cache.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const N = 3;
let base, originDir, referenceDir, poolRoot, shimDir, spawnLog;
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=stcache', '--branch=trunk', '--no-install'];
const laneDirOf = (n) => join(poolRoot, 'stcache', `lane-${n}`);

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${shimDir}:${process.env.PATH}`, WE_LANE_STATUS_MAX_AGE_MS: '', ...extraEnv },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const spawnsIn = (n) => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter((l) => l.startsWith(`${laneDirOf(n)}|`)) : []);
const resetLog = () => writeFileSync(spawnLog, '');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lane-pool-status-cache-')));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'bin');
  spawnLog = join(base, 'git-spawns.log');
  mkdirSync(shimDir, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shimDir, 'git'), `#!/bin/bash\necho "$PWD|$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/trunk'], referenceDir);
  expect(runPool(['provision', `--count=${N}`, ...poolArgs()]).code).toBe(0);
});

afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('status --max-age-ms (host churn cut)', () => {
  it('reuses a signature-matched probe inside the window: zero git spawns in any lane', () => {
    const first = runPool(['status', ...poolArgs(), '--json', '--max-age-ms=600000']);
    expect(first.code).toBe(0);
    resetLog();
    const second = runPool(['status', ...poolArgs(), '--json', '--max-age-ms=600000']);
    expect(second.code).toBe(0);
    for (let n = 1; n <= N; n++) expect(spawnsIn(n)).toEqual([]);
    const strip = (p) => JSON.parse(p).lanes.map(({ lane, head, branch, clean, behind, leased }) => ({ lane, head, branch, clean, behind, leased }));
    expect(strip(second.out)).toEqual(strip(first.out));
  });

  it('default (no flag, no env) still probes every lane fresh and writes nothing — today\'s behaviour', () => {
    expect(runPool(['status', ...poolArgs(), '--json', '--max-age-ms=600000']).code).toBe(0);
    rmSync(join(poolRoot, 'stcache', '.lane-status-cache.json'));
    expect(runPool(['status', ...poolArgs(), '--json']).code).toBe(0);
    expect(existsSync(join(poolRoot, 'stcache', '.lane-status-cache.json'))).toBe(false);
    expect(runPool(['status', ...poolArgs(), '--json', '--max-age-ms=600000']).code).toBe(0);
    resetLog();
    expect(runPool(['status', ...poolArgs(), '--json']).code).toBe(0);
    for (let n = 1; n <= N; n++) expect(spawnsIn(n).some((l) => l.includes('status --porcelain'))).toBe(true);
  });

  it('a commit in a lane invalidates its row at once, even inside the window', () => {
    expect(runPool(['status', ...poolArgs(), '--json', '--max-age-ms=600000']).code).toBe(0);
    const d = laneDirOf(2);
    git(['config', 'user.email', 't@t.com'], d);
    git(['config', 'user.name', 't'], d);
    writeFileSync(join(d, 'file.txt'), 'v2\n');
    git(['commit', '--quiet', '-am', 'v2'], d);
    resetLog();
    const r = runPool(['status', ...poolArgs(), '--json', '--max-age-ms=600000']);
    expect(r.code).toBe(0);
    expect(spawnsIn(2).some((l) => l.includes('status --porcelain'))).toBe(true);
    expect(spawnsIn(1)).toEqual([]);
    const row = JSON.parse(r.out).lanes.find((l) => l.lane === 2);
    expect(row.head).toBe(git(['rev-parse', '--short', 'HEAD'], d));
  });

  it('env WE_LANE_STATUS_MAX_AGE_MS is the same knob as the flag', () => {
    expect(runPool(['status', ...poolArgs(), '--json'], { WE_LANE_STATUS_MAX_AGE_MS: '600000' }).code).toBe(0);
    resetLog();
    expect(runPool(['status', ...poolArgs(), '--json'], { WE_LANE_STATUS_MAX_AGE_MS: '600000' }).code).toBe(0);
    for (let n = 1; n <= N; n++) expect(spawnsIn(n)).toEqual([]);
  });
});

describe('lane-status-cache pure parts', () => {
  const row = { sig: 's1', ts: 1000, head: 'abc', branch: 'trunk', clean: true, behind: 0 };
  const cache = { lanes: { 1: row } };
  it('hits only on same signature, inside the window, with a positive max age', () => {
    expect(cachedGitFields(cache, 1, 's1', 1500, 1000)).toEqual({ head: 'abc', branch: 'trunk', clean: true, behind: 0 });
    expect(cachedGitFields(cache, 1, 's2', 1500, 1000)).toBeNull();
    expect(cachedGitFields(cache, 1, 's1', 2500, 1000)).toBeNull();
    expect(cachedGitFields(cache, 1, 's1', 1500, 0)).toBeNull();
    expect(cachedGitFields(cache, 1, null, 1500, 1000)).toBeNull();
    expect(cachedGitFields(cache, 2, 's1', 1500, 1000)).toBeNull();
  });
  it('resolves the knob: flag, then env, then default 0', () => {
    expect(resolveStatusMaxAgeMs(undefined, {})).toBe(0);
    expect(resolveStatusMaxAgeMs(undefined, { WE_LANE_STATUS_MAX_AGE_MS: '5000' })).toBe(5000);
    expect(resolveStatusMaxAgeMs('7', { WE_LANE_STATUS_MAX_AGE_MS: '5000' })).toBe(7);
    expect(resolveStatusMaxAgeMs('junk', {})).toBe(0);
  });
  it('signature is null for a non-git dir', () => {
    expect(laneGitSignature(tmpdir(), 'main')).toBeNull();
  });
});
