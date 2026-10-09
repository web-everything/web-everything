/**
 * @file scripts/__tests__/lane-pool-hold-rule.test.mjs
 * @description xbdixjc — the lane hold rule wired through the real `lane-pool.mjs` CLI and the lease reaper's
 *   plan. On 2026-10-08 the reaper's `release --force` dropped lanes whose fixer was parked awaiting verify, and
 *   acquire reset a lane over a verified, unpushed commit because ONE already-pushed ahead commit "proved" the
 *   whole stack pushed. Each case here fails on main and passes with the rule; `WE_LANE_HOLD=off` /
 *   `WE_LANE_AHEAD_EQUIVALENCE=any` reproduce the old behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLaneHold } from '../conveyor/lease-reaper.mjs';
import { checkLaneHold } from '../lib/lane-hold-io.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let base, poolRoot, storeDir, originDir, referenceDir, fixtureRoot, sharedFixture;

function runPool(args, extraEnv = {}) {
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot, WE_AWAIT_VERIFY_STORE: storeDir, CLAUDE_CODE_SESSION_ID: 'sess-test', ...extraEnv };
  delete env.LANE_SESSION;
  for (const k of ['WE_LANE_HOLD', 'WE_LANE_HOLD_MINUTES', 'WE_LANE_AHEAD_EQUIVALENCE']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-hold-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-hold-'));
  poolRoot = join(base, 'pool');
  storeDir = join(base, 'await-store');
  mkdirSync(storeDir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=lanehold', '--branch=trunk', '--no-install'];
const laneDir = () => join(poolRoot, 'lanehold', 'lane-1');
const journal = () => {
  const p = join(poolRoot, 'lanehold', '.lane-journal.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** A leased lane-1 with one committed, unpushed fix, as a parked fixer leaves it. */
function parkedFixerLane({ awaitRecord = true, verified = false, requestedAt = new Date().toISOString(), count = 1, session = 'fix-4453' } = {}) {
  expect(runPool(['provision', `--count=${count}`, ...poolArgs()]).code).toBe(0);
  expect(runPool(['acquire', '--lane=1', `--session=${session}`, ...poolArgs()]).code).toBe(0);
  const dir = laneDir();
  git(['config', 'user.email', 't@t.com'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(join(dir, 'file.txt'), 'fix\n');
  git(['commit', '--quiet', '-am', 'fix'], dir);
  const sha = git(['rev-parse', 'HEAD'], dir);
  const now = new Date().toISOString();
  if (awaitRecord) {
    writeFileSync(join(dir, '.git', '.fix-await-verify'), JSON.stringify({ v: 1, who: 'fix-4453', pr: 4453, sha, requestedAt, attempt: 1 }));
  }
  if (verified) {
    writeFileSync(join(dir, '.git', '.lane-verify'), JSON.stringify({ sha, status: 'green', startedAt: now, finishedAt: now, exitCode: 0 }));
  }
  return { dir, sha };
}

describe('release (the reaper path: `release --force`)', () => {
  it('refuses to drop a lane whose fixer is parked awaiting verify, and journals the refusal', () => {
    const { dir } = parkedFixerLane();
    const r = runPool(['release', '--lane=1', '--force', '--reason=session-gone', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).released).toBe(0);
    expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(true);
    const refusal = journal().find((e) => e.action === 'hold-refused');
    expect(refusal).toMatchObject({ hold: 'awaiting-verify' });
    expect(journal().some((e) => e.action === 'release' && e.unpushed === true)).toBe(false);
  });

  it('refuses a verified, unpushed commit with no await record', () => {
    parkedFixerLane({ awaitRecord: false, verified: true });
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(JSON.parse(r.out).released).toBe(0);
    expect(journal().find((e) => e.action === 'hold-refused')).toMatchObject({ hold: 'verified-unpushed' });
  });

  // Live 2026-10-08 21:25–21:40Z: lanes 8, 11, 18 were held as verified-unpushed for every reaper pass although
  // their verified heads were on origin (pushed by the fix daemon to a URL / PR ref, so the lane's own
  // remote-tracking refs never learned of it). The hold must ask the live remote before calling it unpushed.
  it.each([
    ['a branch', 'refs/heads/lane/fix-4453'],
    ['a PR head ref (branch deleted after merge)', 'refs/pull/4453/head'],
  ])('a verified head already on origin as %s is NOT held, even with stale tracking refs', (_label, ref) => {
    const { dir } = parkedFixerLane({ awaitRecord: false, verified: true });
    git(['push', '--quiet', originDir, `HEAD:${ref}`], dir);
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(JSON.parse(r.out).released).toBe(1);
    expect(journal().some((e) => e.action === 'hold-refused')).toBe(false);
  });

  it('a verified head on origin still holds when the lane has real uncommitted edits on top', () => {
    const { dir } = parkedFixerLane({ awaitRecord: false, verified: true });
    git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/fix-4453'], dir);
    writeFileSync(join(dir, 'file.txt'), 'more work\n');
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(JSON.parse(r.out).released).toBe(0);
  });

  it('a shared-store await record bound to the lane holds it too', () => {
    const { dir, sha } = parkedFixerLane({ awaitRecord: false });
    writeFileSync(join(storeDir, 'sess-fixer.json'), JSON.stringify({ v: 1, sessionId: 'sess-fixer', who: 'fix-4453', pr: 4453, sha, lane: dir, ref: 'lane/x', kind: 'fix', requestedAt: new Date().toISOString(), attempt: 1 }));
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(JSON.parse(r.out).released).toBe(0);
  });

  it('the holder still releases its own lane', () => {
    parkedFixerLane();
    const r = runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs(), '--json']);
    expect(JSON.parse(r.out).released).toBe(1);
  });

  it('WE_LANE_HOLD=off restores the old behaviour (the reaper drops it)', () => {
    parkedFixerLane();
    const r = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper', WE_LANE_HOLD: 'off' });
    expect(JSON.parse(r.out).released).toBe(1);
  });
});

