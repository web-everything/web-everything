/**
 * @file scripts/__tests__/lane-pool-lifecycle-journal.test.mjs
 * @description #4370 — the per-pool lane lifecycle audit journal, driven through the REAL call paths: a real
 *   `lane-pool.mjs acquire`, the lease-reaper's own `releaseLane` (the exact child it spawns in production, with
 *   its actor env and reap reason), and the health watch's own `defaultReclaimLane` (same). Asserts the three
 *   journal lines carry actor name + pid, reason, HEAD before→after and dirty/ahead counts; that
 *   `lane-whois --history` prints that timeline; that a reclaim over unpushed work is REFUSED and journalled
 *   loud; and that an operator override that destroys unpushed work fires the `lane-destructive-unpushed`
 *   smell. Real throwaway origin + reference checkout, private `LANE_POOL_ROOT`, fake `claude`/`lsof` on PATH
 *   (same fixture shape as `lane-pool-reclaim.test.mjs`).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import { readLaneJournal, isUnsalvagedDestructiveUnpushed } from '../lib/lane-history.mjs';
import { releaseLane, LEASE_REAPER_ACTOR } from '../conveyor/lease-reaper.mjs';
import { defaultReclaimLane, HEALTH_WATCH_ACTOR } from '../conveyor/lane-pool-health-watch.mjs';
import { probeLaneJournal } from '../conveyor/health-watch.mjs';
import destructiveSmell from '../conveyor/health-smells/lane-destructive-unpushed.mjs';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const WHOIS_SCRIPT = resolve(process.cwd(), 'scripts/lane-whois.mjs');
const POOL = 'journalpool';

let base, originDir, referenceDir, poolRoot, binDir, env;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd, msg) => git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-am', msg], cwd);
const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=${POOL}`, '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, POOL, `lane-${n}`);

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env: { ...env, ...extraEnv }, timeout: 30_000, killSignal: 'SIGKILL' });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** The reaper's real `releaseLane`, pointed at this fixture pool. */
const reaperRelease = (lane, reason) => releaseLane(POOL, lane, { reason, env, cli: POOL_SCRIPT });

/** The health watch's real `defaultReclaimLane`; the exec wrapper only adds this fixture's pool args + env
 *  (keeping the actor env the watch itself set). */
