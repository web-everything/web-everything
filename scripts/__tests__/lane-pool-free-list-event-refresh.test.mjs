/**
 * @file scripts/__tests__/lane-pool-free-list-event-refresh.test.mjs
 * @description The published free-lane list is refreshed by lane-pool's own acquire/release/trim events, not only
 *   by the periodic health-watch pass (whose gaps of 8-44 min let it go stale and sent `acquire` into the full scan).
 *   Spawns the real CLI against a throwaway pool — but only for the end-to-end wiring: 10 lane-pool children in all
 *   (one provision, then acquire/release/trim). The list logic itself (`touchFreeLaneList`, per-entry age, the
 *   release publication bar on real git states) is tested in-process in `scripts/lib/__tests__/free-lane-list.test.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFreeLaneList, isFreeLaneListFresh } from '../lib/free-lane-list.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

// The test's own git calls are synchronous (they block the worker), so each is bounded too: a hung one throws and
// fails the test that made it instead of stalling the worker past every vitest timeout. All are local-only.
const GIT_BOUND_MS = 30_000;
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_BOUND_MS, killSignal: 'SIGKILL' }).trim();
}

let base, originDir, referenceDir, poolRoot;

// PR #6357 send-back (R547): this file once ran ~30 lane-pool children (a fresh pool copy and acquire/release round
// trip for most tests) and pushed the integration job past its 20-min cap. It now runs 10: ONE provision in
// `beforeAll`, copied back per test, and only the CLI wiring cases below. Each child is still bounded (local runs take
// 1-8s): the FIRST overrun throws with the child's process tree and stderr, and every later child in this file is
// refused at once, so a CI-only stall costs about one bound in total and names the test that hit it. The whole file
// also has a budget; running out of it latches the same fail-fast.
const CHILD_BOUND_MS = 60_000;
const PROVISION_BOUND_MS = 120_000; // the one template provision clones POOL_SIZE lanes
// All lane-pool children of this file together. Idle host: ~20s; a loaded host: a few times that.
const FILE_BUDGET_MS = 5 * 60_000;
const OUTPUT_CAP = 1 << 20; // bytes kept per stream; a runaway child cannot grow the worker's heap
const SETTLE_AFTER_EXIT_MS = 2_000; // a descendant still holding the pipes must not keep a finished child "running"
// Slack over the children's bounds for the sync git calls (each bounded at GIT_BOUND_MS) and `ps` in a test.
vi.setConfig({ testTimeout: 5 * CHILD_BOUND_MS + 60_000, hookTimeout: PROVISION_BOUND_MS + 120_000 });

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

/** SIGKILL the child's whole process group (it is spawned as a group leader), so descendants that outlive it die too. */
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
}

/**
 * Run `node <argv>` without blocking the worker, as its own process group. Resolves `{ code, signal, out, err }` on
 * exit (then kills any descendant still in the group); REJECTS once `boundMs` passes, after killing the group and
 * every process below the child, with the tree and stderr in the message.
 */
function spawnBounded(argv, { env = process.env, boundMs = CHILD_BOUND_MS, label = argv.join(' ') } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', argv, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let settled = false;
    let exited = null; // { code, signal } once the child itself has exited
    let settleTimer = null;
    const keep = (s, d) => (s.length < OUTPUT_CAP ? s + String(d).slice(0, OUTPUT_CAP - s.length) : s);
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(boundTimer); clearTimeout(settleTimer); fn(value); };
    const resolveExited = (note = '') => { killGroup(child.pid); settle(resolveRun, { code: exited.code ?? 1, signal: exited.signal ?? null, out, err: err + note }); };
    child.stdout.on('data', (d) => { out = keep(out, d); });
    child.stderr.on('data', (d) => { err = keep(err, d); });
    child.on('error', (e) => settle(rejectRun, new Error(`${label}: spawn failed: ${e.message}`)));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      settleTimer = setTimeout(() => resolveExited(`\n(stdout/stderr still held open by a descendant ${SETTLE_AFTER_EXIT_MS}ms after exit)`), SETTLE_AFTER_EXIT_MS);
    });
    child.on('close', () => { if (exited) resolveExited(); });
    const boundTimer = setTimeout(() => {
      if (exited) return resolveExited(`\n(stdout/stderr still held open by a descendant at the ${boundMs}ms bound)`);
      const tree = processTree(child.pid);
      killGroup(child.pid);
      for (const pid of [...tree.pids].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      settle(rejectRun, new Error(`${label} still running after ${boundMs}ms — killed.\nprocess tree at the bound (pid ppid elapsed args):\n${tree.text}\nstderr so far:\n${err.slice(-4000)}`));
    }, boundMs);
  });
}

