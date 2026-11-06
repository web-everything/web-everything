/**
 * @file scripts/__tests__/lane-pool-free-list-event-refresh.test.mjs
 * @description The published free-lane list is refreshed by lane-pool's own acquire/release events, not only by
 *   the periodic health-watch pass (whose gaps of 8-44 min let it go stale and sent `acquire` into the full scan).
 *   Spawns the real CLI against a throwaway pool.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { touchFreeLaneList, readFreeLaneList, isFreeLaneListFresh } from '../lib/free-lane-list.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

// PR #6357 send-back (R547): in CI this file never reported. Its ~30 children each blocked the worker in a
// `spawnSync` for up to 180s, so one stall that occurs only on CI (an idle wait: the other files got FASTER beside it)
// could run for 30 x 180s, outlast the 20-min job cap, and fail no named test. Now each child is bounded at 60s
// (local runs take 1-8s). The FIRST overrun throws with the child's process tree and stderr, and every later child in
// this file is refused at once, so a stall costs this file about one bound in total and names the test that hit it.
const CHILD_BOUND_MS = 60_000;
const PROVISION_BOUND_MS = 120_000; // the template provision clones a lane per count
const OUTPUT_CAP = 1 << 20; // bytes kept per stream; a runaway child cannot grow the worker's heap
const SETTLE_AFTER_EXIT_MS = 2_000; // a descendant still holding the pipes must not keep a finished child "running"
vi.setConfig({ testTimeout: 3 * CHILD_BOUND_MS, hookTimeout: 3 * PROVISION_BOUND_MS });

/** pid, parent pid, elapsed time and args of `rootPid` and every process below it (best-effort; never throws). */
function processTree(rootPid) {
  let rows = '';
  try { rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 << 20 }); } catch (e) { return { pids: [rootPid], text: `(ps failed: ${e.message})` }; }
  const procs = rows.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], args: m[4] }));
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) for (const p of procs) if (p.ppid === pids[i] && !pids.includes(p.pid)) pids.push(p.pid);
  const text = procs.filter((p) => pids.includes(p.pid)).map((p) => `${p.pid} ${p.ppid} ${p.etime} ${p.args.slice(0, 240)}`).join('\n');
  return { pids, text: text || '(no process left)' };
}

/**
 * Run `node <argv>` without blocking the worker. Resolves `{ code, out, err }` on exit; REJECTS once `boundMs`
 * passes, after killing the child and everything below it, with the tree and stderr in the message.
 */
function spawnBounded(argv, { env = process.env, boundMs = CHILD_BOUND_MS, label = argv.join(' ') } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    let exitCode = null;
    let settleTimer = null;
    const keep = (s, d) => (s.length < OUTPUT_CAP ? s + String(d).slice(0, OUTPUT_CAP - s.length) : s);
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(boundTimer); clearTimeout(settleTimer); fn(value); };
    child.stdout.on('data', (d) => { out = keep(out, d); });
    child.stderr.on('data', (d) => { err = keep(err, d); });
    child.on('error', (e) => settle(rejectRun, new Error(`${label}: spawn failed: ${e.message}`)));
    child.on('exit', (code) => {
      exitCode = code ?? 1;
      settleTimer = setTimeout(() => settle(resolveRun, { code: exitCode, out, err: `${err}\n(stdout/stderr still held open by a descendant ${SETTLE_AFTER_EXIT_MS}ms after exit)` }), SETTLE_AFTER_EXIT_MS);
    });
    child.on('close', () => { if (exitCode !== null) settle(resolveRun, { code: exitCode, out, err }); });
    const boundTimer = setTimeout(() => {
      const tree = processTree(child.pid);
      for (const pid of [...tree.pids].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      settle(rejectRun, new Error(`${label} still running after ${boundMs}ms — killed.\nprocess tree at the bound (pid ppid elapsed args):\n${tree.text}\nstderr so far:\n${err.slice(-4000)}`));
    }, boundMs);
  });
}

let firstOverrun = null; // once one child overran, the rest of this file fails fast instead of each waiting out a bound

