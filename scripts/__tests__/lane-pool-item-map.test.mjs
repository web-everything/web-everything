/**
 * @file scripts/__tests__/lane-pool-item-map.test.mjs
 * @description Proof of #2616 — `acquire --item=<num>` POPULATES the lane-ports registry
 *   (`we:.claude/lane-ports.json`) so `conveyor-state.mjs`'s health-stall scan can flag a genuinely stalled lane.
 *   A conveyor delivery agent leases its OWN lane and claims its OWN item, so nothing else calls `map` for it;
 *   before #2616 the registry stayed `{}`, no lane carried a num, and `assessHealth` was permanently `ok` (a
 *   silent correctness hole). These tests spawn the real CLI against a throwaway local origin + reference checkout
 *   (no network, no shared pool root) and assert: acquire records `{ "<num>": { lane } }` in the PRIMARY
 *   checkout's registry (with a page port on a banded pool, without on a band-less one); the written shape
 *   reverse-derives to the exact `{ lane: num }` the health scan reads (via the imported pure
 *   {@link reverseLaneItemMap}); a JIT `x…` slug item is kept verbatim; and a plain acquire (no `--item`) never
 *   writes the registry, so today's semantics are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { reverseLaneItemMap } from '../readiness/conveyor-state.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-item-map-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'main-tip\n');
  // #3390 — the real repo gitignores `.env.local` (the per-lane dev-port file `writeLaneEnv` generates for a
  // BANDED pool like `web-everything`), so it never counts as "dirty" for `laneDirtyOrAhead`'s
  // `git status --porcelain` read. This synthetic origin needs the same ignore or the "banded (WE) pool" test
  // below would see its own generated `.env.local` as an untracked change and trip the new dirty-tree guard —
  // a test-fixture gap, not a real one.
  writeFileSync(join(referenceDir, '.gitignore'), '.env.local\n');
  git(['add', 'file.txt', '.gitignore'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-item-map-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

// The registry lives in the reference (PRIMARY) checkout — exactly where conveyor-state's IO shell reads it.
const registryPath = () => join(referenceDir, '.claude', 'lane-ports.json');
const readRegistry = () => JSON.parse(readFileSync(registryPath(), 'utf8'));

function provision(count, name) {
  const r = runPool(
    ['provision', `--count=${count}`, `--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install'],
    { LANE_POOL_ROOT: poolRoot },
  );
  expect(r.code).toBe(0);
}
function acquire(extra, name) {
  return runPool(
    ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${name}`, '--branch=main', '--no-install', ...extra],
    { LANE_POOL_ROOT: poolRoot },
  );
}

describe('lane-pool acquire --item populates the lane-ports registry (#2616)', () => {
  it('band-less pool: records { "<num>": { lane, repo } } (no page port) — all the health scan needs', () => {
    provision(2, 'basetest');
    const r = acquire(['--lane=1', '--item=2616'], 'basetest');
    expect(r.code).toBe(0);

    const reg = readRegistry();
    expect(reg).toEqual({ 2616: { lane: 1, repo: 'basetest' } });

    // The written shape reverse-derives to the { lane: num } lookup conveyor-state's health scan keys on.
    expect(reverseLaneItemMap(reg)).toEqual({ 1: '2616' });

    // stdout stays the clean lane path (the `LANE=$(… acquire)` capture) — the map log rides stderr.
    expect(r.out.trim()).toBe(join(poolRoot, 'basetest', 'lane-1'));
    expect(r.err).toMatch(/#2616 health-stall map/);
  });

  it('banded (WE) pool: also records the lane page port (serves the #2139 review-proxy too)', () => {
    provision(1, 'web-everything');
    const r = acquire(['--lane=1', '--item=2616'], 'web-everything');
    expect(r.code).toBe(0);

    const reg = readRegistry();
    expect(reg['2616'].lane).toBe(1);
    expect(reg['2616'].repo).toBe('web-everything');
    expect(typeof reg['2616'].port).toBe('number'); // banded pool → a page port is recorded
    expect(reverseLaneItemMap(reg)).toEqual({ 1: '2616' });
  });

  it('a JIT x-slug item id is kept (lower-cased to match the case-sensitive #num transcript scan)', () => {
    provision(1, 'basetest');
    const r = acquire(['--lane=1', '--item=X5ETMDV'], 'basetest'); // upper-case in → lower-cased key out
    expect(r.code).toBe(0);
    expect(readRegistry()).toEqual({ x5etmdv: { lane: 1, repo: 'basetest' } });
  });

  it('--no-reset re-acquire replaces a stale entry via the item-block\'s own unmap (reset unmap did not run)', () => {
    provision(1, 'basetest');
    expect(acquire(['--lane=1', '--item=2616'], 'basetest').code).toBe(0);
    // Re-acquire the SAME lane with --no-reset for a NEW item: the reset (and its unmap) is skipped, so the
    // item-block's own unmapLanes is the only thing that clears the stale 2616→lane-1 entry.
    const r = acquire(['--lane=1', '--no-reset', '--item=2617'], 'basetest');
    expect(r.code).toBe(0);
    const reg = readRegistry();
    expect(reg).toEqual({ 2617: { lane: 1, repo: 'basetest' } }); // no stale 2616 left behind
    expect(reverseLaneItemMap(reg)).toEqual({ 1: '2617' });
  });

  it('a comma-separated --item records each id on the lane', () => {
    provision(1, 'basetest');
    const r = acquire(['--lane=1', '--item=2616,2617'], 'basetest');
    expect(r.code).toBe(0);
    expect(readRegistry()).toEqual({ 2616: { lane: 1, repo: 'basetest' }, 2617: { lane: 1, repo: 'basetest' } });
  });

  it('a plain acquire (no --item) NEVER writes the registry — back-compat, today\'s semantics', () => {
    provision(1, 'basetest');
    const r = acquire(['--lane=1'], 'basetest');
    expect(r.code).toBe(0);
    expect(existsSync(registryPath())).toBe(false);
  });

  it('re-acquiring the SAME lane for a NEW item replaces the stale entry — lane→num stays 1:1', () => {
    provision(1, 'basetest');
    expect(acquire(['--lane=1', '--item=2616'], 'basetest').code).toBe(0);
    // Release, then re-acquire the same lane for a different item (the lane recycles between conveyor runs).
    runPool(['release', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main'], { LANE_POOL_ROOT: poolRoot });
    expect(acquire(['--lane=1', '--item=2617'], 'basetest').code).toBe(0);

    const reg = readRegistry();
    // The stale 2616 entry (which pointed at lane 1) was cleared by the reset's unmap; only the new item maps.
    expect(reg).toEqual({ 2617: { lane: 1, repo: 'basetest' } });
    expect(reverseLaneItemMap(reg)).toEqual({ 1: '2617' });
  });
});