describe('acquire', () => {
  it('never takes over a stale lease on a lane whose fixer is parked awaiting verify, even with --force', () => {
    const { dir, sha } = parkedFixerLane();
    const leasePath = join(dir, '.git', '.lane-lease');
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    writeFileSync(leasePath, JSON.stringify({ ...lease, acquiredAt: '2000-01-01T00:00:00.000Z' }));
    const r = runPool(['acquire', '--lane=1', '--force', '--session=review-4484', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'reviewer' });
    expect(r.code).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
  });

  it('never resets an unleased lane over a verified unpushed fix stacked on an already-pushed PR commit', () => {
    // the lane-5 17:56Z shape: the PR's earlier commit is on a remote `lane/*` ref, the new fix commit is not.
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const dir = laneDir();
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, 'pr.txt'), 'pr\n');
    git(['add', 'pr.txt'], dir);
    git(['commit', '--quiet', '-m', 'pr commit'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/pr-branch'], dir);
    writeFileSync(join(dir, 'file.txt'), 'fix\n');
    git(['commit', '--quiet', '-am', 'fix commit (verified, not pushed)'], dir);
    const sha = git(['rev-parse', 'HEAD'], dir);
    const r = runPool(['acquire', '--lane=1', '--session=smoke', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'smoke' });
    expect(r.code).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
    // The old 'any' rule hands the same lane out and resets it — the bug this guards.
    const old = runPool(['acquire', '--lane=1', '--session=smoke', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'smoke', WE_LANE_AHEAD_EQUIVALENCE: 'any' });
    expect(old.code).toBe(0);
    expect(git(['rev-parse', 'HEAD'], dir)).not.toBe(sha);
  });
});

/** The lease vanished under a still-parked fixer (an old reaper, a manual `rm`): the await record outlives it. */
const dropLease = (dir) => rmSync(join(dir, '.git', '.lane-lease'), { force: true });