const watchReclaim = (lane) => defaultReclaimLane({
  lane, root: process.cwd(),
  exec: (cmd, argv, opts) => execFileSync(cmd, [...argv, ...poolArgs()], { ...opts, cwd: referenceDir, env: { ...opts.env, ...env } }),
});

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-journal-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  commit(referenceDir, 'v1');
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-journal-'));
  poolRoot = join(base, 'pool');
  binDir = join(base, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(binDir, 'claude'), 0o755);
  writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'lsof'), 0o755);
  env = { ...process.env, LANE_POOL_ROOT: poolRoot, HOME: base, PATH: `${binDir}:${process.env.PATH}`, WE_LANE_SALVAGE_QUIET_MIN: '0' };
  delete env.LANE_JOURNAL_ACTOR;

  expect(runPool(['provision', '--count=2', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane lifecycle journal — acquire → reaper release → health-watch reclaim', () => {
  it('records three lines, each with actor name + pid, reason, HEAD before→after and dirty/ahead counts', () => {
    const mainSha = git(['rev-parse', 'HEAD'], referenceDir);
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-4370', '--purpose=conveyor', ...poolArgs()]).code).toBe(0);

    // The worker commits and pushes its branch — ahead 1, but preserved on a remote ref.
    writeFileSync(join(lanePath(1), 'file.txt'), 'work\n');
    commit(lanePath(1), 'work');
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/4370-x'], lanePath(1));
    const workSha = git(['rev-parse', 'HEAD'], lanePath(1));

    reaperRelease(1, 'session-gone');
    const reclaimed = watchReclaim(1);
    expect(reclaimed?.reclaimed).toBe(true);

    const entries = readLaneJournal(join(poolRoot, POOL), { lane: 1 });
    const acquire = entries.find((e) => e.action === 'acquire');
    const release = entries.find((e) => e.action === 'release');
    const reset = entries.find((e) => e.action === 'reclaim-reset');
    for (const e of [acquire, release, reset]) {
      expect(e).toBeTruthy();
      expect(e.lane).toBe(1);
      expect(typeof e.actor.name).toBe('string');
      expect(Number.isInteger(e.actor.pid)).toBe(true);
      expect(Number.isInteger(e.actor.ppid)).toBe(true);
      expect(e.reason).toBeTruthy();
      expect(e.headBefore).toMatch(/^[0-9a-f]{40}$/);
      expect(e.headAfter).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isInteger(e.dirtyBefore)).toBe(true);
      expect(Number.isInteger(e.aheadBefore)).toBe(true);
    }
    // acquire: a CLI acquire, landing on origin/main.
    expect(acquire.actor.name).toBe('lane-pool');
    expect(acquire.actor.script).toBe('lane-pool acquire');
    expect(acquire.headAfter).toBe(mainSha);
    expect(acquire.session).toBe('conveyor-4370');
    // release: names the REAPER and its classification, not a host:pid.
    expect(release.actor.name).toBe(LEASE_REAPER_ACTOR);
    expect(release.actor.ppid).toBe(process.pid);
    expect(release.reason).toBe('session-gone');
    expect(release.headBefore).toBe(workSha);
    expect(release.aheadBefore).toBe(1);
    expect(release.leaseSession).toBe('conveyor-4370');
    // reclaim: names the HEALTH WATCH, the pass that chose the lane, and the reset it did.
    expect(reset.actor.name).toBe(HEALTH_WATCH_ACTOR);
    expect(reset.actor.script).toBe('lane-pool reclaim');
    expect(reset.reason).toMatch(/health-watch reclaim pass/);
    expect(reset.headBefore).toBe(workSha);
    expect(reset.headAfter).toBe(mainSha);
    expect(reset.aheadBefore).toBe(1);
    expect(reset.dirtyBefore).toBe(0);
    expect(reset.unpushed).toBe(false);
    // Oldest first, in lifecycle order.
    expect(entries.indexOf(acquire)).toBeLessThan(entries.indexOf(release));
    expect(entries.indexOf(release)).toBeLessThan(entries.indexOf(reset));

    // `lane-whois --history <lane>` prints that timeline.
    const r = spawnSync('node', [WHOIS_SCRIPT, '--history', '1', `--pool-root=${poolRoot}`, `--name=${POOL}`], { encoding: 'utf8', cwd: referenceDir, env });
    expect(r.status).toBe(0);
    const out = String(r.stdout);
    expect(out).toMatch(/lane-1 lifecycle journal/);
    expect(out).toMatch(new RegExp(`release\\s+by ${LEASE_REAPER_ACTOR} \\(pid \\d+`));
    expect(out).toMatch(/session-gone/);
    expect(out).toMatch(new RegExp(`reclaim-reset\\s+by ${HEALTH_WATCH_ACTOR} \\(pid \\d+`));
    expect(out).toContain(`HEAD ${workSha.slice(0, 9)}→${mainSha.slice(0, 9)}`);
    expect(out.indexOf('acquire')).toBeLessThan(out.indexOf('reclaim-reset'));
  });

  it('a reclaim over UNPUSHED work is refused, journalled loud once (not every tick), and the tree survives', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'file.txt'), 'never pushed\n');
    commit(lanePath(1), 'local only');
    const localSha = git(['rev-parse', 'HEAD'], lanePath(1));
    reaperRelease(1, 'ttl-stale');

    const first = runPool(['reclaim', '--lane=1', '--json', '--reason=test', ...poolArgs()]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out).reclaimed).toBe(false);
    runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]); // the next tick: same refusal, same state
    expect(git(['rev-parse', 'HEAD'], lanePath(1))).toBe(localSha);

    const refusals = readLaneJournal(join(poolRoot, POOL), { lane: 1 }).filter((e) => e.action === 'reclaim-refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ unpushed: true, loud: true, headBefore: localSha, aheadBefore: 1, unpushedCommitsBefore: 1 });
  });

  it('an operator --override that destroys unpushed work is journalled loud and fires lane-destructive-unpushed', () => {
    expect(runPool(['acquire', '--lane=2', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(2), 'file.txt'), 'never pushed\n');
    commit(lanePath(2), 'local only');
    reaperRelease(2, 'ttl-stale');

    const r = runPool(['reclaim', '--lane=2', '--override', '--json', ...poolArgs()]);
    expect(JSON.parse(r.out).reclaimed).toBe(true);
    expect(r.err).toMatch(/⚠ lane-2: reclaim-reset by lane-pool/);

    const reset = readLaneJournal(join(poolRoot, POOL), { lane: 2 }).find((e) => e.action === 'reclaim-reset');
    expect(reset).toMatchObject({ unpushed: true, override: true, loud: true });
    expect(isUnsalvagedDestructiveUnpushed(reset)).toBe(true);

    // The real probe over this pool root, then the real smell.
    const probe = probeLaneJournal({ poolRoot, now: Date.now() });
    const results = destructiveSmell.evaluate({ laneJournal: probe }, { now: Date.now() });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subject: `lane:${POOL}/lane-2`, breach: true });
    expect(results[0].measure.actor).toBe('lane-pool');
  });
});