/** A child's bound under the file budget: its own bound, cut to what is left of the budget; `null` once none is left. */
function budgetedBound({ boundMs, startedAt, now, budgetMs = FILE_BUDGET_MS }) {
  const left = budgetMs - (now - startedAt);
  return left <= 0 ? null : Math.min(boundMs, left);
}

let fileStartedAt = null; // set by the first lane-pool child of this file
let firstOverrun = null; // once one child overran (or the file budget ran out), the rest of the file fails fast
let poolChildren = 0; // every lane-pool child this file spawned (pinned by the last CLI test)

async function runPool(args, { boundMs = CHILD_BOUND_MS } = {}) {
  if (firstOverrun) throw new Error(`lane-pool ${args[0]} not run: an earlier lane-pool child in this file overran its bound — ${firstOverrun}`);
  fileStartedAt ??= Date.now();
  const bound = budgetedBound({ boundMs, startedAt: fileStartedAt, now: Date.now() });
  if (bound === null) {
    firstOverrun = `this file's lane-pool children used up its ${FILE_BUDGET_MS}ms budget`;
    throw new Error(`lane-pool ${args[0]} not run: ${firstOverrun}`);
  }
  const env = withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, WE_LANE_SALVAGE_DIR: join(base, 'salvage') });
  delete env.LANE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  const label = `lane-pool ${args[0]}${bound < boundMs ? ` (bound cut to the ${bound}ms left of this file's ${FILE_BUDGET_MS}ms budget)` : ''}`;
  poolChildren++;
  let r;
  try {
    r = await spawnBounded([SCRIPT, ...args], { env, boundMs: bound, label });
  } catch (e) {
    firstOverrun = String(e.message).split('\n')[0];
    throw e;
  }
  // A child killed by a signal (e.g. out of memory) is not a refusal: never let it pass an `expect(code).not.toBe(0)`.
  if (r.signal) throw new Error(`lane-pool ${args[0]} was killed by ${r.signal}\n${r.err.slice(-4000)}`);
  return r;
}

// One origin + reference + POOL per FILE. The pool is provisioned ONCE (a clone per lane was most of this file's
// cost) and `usePool()` puts a pristine copy back at the SAME absolute path, so every path a lane recorded stays
// valid. The template is taken BEFORE the origin/reference snapshot, so `restore()` always rolls those back to the
// exact state the template lanes were cloned from.
const POOL_SIZE = 5;
let fixtureRoot, sharedFixture, poolTemplate;
beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-free-list-event-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  poolRoot = join(fixtureRoot, 'pool');
  base = fixtureRoot; // runPool's salvage dir while the template is built

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  const p = await runPool(['provision', `--count=${POOL_SIZE}`, ...poolArgs()], { boundMs: PROVISION_BOUND_MS });
  if (p.code !== 0) throw new Error(`template provision --count=${POOL_SIZE} failed: ${p.err}`);
  poolTemplate = join(fixtureRoot, 'pool-template');
  cpSync(poolRoot, poolTemplate, { recursive: true });
  // No scan/status cache or published list may carry a verdict from template-building into a test.
  const poolDir = join(poolTemplate, 'freepool');
  for (const f of readdirSync(poolDir)) if (/cache|memo|free-lanes/.test(f)) rmSync(join(poolDir, f), { force: true });
  rmSync(poolRoot, { recursive: true, force: true });
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
}, PROVISION_BOUND_MS + 60_000);