describe('trim and reclaim', () => {
  it('trim never removes a lane whose fixer is parked awaiting verify, even when its work is pushed', () => {
    const { dir } = parkedFixerLane();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/fix-4453'], dir);
    dropLease(dir);
    runPool(['trim', '--max=0', ...poolArgs(), '--json']);
    expect(existsSync(dir)).toBe(true);
  });

  it('trim control: the same lane IS removed with the hold off (so the test above defends the guard)', () => {
    const { dir } = parkedFixerLane();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/fix-4453'], dir);
    dropLease(dir);
    runPool(['trim', '--max=0', ...poolArgs(), '--json'], { WE_LANE_HOLD: 'off' });
    expect(existsSync(dir)).toBe(false);
  });

  it('reclaim --override refuses a lane whose fixer is parked awaiting verify', () => {
    const { dir, sha } = parkedFixerLane();
    dropLease(dir);
    const r = runPool(['reclaim', '--lane=1', '--override', ...poolArgs(), '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ reclaimed: false, hold: 'awaiting-verify' });
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
  });
});

describe('lease reaper plan', () => {
  it('moves a held lane from reap to keep with a held:<hold> reason', () => {
    const plan = { reap: [{ pool: 'p', lane: 1, dir: '/a', reason: 'session-gone', lease: {} }, { pool: 'p', lane: 2, dir: '/b', reason: 'pr-merged', lease: {} }], keep: [] };
    const check = (dir) => (dir === '/a' ? { allowed: false, hold: 'awaiting-verify', reason: 'lane-hold: parked' } : { allowed: true, hold: null });
    const out = applyLaneHold(plan, { nowMs: 0, check });
    expect(out.reap.map((c) => c.lane)).toEqual([2]);
    expect(out.keep).toEqual([expect.objectContaining({ lane: 1, reason: 'held:awaiting-verify', wouldHaveBeen: 'session-gone' })]);
  });
  it('fails closed when the check throws nothing useful', () => {
    const out = applyLaneHold({ reap: [{ lane: 1, dir: '/a', reason: 'ttl-stale' }], keep: [] }, { nowMs: 0, check: () => null });
    expect(out.reap).toEqual([]);
  });
  it('the real check reads a live lane: parked fixer → held', () => {
    const { dir } = parkedFixerLane();
    expect(checkLaneHold(dir, { action: 'release', storeDir, env: {} })).toMatchObject({ allowed: false, hold: 'awaiting-verify' });
  });
});

// ── PR #4508 review round: each case below fails on the head the reviewers saw ───────────────────────────────
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const fakeGh = (prs) => {
  const binDir = join(base, 'ghbin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`, { mode: 0o755 });
  return { PATH: `${binDir}:${process.env.PATH}` };
};

describe('who counts as the holder (a release by anyone else is refused)', () => {
  it('a targeted release that matches only the lease ownerSession (a sibling of the same session) is refused', () => {
    const { dir } = parkedFixerLane();
    // no --session: the caller is "sess-test", the session that ACQUIRED lane-1 — exactly an orchestrator whose
    // fixer subagent shares its CLAUDE_CODE_SESSION_ID. That proves "same session", never "this lane's holder".
    const r = runPool(['release', '--lane=1', ...poolArgs(), '--json']);
    expect(JSON.parse(r.out).released).toBe(0);
    expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(true);
    expect(journal().find((e) => e.action === 'hold-refused')).toMatchObject({ hold: 'awaiting-verify' });
  });

  it('the minted holder slug proves the holder too', () => {
    parkedFixerLane();
    const holder = JSON.parse(readFileSync(join(laneDir(), '.git', '.lane-lease'), 'utf8')).holder;
    expect(holder).toBeTruthy();
    const r = runPool(['release', '--lane=1', `--session=${holder}`, ...poolArgs(), '--json']);
    expect(JSON.parse(r.out).released).toBe(1);
  });
});

describe("a holder's release ends its own hold", () => {
  it('releasing clears the lane-local and shared-store await records, so the lane can be acquired at once', () => {
    const { dir, sha } = parkedFixerLane();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/fix-4453'], dir); // its work is on origin: only the hold could stop a reset
    writeFileSync(join(storeDir, 'sess-fixer.json'), JSON.stringify({ v: 1, sessionId: 'sess-fixer', who: 'fix-4453', pr: 4453, sha, lane: dir, ref: 'lane/x', kind: 'fix', requestedAt: new Date().toISOString(), attempt: 1 }));
    writeFileSync(join(storeDir, 'sess-other.json'), JSON.stringify({ v: 1, sessionId: 'sess-other', who: 'fix-9999', pr: 9999, sha, lane: join(base, 'elsewhere'), ref: 'lane/y', kind: 'fix', requestedAt: new Date().toISOString(), attempt: 1 }));
    expect(JSON.parse(runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs(), '--json']).out).released).toBe(1);
    expect(existsSync(join(dir, '.git', '.fix-await-verify'))).toBe(false);
    expect(existsSync(join(storeDir, 'sess-fixer.json'))).toBe(false);
    expect(existsSync(join(storeDir, 'sess-other.json'))).toBe(true); // another lane's record is never touched
    const again = runPool(['acquire', '--lane=1', '--session=next-holder', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'next' });
    expect(again.code).toBe(0);
  });

  it('keeps the records while the lane still holds unpushed work (the await-verify pass pushes from them)', () => {
    const { dir } = parkedFixerLane();
    expect(JSON.parse(runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs(), '--json']).out).released).toBe(1);
    expect(existsSync(join(dir, '.git', '.fix-await-verify'))).toBe(true);
  });

  it('clears only the records the releasing holder wrote, never another fixer\'s on the same lane', () => {
    const { dir, sha } = parkedFixerLane();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/fix-4453'], dir);
    writeFileSync(join(storeDir, 'sess-newer.json'), JSON.stringify({ v: 1, sessionId: 'sess-newer', who: 'fix-7777', pr: 7777, sha, lane: dir, ref: 'lane/z', kind: 'fix', requestedAt: new Date().toISOString(), attempt: 1 }));
    runPool(['release', '--lane=1', '--session=fix-4453', ...poolArgs(), '--json']);
    expect(existsSync(join(dir, '.git', '.fix-await-verify'))).toBe(false);
    expect(existsSync(join(storeDir, 'sess-newer.json'))).toBe(true);
  });

  it('a release the hold refuses leaves the records alone', () => {
    const { dir } = parkedFixerLane();
    runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(existsSync(join(dir, '.git', '.fix-await-verify'))).toBe(true);
  });
});

