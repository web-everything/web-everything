/**
 * @file scripts/__tests__/lane-pool-free-list-event-refresh.test.mjs
 * @description The published free-lane list is refreshed by lane-pool's own acquire/release events, not only by
 *   the periodic health-watch pass (whose gaps of 8-44 min let it go stale and sent `acquire` into the full scan).
 *   Spawns the real CLI against a throwaway pool.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { touchFreeLaneList, readFreeLaneList, isFreeLaneListFresh } from '../lib/free-lane-list.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, preload = null) {
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_LANE_SALVAGE_DIR: join(base, 'salvage') };
  delete env.LANE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [...(preload ? ['--import', preload] : []), SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-free-list-event-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-free-list-event-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=freepool', '--branch=trunk', '--no-install'];

function acquireOneLane() {
  expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
  const acquire = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json']);
  expect(acquire.code).toBe(0);
  return JSON.parse(acquire.out); // { lane, path?, holder, ... }
}

function laneDir(lane) {
  return join(poolRoot, 'freepool', `lane-${lane}`);
}

function statusOf(lane) {
  const status = runPool(['status', ...poolArgs(), '--json']);
  expect(status.code).toBe(0);
  const rows = JSON.parse(status.out).lanes;
  return rows.find((r) => r.lane === lane);
}


const listFile = () => join(base, 'free.json');
const withList = (args) => runPool(args);

describe('free-lane list is refreshed by lane-pool events', () => {
  beforeEach(() => { process.env.LANE_POOL_FREE_LIST_FILE = listFile(); });
  afterEach(() => { delete process.env.LANE_POOL_FREE_LIST_FILE; });

  it('after a release the list is FRESH and names the lane, with no periodic pass', () => {
    const { lane } = acquireOneLane();
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] })); // ancient
    const before = Date.now();
    expect(withList(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']).code).toBe(0);
    const list = readFreeLaneList(listFile());
    expect(isFreeLaneListFresh(list, Date.now(), 60_000)).toBe(true);
    expect(list.writtenAt).toBeGreaterThanOrEqual(before);
    expect(list.lanes.map((l) => l.lane)).toContain(lane);
  });

  it('an acquire drops the lane from the list and keeps it fresh', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [{ lane: 1 }] }));
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json']).out);
    const list = readFreeLaneList(listFile());
    expect(list.lanes.map((l) => l.lane)).not.toContain(a.lane);
    expect(isFreeLaneListFresh(list, Date.now(), 60_000)).toBe(true);
  });
});

describe('touchFreeLaneList', () => {
  it('adds/removes one entry, keeps the others, stamps now, and never throws', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'touch-')), 'l.json');
    expect(touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane: 3, free: true, now: 100 })).toBe(true);
    touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane: 1, free: true, now: 200 });
    touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane: 3, free: false, now: 300 });
    const l = readFreeLaneList(f);
    expect(l.lanes.map((x) => x.lane)).toEqual([1]);
    expect(l.writtenAt).toBe(300);
    expect(touchFreeLaneList({ path: '/proc/nope/x.json', repoName: 'r', poolDir: '/p', lane: 1, free: true })).toBe(false);
  });
});