afterAll(() => sharedFixture?.dispose());

function usePool() {
  rmSync(poolRoot, { recursive: true, force: true });
  cpSync(poolTemplate, poolRoot, { recursive: true });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-free-list-event-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture?.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=freepool', '--branch=trunk', '--no-install'];
const laneDir = (lane) => join(poolRoot, 'freepool', `lane-${lane}`);
const listFile = () => join(base, 'free.json');
const listed = () => readFreeLaneList(listFile()).lanes.map((l) => l.lane);
const seedList = (lanes, writtenAt = Date.now()) => writeFileSync(listFile(), JSON.stringify({ v: 1, writtenAt, repo: 'freepool', poolDir: null, lanes }));
const commitIn = (dir, file, msg) => {
  writeFileSync(join(dir, file), `${msg}\n`);
  git(['add', file], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg], dir);
};

describe('free-lane list is refreshed by lane-pool events (real CLI, one pool provisioned per file)', () => {
  beforeEach(() => { process.env.LANE_POOL_FREE_LIST_FILE = listFile(); });
  afterEach(() => { delete process.env.LANE_POOL_FREE_LIST_FILE; });

  it('auto-pick --no-reset hands out only a lane proven clean and pushed; release then publishes only an in-sync lane', async () => {
    usePool();
    // One lane per git state, all named as free by a fresh list. Lane 5 first: its squash-merge moves trunk.
    // 5: its ahead commit was squash-merged onto trunk and its branch pruned — the scan's own bar calls it pushed.
    const squashed = laneDir(5);
    commitIn(squashed, 'feat.txt', 'feature');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/lane/feat'], squashed);
    const squash = join(base, 'squash');
    git(['clone', '-q', '--branch', 'trunk', originDir, squash]);
    writeFileSync(join(squash, 'feat.txt'), 'feature\n');
    git(['add', 'feat.txt'], squash);
    git(['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '-m', 'feature (squashed)'], squash);
    git(['push', '-q', 'origin', 'HEAD:refs/heads/trunk'], squash);
    git(['update-ref', '-d', 'refs/heads/lane/feat'], originDir);
    git(['fetch', '-q', '--prune', 'origin'], squashed); // the lane's commit is now on NO remote-tracking ref
    // 1: a dirty tracked file.
    writeFileSync(join(laneDir(1), 'file.txt'), 'edited after publication\n');
    // 2: an unpushed commit.
    commitIn(laneDir(2), 'new.txt', 'unpushed-work');
    // 3: a commit that survives only in a STALE tracking ref (its branch was deleted on origin).
    commitIn(laneDir(3), 'wip.txt', 'stale-ref-work');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/lane/gone'], laneDir(3));
    git(['update-ref', '-d', 'refs/heads/lane/gone'], originDir);
    expect(git(['rev-parse', 'refs/remotes/origin/lane/gone'], laneDir(3))).toBe(git(['rev-parse', 'HEAD'], laneDir(3)));
    // 4: only known scratch litter — the scan and release call this clean.
    writeFileSync(join(laneDir(4), '.pr-body.md'), 'scratch\n');
    seedList([1, 2, 3, 4, 5].map((lane) => ({ lane, at: Date.now() })));

    // `--hard-max` caps pool growth: with every listed lane refused, an uncapped acquire would fall through to the
    // scan and then PROVISION a new lane (a full clone — minutes under CI load).
    const acquire = (session) => runPool(['acquire', ...poolArgs(), '--no-reset', `--session=${session}`, `--hard-max=${POOL_SIZE}`, '--json']);
    const first = await acquire('first');
    expect(first.code, first.err).toBe(0);
    expect(JSON.parse(first.out).lane).toBe(4); // lanes 1-3 refused by the guard, litter-only lane 4 handed out
    for (const n of [1, 2, 3]) expect(first.err).toMatch(new RegExp(`lane-${n} is not provably clean and pushed`));
    expect(listed()).not.toContain(4); // the acquire event removed it
    const second = await acquire('second');
    expect(second.code, second.err).toBe(0);
    expect(JSON.parse(second.out).lane).toBe(5); // squash-merged + pruned counts as pushed
    const third = await acquire('third');
    expect(third.code).not.toBe(0); // only the dirty / unpushed / stale-ref lanes are left
    for (const n of [1, 2, 3]) expect(third.err).toMatch(new RegExp(`lane-${n} is not provably clean and pushed`));
    // The refused lanes' work is untouched.
    expect(readFileSync(join(laneDir(1), 'file.txt'), 'utf8')).toBe('edited after publication\n');
    expect(git(['log', '-1', '--format=%s'], laneDir(2))).toBe('unpushed-work');
    expect(git(['log', '-1', '--format=%s'], laneDir(3))).toBe('stale-ref-work');

    // Release: an ancient list becomes fresh. Lane 4 (litter-only, level with its origin) is published as free; lane 5
    // (its commit is ahead of trunk and on no remote ref) is not, although the --no-reset guard above handed it out.
    seedList([], 1);
    const before = Date.now();
    const r4 = await runPool(['release', '--lane=4', ...poolArgs(), '--session=first', '--json']);
    expect(r4.code, r4.err).toBe(0);
    const r5 = await runPool(['release', '--lane=5', ...poolArgs(), '--session=second', '--json']);
    expect(r5.code, r5.err).toBe(0);
    const list = readFreeLaneList(listFile());
    expect(isFreeLaneListFresh(list, Date.now(), 60_000)).toBe(true);
    expect(list.writtenAt).toBeGreaterThanOrEqual(before);
    expect(listed()).toEqual([4]);
  });

  it('acquire takes a fresh list candidate, removes it, skips an entry past the max age and keeps the other', async () => {
    usePool();
    // Every lane is genuinely free; the scan would pick lane 1. Lane 2's entry is an hour old: skipped (and pruned on
    // the next touch). Reddens if nowMs/maxAgeMs stop reaching freeLaneCandidates or the acquire stops touching the list.
    // The list itself is fresh (so acquire reads it); `writtenAt` is in the past so the touch must move it forward.
    const now = Date.now();
    seedList([{ lane: 2, at: now - 3_600_000 }, { lane: 3, at: now }, { lane: 4, at: now }], now - 30_000);
    const r = await runPool(['acquire', ...poolArgs(), '--no-reset', '--session=owner', `--hard-max=${POOL_SIZE}`, '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(3);
    expect(readFreeLaneList(listFile()).writtenAt).toBeGreaterThanOrEqual(now);
    expect(listed()).toEqual([4]);
  });

  it('a release of a RESERVED lane does NOT publish it as free (even a clean one), but still stamps the list fresh', async () => {
    usePool();
    const a = await runPool(['acquire', '--lane=1', '--reserve', ...poolArgs(), '--no-reset', '--session=owner', `--hard-max=${POOL_SIZE}`, '--json']);
    expect(a.code, a.err).toBe(0);
    seedList([], 1); // ancient
    const r = await runPool(['release', '--lane=1', '--release-reserved', ...poolArgs(), '--session=owner', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(isFreeLaneListFresh(readFreeLaneList(listFile()), Date.now(), 60_000)).toBe(true); // the release event ran
    expect(listed()).not.toContain(1);
  });

  it('trim removes deleted lanes from the published free list and keeps the survivors', async () => {
    usePool();
    const all = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
    seedList(all.map((lane) => ({ lane, at: Date.now() })));
    const r = await runPool(['trim', '--max=1', ...poolArgs(), '--json']);
    expect(r.code, r.err).toBe(0);
    const gone = all.filter((n) => !existsSync(laneDir(n)));
    expect(gone.length).toBeGreaterThan(0); // trim actually deleted lanes
    expect(listed()).toEqual(all.filter((n) => !gone.includes(n)));
  });

  it('the whole file spawned at most 10 lane-pool children (PR #6357 send-back: the integration job cap)', () => {
    expect(poolChildren).toBeGreaterThan(0);
    expect(poolChildren).toBeLessThanOrEqual(10);
  });
});

// The runner's own bound (PR #6357 send-back R547): a child stall must become one named failure within the bound,
// never a worker blocked until the CI job cap.
describe('spawnBounded — a stalled child fails within its bound', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const ps = (pid) => { try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { return ''; } };
  // Gone, or a zombie waiting to be reaped (`kill(pid, 0)` still succeeds on a zombie). Polled: the reaper may lag.
  const waitGone = async (pid, deadlineMs = 10_000) => {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) { if (!alive(pid) || ps(pid).startsWith('Z')) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  };
  const pidFromTree = (message, args) => Number((message.match(new RegExp(`^(\\d+) \\d+ \\S+ ${args}`, 'm')) || [])[1]);

  it('rejects at the bound with the process tree, and kills the child and its descendants', async () => {
    // The child starts an idle grandchild (the CI stall shape: waiting, not burning CPU), then idles. The bound leaves
    // a loaded host seconds to start node and the grandchild before it fires.
    const src = "require('child_process').spawn('sleep', ['300'], { stdio: 'ignore' }); setInterval(() => {}, 1000);";
    const started = Date.now();
    const err = await spawnBounded(['-e', src], { boundMs: 6_000, label: 'stall-probe' }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(err.message).toMatch(/^stall-probe still running after 6000ms — killed\./);
    const grandchild = pidFromTree(err.message, 'sleep 300'); // the tree names the stalled grandchild
    expect(grandchild, err.message).toBeGreaterThan(0);
    expect(await waitGone(grandchild)).toBe(true);
  });

  it('a child that exits while a descendant still holds its pipes settles shortly after exit, and the descendant is killed', async () => {
    const src = "const c = require('child_process').spawn('sleep', ['31'], { stdio: 'inherit' }); c.unref(); console.log('grandchild=' + c.pid);";
    const started = Date.now();
    const r = await spawnBounded(['-e', src], { boundMs: 25_000 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/still held open by a descendant/);
    const grandchild = Number((r.out.match(/grandchild=(\d+)/) || [])[1]);
    expect(grandchild, r.out).toBeGreaterThan(0);
    expect(await waitGone(grandchild)).toBe(true); // the process-group kill reached it after the child had exited
  });

  it('a normal child resolves with its exit code and output', async () => {
    const r = await spawnBounded(['-e', "process.stdout.write('ok'); process.stderr.write('E-MARK'); process.exit(3)"], { boundMs: 25_000 });
    expect(r.code).toBe(3);
    expect(r.signal).toBeNull();
    expect(r.out).toBe('ok');
    expect(r.err).toContain('E-MARK');
  });

  it('a child killed by a signal reports the signal, so runPool can refuse to treat it as a refusal', async () => {
    const r = await spawnBounded(['-e', "process.kill(process.pid, 'SIGKILL')"], { boundMs: 25_000 });
    expect(r.signal).toBe('SIGKILL');
  });

  it('the file budget cuts a child\'s bound to what is left, and leaves none once it is spent', () => {
    expect(budgetedBound({ boundMs: 60_000, startedAt: 0, now: 10_000, budgetMs: 360_000 })).toBe(60_000);
    expect(budgetedBound({ boundMs: 60_000, startedAt: 0, now: 330_000, budgetMs: 360_000 })).toBe(30_000);
    expect(budgetedBound({ boundMs: 60_000, startedAt: 0, now: 360_000, budgetMs: 360_000 })).toBeNull();
    expect(budgetedBound({ boundMs: 60_000, startedAt: 0, now: 400_000, budgetMs: 360_000 })).toBeNull();
    expect(FILE_BUDGET_MS).toBeLessThan(20 * 60_000 / 2); // well under the integration job's 20-min cap
  });
});