async function runPool(args, { boundMs = CHILD_BOUND_MS } = {}) {
  if (firstOverrun) throw new Error(`lane-pool ${args[0]} not run: an earlier lane-pool child in this file overran its bound — ${firstOverrun}`);
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_LANE_SALVAGE_DIR: join(base, 'salvage') };
  delete env.LANE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  try {
    return await spawnBounded([SCRIPT, ...args], { env, boundMs, label: `lane-pool ${args[0]}` });
  } catch (e) {
    firstOverrun = String(e.message).split('\n')[0];
    throw e;
  }
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
// The POOL is built once per file too: provisioning (a clone per lane, ~5-8s each) was most of this file's cost
// and, in the integration tier, slowed every file running beside it (PR #6357's integration job ran past its cap).
// `usePool(n)` puts back a pristine n-lane pool at the SAME absolute path it was provisioned at, so every path a
// lane recorded stays valid. Both templates are taken BEFORE the origin/reference snapshot, so `restore()` always
// rolls those back to the exact state the template lanes were cloned from.
let fixtureRoot, sharedFixture;
const poolTemplates = new Map();
beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-free-list-event-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  poolRoot = join(fixtureRoot, 'pool');
  base = fixtureRoot; // runPool's salvage dir while the templates are built

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  for (const count of [1, 3]) {
    const p = await runPool(['provision', `--count=${count}`, ...poolArgs()], { boundMs: PROVISION_BOUND_MS });
    if (p.code !== 0) throw new Error(`template provision --count=${count} failed: ${p.err}`);
    const tpl = join(fixtureRoot, `pool-template-${count}`);
    cpSync(poolRoot, tpl, { recursive: true });
    // No scan/status cache or published list may carry a verdict from template-building into a test.
    const poolDir = join(tpl, 'freepool');
    for (const f of readdirSync(poolDir)) if (/cache|free-lanes/.test(f)) rmSync(join(poolDir, f), { force: true });
    poolTemplates.set(count, tpl);
  }
  rmSync(poolRoot, { recursive: true, force: true });
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
}, 3 * PROVISION_BOUND_MS);

afterAll(() => sharedFixture?.dispose());

