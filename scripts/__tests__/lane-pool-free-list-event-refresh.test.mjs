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
  // `spawnSync` blocks the whole vitest worker, so a hung child would stall the CI shard until its job cap. The
  // timeout turns a hang into a failing test (status null -> code 1, SIGKILL noted in stderr) that names itself.
  const r = spawnSync('node', [...(preload ? ['--import', preload] : []), SCRIPT, ...args], { encoding: 'utf8', env, timeout: 180_000, killSignal: 'SIGKILL' });
  if (r.error && r.error.code === 'ETIMEDOUT') return { code: 1, out: String(r.stdout || ''), err: `lane-pool ${args[0]} timed out after 180s\n${String(r.stderr || '')}` };
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

  it('a release of a lane with an unpushed commit does NOT publish it as free', () => {
    const { lane } = acquireOneLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'new.txt'), 'x\n'); git(['add', 'new.txt'], dir); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'unpushed'], dir);
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] }));
    expect(runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']).code).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // event publication ran
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).not.toContain(lane);
  });

  it('auto-pick --no-reset never hands out a dirty lane that a (stale) list names as free', () => {
    const { lane } = acquireOneLane();
    expect(runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']).code).toBe(0);
    writeFileSync(join(laneDir(lane), 'file.txt'), 'edited after publication\n'); // dirties a tracked file
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: Date.now(), repo: 'freepool', poolDir: null, lanes: [{ lane, at: Date.now() }] }));
    // `--hard-max=1` caps pool growth: with the only lane dirty and refused, an uncapped acquire would fall through to
    // the scan and then PROVISION a new lane (a full clone — minutes under CI load, which stalled a whole unit shard).
    const r = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(laneDir(lane), 'file.txt'), 'utf8')).toBe('edited after publication\n');
  });

  const seedList = (lanes) => writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: Date.now(), repo: 'freepool', poolDir: null, lanes }));
  const releasedLane = () => { // a clean, released lane (no lease) — the shape a published free lane has
    const { lane } = acquireOneLane();
    expect(runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']).code).toBe(0);
    return lane;
  };

  it('auto-pick --no-reset still hands out a lane whose only dirt is known scratch litter (not a refusal)', () => {
    const lane = releasedLane();
    writeFileSync(join(laneDir(lane), '.pr-body.md'), 'scratch\n'); // allowlisted litter: the scan and release call this clean
    seedList([{ lane, at: Date.now() }]);
    const r = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(lane);
  });

  it('auto-pick --no-reset refuses a lane with an unpushed commit that a fresh list names as free', () => {
    const lane = releasedLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'new.txt'), 'x\n'); git(['add', 'new.txt'], dir); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'unpushed-work'], dir);
    seedList([{ lane, at: Date.now() }]);
    const r = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code).not.toBe(0);
    expect(git(['log', '-1', '--format=%s'], dir)).toBe('unpushed-work'); // the work is untouched
  });

  it('a release of a lane with a dirty tracked file does NOT publish it as free', () => {
    const { lane } = acquireOneLane();
    writeFileSync(join(laneDir(lane), 'file.txt'), 'dirty tracked edit\n');
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] }));
    expect(runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json']).code).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // event publication ran
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).not.toContain(lane);
    expect(readFileSync(join(laneDir(lane), 'file.txt'), 'utf8')).toBe('dirty tracked edit\n');
  });

  it('a release of a RESERVED lane does NOT publish it as free', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', '--reserve', ...poolArgs(), '--no-reset', '--session=owner', '--json']).code).toBe(0);
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] }));
    const r = runPool(['release', '--lane=1', '--release-reserved', ...poolArgs(), '--session=owner', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // event publication ran
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).not.toContain(1);
  });

  it('acquire removes a FRESH candidate from the list and keeps the other fresh candidate', () => {
    expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
    seedList([{ lane: 2, at: Date.now() }, { lane: 3, at: Date.now() }]);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json']).out);
    expect([2, 3]).toContain(a.lane); // taken from the list, not the scan (which would pick lane 1)
    const other = a.lane === 2 ? 3 : 2;
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).toEqual([other]);
  });

  it('acquire ignores a carried entry older than the max age even inside a freshly written list', () => {
    expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
    // Lane 3 is genuinely free. Fresh `at`: the list wins and hands out lane 3; an `at` an hour old: the entry is
    // skipped, the scan runs and picks its lowest free lane (1). Reddens if nowMs/maxAgeMs stop reaching freeLaneCandidates.
    seedList([{ lane: 3, at: Date.now() }]);
    const viaList = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--session=fresh-caller', '--json']).out);
    expect(viaList.lane).toBe(3);
    seedList([{ lane: 2, at: Date.now() - 3_600_000 }]);
    const viaScan = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--no-reap', '--session=old-caller', '--json']).out);
    expect(viaScan.lane).toBe(1);
  });

  it('trim removes deleted lanes from the published free list and keeps the survivors', () => {
    expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
    seedList([1, 2, 3].map((lane) => ({ lane, at: Date.now() })));
    const r = runPool(['trim', '--max=1', ...poolArgs(), '--json']);
    expect(r.code, r.err).toBe(0);
    const gone = [1, 2, 3].filter((n) => !existsSync(laneDir(n)));
    expect(gone.length).toBeGreaterThan(0); // trim actually deleted lanes
    const listed = readFreeLaneList(listFile()).lanes.map((l) => l.lane);
    for (const n of gone) expect(listed).not.toContain(n);
    for (const n of [1, 2, 3].filter((x) => !gone.includes(x))) expect(listed).toContain(n);
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

describe('touchFreeLaneList staleness', () => {
  it('prunes carried entries older than the max age, so a touch never freshens old candidates', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'touch-')), 'l.json');
    touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane: 3, free: true, now: 0 });
    touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane: 4, free: true, now: 30_000 });
    touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane: 5, free: true, now: 700_000, maxAgeMs: 600_000 });
    expect(readFreeLaneList(f).lanes.map((x) => x.lane)).toEqual([5]);
  });
});

describe('touchFreeLaneList carried-entry expiry', () => {
  it('unrelated touches preserve an entry\'s ORIGINAL timestamp, so it still expires at its original time', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'touch-')), 'l.json');
    const t = (lane, now, extra = {}) => touchFreeLaneList({ path: f, repoName: 'r', poolDir: '/p', lane, free: true, now, maxAgeMs: 600_000, ...extra });
    t(3, 0);
    t(4, 300_000); // unrelated touch: lane 3 must keep at=0
    expect(readFreeLaneList(f).lanes.find((x) => x.lane === 3).at).toBe(0);
    t(5, 700_000); // lane 3 (at 0) is past the limit and pruned; lane 4 (at 300,000) is not
    expect(readFreeLaneList(f).lanes.map((x) => [x.lane, x.at])).toEqual([[4, 300_000], [5, 700_000]]);
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