describe('every guard has a test that reddens without it', () => {
  it('refresh --force never resets a lane the hold protects (and does with the hold off)', () => {
    const { dir, sha } = parkedFixerLane();
    dropLease(dir);
    runPool(['refresh', '--force', ...poolArgs()]);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
    runPool(['refresh', '--force', ...poolArgs()], { WE_LANE_HOLD: 'off' });
    expect(git(['rev-parse', 'HEAD'], dir)).not.toBe(sha);
  });

  it('the acquire-time reaper keeps a merged-PR ghost whose fixer is parked (and reaps it with the hold off)', () => {
    const { dir } = parkedFixerLane({ count: 2, session: 'conveyor-4453' });
    // the reaper only collects a lane that looks delivered (clean tree, head contained in origin's trunk)
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], dir);
    git(['fetch', '--quiet', 'origin'], dir);
    const lease = JSON.parse(readFileSync(join(dir, '.git', '.lane-lease'), 'utf8'));
    writeFileSync(join(dir, '.git', '.lane-lease'), JSON.stringify({ ...lease, acquiredAt: minutesAgo(24 * 60) }));
    const env = { ...fakeGh([{ headRefName: 'lane/4453-some-slug', state: 'MERGED', mergedAt: '2026-08-01T00:00:00Z' }]), CLAUDE_CODE_SESSION_ID: 'fresh' };
    const held = runPool(['acquire', '--lane=2', '--session=fresh', '--no-reset', ...poolArgs()], env);
    expect(held.code).toBe(0);
    expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(true);
    runPool(['release', '--lane=2', '--session=fresh', ...poolArgs()], env);
    const off = runPool(['acquire', '--lane=2', '--session=fresh2', '--no-reset', ...poolArgs()], { ...env, WE_LANE_HOLD: 'off' });
    expect(off.err).toMatch(/reaped lane-1 before acquire \(pr-merged/);
    expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
  });

  it('WE_LANE_HOLD_MINUTES moves the expiry through the CLI', () => {
    parkedFixerLane({ requestedAt: minutesAgo(200) });
    const released = (env) => JSON.parse(runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper', ...env }).out).released;
    expect(released({ WE_LANE_HOLD_MINUTES: '300' })).toBe(0); // 200 min old, window 300 → still held
    expect(released({})).toBe(1); // default window 150 → expired, salvage may take it
  });

  it('a refusal is journalled once while the state is unchanged', () => {
    parkedFixerLane();
    for (let i = 0; i < 3; i++) runPool(['release', '--lane=1', '--force', ...poolArgs(), '--json'], { CLAUDE_CODE_SESSION_ID: 'reaper' });
    expect(journal().filter((e) => e.action === 'hold-refused')).toHaveLength(1);
  });
});