function usePool(count) {
  rmSync(poolRoot, { recursive: true, force: true });
  cpSync(poolTemplates.get(count), poolRoot, { recursive: true });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-free-list-event-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=freepool', '--branch=trunk', '--no-install'];

async function acquireOneLane() {
  usePool(1);
  const acquire = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json']);
  expect(acquire.code, acquire.err).toBe(0);
  return JSON.parse(acquire.out); // { lane, path?, holder, ... }
}

function laneDir(lane) {
  return join(poolRoot, 'freepool', `lane-${lane}`);
}

const listFile = () => join(base, 'free.json');
const withList = (args) => runPool(args);

describe('free-lane list is refreshed by lane-pool events', () => {
  beforeEach(() => { process.env.LANE_POOL_FREE_LIST_FILE = listFile(); });
  afterEach(() => { delete process.env.LANE_POOL_FREE_LIST_FILE; });

  it('after a release the list is FRESH and names the lane, with no periodic pass', async () => {
    const { lane } = await acquireOneLane();
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] })); // ancient
    const before = Date.now();
    expect((await withList(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'])).code).toBe(0);
    const list = readFreeLaneList(listFile());
    expect(isFreeLaneListFresh(list, Date.now(), 60_000)).toBe(true);
    expect(list.writtenAt).toBeGreaterThanOrEqual(before);
    expect(list.lanes.map((l) => l.lane)).toContain(lane);
  });

  it('a release of a lane with an unpushed commit does NOT publish it as free', async () => {
    const { lane } = await acquireOneLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'new.txt'), 'x\n'); git(['add', 'new.txt'], dir); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'unpushed'], dir);
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] }));
    expect((await runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'])).code).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // event publication ran
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).not.toContain(lane);
  });

  it('auto-pick --no-reset never hands out a dirty lane that a (stale) list names as free', async () => {
    const { lane } = await acquireOneLane();
    expect((await runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'])).code).toBe(0);
    writeFileSync(join(laneDir(lane), 'file.txt'), 'edited after publication\n'); // dirties a tracked file
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: Date.now(), repo: 'freepool', poolDir: null, lanes: [{ lane, at: Date.now() }] }));
    // `--hard-max=1` caps pool growth: with the only lane dirty and refused, an uncapped acquire would fall through to
    // the scan and then PROVISION a new lane (a full clone — minutes under CI load, which stalled a whole unit shard).
    const r = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(laneDir(lane), 'file.txt'), 'utf8')).toBe('edited after publication\n');
  });

  const seedList = (lanes) => writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: Date.now(), repo: 'freepool', poolDir: null, lanes }));
  const releasedLane = async () => { // a clean, released lane (no lease) — the shape a published free lane has
    const { lane } = await acquireOneLane();
    expect((await runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'])).code).toBe(0);
    return lane;
  };

  it('auto-pick --no-reset still hands out a lane whose only dirt is known scratch litter (not a refusal)', async () => {
    const lane = await releasedLane();
    writeFileSync(join(laneDir(lane), '.pr-body.md'), 'scratch\n'); // allowlisted litter: the scan and release call this clean
    seedList([{ lane, at: Date.now() }]);
    const r = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(lane);
  });

  it('auto-pick --no-reset refuses a lane with an unpushed commit that a fresh list names as free', async () => {
    const lane = await releasedLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'new.txt'), 'x\n'); git(['add', 'new.txt'], dir); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'unpushed-work'], dir);
    seedList([{ lane, at: Date.now() }]);
    const r = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code).not.toBe(0);
    expect(git(['log', '-1', '--format=%s'], dir)).toBe('unpushed-work'); // the work is untouched
  });

  it('auto-pick --no-reset still hands out a lane whose ahead commit was squash-merged and its branch pruned (the scan\'s own bar)', async () => {
    const lane = await releasedLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'feat.txt'), 'feature\n'); git(['add', 'feat.txt'], dir); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'feature'], dir);
    git(['push', '-q', 'origin', 'HEAD:refs/heads/lane/feat'], dir);
    // Squash-merge: the SAME patch lands on trunk as a brand-new commit, then the feature branch is deleted.
    const squash = join(base, 'squash');
    git(['clone', '-q', '--branch', 'trunk', originDir, squash]);
    writeFileSync(join(squash, 'feat.txt'), 'feature\n'); git(['add', 'feat.txt'], squash);
    git(['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '-m', 'feature (squashed)'], squash);
    git(['push', '-q', 'origin', 'HEAD:refs/heads/trunk'], squash);
    git(['update-ref', '-d', 'refs/heads/lane/feat'], originDir);
    git(['fetch', '-q', '--prune', 'origin'], dir); // the lane's commit is now on NO remote-tracking ref
    seedList([{ lane, at: Date.now() }]);
    const r = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(lane);
  });

  it('auto-pick --no-reset refuses a lane whose commit survives only in a STALE tracking ref (branch deleted on origin)', async () => {
    const lane = await releasedLane();
    const dir = laneDir(lane);
    writeFileSync(join(dir, 'wip.txt'), 'wip\n'); git(['add', 'wip.txt'], dir); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'stale-ref-work'], dir);
    git(['push', '-q', 'origin', 'HEAD:refs/heads/lane/gone'], dir);
    git(['update-ref', '-d', 'refs/heads/lane/gone'], originDir); // deleted on origin; the lane's tracking ref lingers
    expect(git(['rev-parse', 'refs/remotes/origin/lane/gone'], dir)).toBe(git(['rev-parse', 'HEAD'], dir));
    seedList([{ lane, at: Date.now() }]);
    const r = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=other', '--hard-max=1', '--json']);
    expect(r.code).not.toBe(0);
    expect(git(['log', '-1', '--format=%s'], dir)).toBe('stale-ref-work'); // the work is untouched
  });

  it('a release of a lane with a dirty tracked file does NOT publish it as free', async () => {
    const { lane } = await acquireOneLane();
    writeFileSync(join(laneDir(lane), 'file.txt'), 'dirty tracked edit\n');
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] }));
    expect((await runPool(['release', `--lane=${lane}`, ...poolArgs(), '--session=owner', '--json'])).code).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // event publication ran
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).not.toContain(lane);
    expect(readFileSync(join(laneDir(lane), 'file.txt'), 'utf8')).toBe('dirty tracked edit\n');
  });

  it('a release of a RESERVED lane does NOT publish it as free', async () => {
    usePool(1);
    expect((await runPool(['acquire', '--lane=1', '--reserve', ...poolArgs(), '--no-reset', '--session=owner', '--json'])).code).toBe(0);
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [] }));
    const r = await runPool(['release', '--lane=1', '--release-reserved', ...poolArgs(), '--session=owner', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // event publication ran
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).not.toContain(1);
  });

  it('acquire removes a FRESH candidate from the list and keeps the other fresh candidate', async () => {
    usePool(3);
    seedList([{ lane: 2, at: Date.now() }, { lane: 3, at: Date.now() }]);
    const a = JSON.parse((await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json'])).out);
    expect([2, 3]).toContain(a.lane); // taken from the list, not the scan (which would pick lane 1)
    const other = a.lane === 2 ? 3 : 2;
    expect(readFreeLaneList(listFile()).lanes.map((l) => l.lane)).toEqual([other]);
  });

  it('acquire ignores a carried entry older than the max age even inside a freshly written list', async () => {
    usePool(3);
    // Lane 3 is genuinely free. Fresh `at`: the list wins and hands out lane 3; an `at` an hour old: the entry is
    // skipped, the scan runs and picks its lowest free lane (1). Reddens if nowMs/maxAgeMs stop reaching freeLaneCandidates.
    seedList([{ lane: 3, at: Date.now() }]);
    const viaList = JSON.parse((await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=fresh-caller', '--json'])).out);
    expect(viaList.lane).toBe(3);
    seedList([{ lane: 2, at: Date.now() - 3_600_000 }]);
    const viaScan = JSON.parse((await runPool(['acquire', ...poolArgs(), '--no-reset', '--no-reap', '--session=old-caller', '--json'])).out);
    expect(viaScan.lane).toBe(1);
  });

  it('trim removes deleted lanes from the published free list and keeps the survivors', async () => {
    usePool(3);
    seedList([1, 2, 3].map((lane) => ({ lane, at: Date.now() })));
    const r = await runPool(['trim', '--max=1', ...poolArgs(), '--json']);
    expect(r.code, r.err).toBe(0);
    const gone = [1, 2, 3].filter((n) => !existsSync(laneDir(n)));
    expect(gone.length).toBeGreaterThan(0); // trim actually deleted lanes
    const listed = readFreeLaneList(listFile()).lanes.map((l) => l.lane);
    for (const n of gone) expect(listed).not.toContain(n);
    for (const n of [1, 2, 3].filter((x) => !gone.includes(x))) expect(listed).toContain(n);
  });

  it('an acquire drops the lane from the list and keeps it fresh', async () => {
    usePool(1);
    writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt: 1, repo: 'freepool', poolDir: null, lanes: [{ lane: 1 }] }));
    const a = JSON.parse((await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', '--json'])).out);
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

// The runner's own bound (PR #6357 send-back R547): a child stall must become one named failure within the bound,
// never a worker blocked until the CI job cap.
describe('spawnBounded — a stalled child fails within its bound', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('rejects at the bound with the process tree, and kills the child and its descendants', async () => {
    // The child starts an idle grandchild (the CI stall shape: waiting, not burning CPU), reports its pid, then idles.
    const src = "const c = require('child_process').spawn('sleep', ['300'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
    const started = Date.now();
    const err = await spawnBounded(['-e', src], { boundMs: 1_500, label: 'stall-probe' }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(err.message).toMatch(/^stall-probe still running after 1500ms — killed\./);
    expect(err.message).toMatch(/sleep 300/); // the tree names the stalled grandchild
    const grandchild = Number((err.message.match(/^(\d+) \d+ \S+ sleep 300/m) || [])[1]);
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(grandchild)).toBe(false);
  });

  it('a child that exits while a descendant still holds its pipes settles shortly after exit, with its output', async () => {
    const src = "require('child_process').spawn('sleep', ['30'], { stdio: 'inherit' }).unref(); console.log('done');";
    const started = Date.now();
    const r = await spawnBounded(['-e', src], { boundMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(0);
    expect(r.out).toContain('done');
    expect(r.err).toMatch(/still held open by a descendant/);
  });

  it('a normal child resolves with its exit code and output', async () => {
    const r = await spawnBounded(['-e', "process.stdout.write('ok'); process.stderr.write('e'); process.exit(3)"], { boundMs: 20_000 });
    expect(r).toEqual({ code: 3, out: 'ok', err: 'e' });
  });
});