describe('checkLaneHold fails closed on malformed or unreadable facts', () => {
  const verifyPath = (dir) => join(dir, '.git', '.lane-verify');
  const check = (dir, extra = {}) => checkLaneHold(dir, { action: 'release', storeDir, env: {}, remoteHas: () => false, ...extra });

  it.each([
    ['running, no startedAt', { status: 'running' }, 'verifying'],
    ['running, garbage startedAt', { status: 'running', startedAt: 'not-a-date' }, 'verifying'],
    ['running, far-future startedAt', { status: 'running', startedAt: '2999-01-01T00:00:00Z' }, 'verifying'],
    ['green at head, no timestamps', { status: 'green' }, 'verified-unpushed'],
    ['green at head, garbage finishedAt', { status: 'green', finishedAt: 'x', startedAt: 'y' }, 'verified-unpushed'],
    ['a status nobody wrote', { status: 'queued' }, 'verify-unreadable'],
  ])('%s keeps protection (marker mtime stands in for the missing time)', (_label, body, hold) => {
    const { dir, sha } = parkedFixerLane({ awaitRecord: false });
    writeFileSync(verifyPath(dir), JSON.stringify({ sha, exitCode: 0, ...body }));
    expect(check(dir)).toMatchObject({ allowed: false, hold });
  });

  it('an old marker with no timestamp does not hold forever (mtime ages out)', () => {
    const { dir, sha } = parkedFixerLane({ awaitRecord: false });
    writeFileSync(verifyPath(dir), JSON.stringify({ sha, status: 'running' }));
    const old = new Date(Date.now() - 24 * 3_600_000);
    utimesSync(verifyPath(dir), old, old);
    expect(check(dir)).toMatchObject({ allowed: true });
  });

  it.each([
    ['no requestedAt', {}],
    ['garbage requestedAt', { requestedAt: 'not-a-date' }],
    ['far-future requestedAt', { requestedAt: '2999-01-01T00:00:00Z' }],
  ])('an await record with %s still holds (record mtime stands in)', (_label, over) => {
    const { dir, sha } = parkedFixerLane({ awaitRecord: false });
    writeFileSync(join(dir, '.git', '.fix-await-verify'), JSON.stringify({ v: 1, who: 'fix-4453', pr: 4453, sha, attempt: 1, ...over }));
    expect(check(dir)).toMatchObject({ allowed: false, hold: 'awaiting-verify' });
  });

  it('an await file that is there but unparseable still holds (record mtime stands in)', () => {
    const { dir } = parkedFixerLane({ awaitRecord: false });
    writeFileSync(join(dir, '.git', '.fix-await-verify'), '{"v":1,"who":"fix-44');
    expect(check(dir)).toMatchObject({ allowed: false, hold: 'awaiting-verify' });
  });

  it('a facts read that throws never stops the holder releasing its own lane, and still stops everyone else', () => {
    const { dir } = parkedFixerLane();
    const boom = () => { throw new Error('EIO'); };
    expect(check(dir, { byHolder: true, awaitFacts: boom })).toMatchObject({ allowed: true });
    expect(check(dir, { byHolder: false, awaitFacts: boom })).toMatchObject({ allowed: false, hold: 'work-state-unknown' });
    expect(check(dir, { byHolder: true, action: 'reset', awaitFacts: boom })).toMatchObject({ allowed: false, hold: 'work-state-unknown' });
  });
});
