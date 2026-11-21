/**
 * @file breaks/lane-acquire-default-wait.mjs — card xpkt8mh. Workers failed at lease with "no lane within 0ms"
 * on a momentary pool-lock/capacity flicker, because `acquire` without --wait-ms failed on its very first
 * reading. FIX: the omitted flag now polls for a short bounded default (8000ms; env
 * LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS overrides); explicit --wait-ms=0 stays instant-fail.
 *
 * SCENARIO: a REAL 1-lane pool whose only lane is leased by another session; `acquire` is run with NO
 * --wait-ms and LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS=2500. RED = it fails in well under that window (instant-fail,
 * the env is ignored); GREEN = it keeps polling for about the default and only then fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const MARKER = 'scripts/lane-pool.mjs';
const DEFAULT_WAIT_MS = 2500;

// Exercise the production acquire loop AND cached-scan implementation with private IO. This also
// runs in a sandbox that forbids spawning the CLI or creating temporary Git repositories.
export async function replayAcquireDeadline({ waitMs = 30, reaperMs = 0, free = false, recovery = false, scanFailure = null } = {}, root = REPO_ROOT) {
  const source = readFileSync(join(root, MARKER), 'utf8');
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  const report = { scans: 0, polls: 0, grown: 0, recovered: 0, claimed: null, error: null };
  const claimed = new Error('fixture claim boundary');
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const context = {
    flags: { 'no-free-list': true }, repo: { name: 'fixture', poolDir: '/fixture' },
    process: { env: {}, cwd: () => '/caller', stderr: { write() {} } },
    Date, Set, Number, Math, basename: path => path.split('/').pop(), sep: '/',
    defaultSession: () => 'picker', ttlMsFromFlags: () => 60_000,
    reapDeadLeasesInPool: () => sleep(reaperMs), parseScopeFlag: () => [],
    existingLanes: () => [1], resolveReal: value => value, ownLaneNumber: () => null,
    acquireDefaultWaitMs: waitMs, acquireDefaultWaitInvalid: false,
    ACQUIRE_POLL_MS: 1000, LIST_LOCK_ORPHAN_GRACE_MS: 1000,
    laneDir: (repo, n) => `${repo.poolDir}/lane-${n}`, isHistoryQuarantined: () => false,
    listScanTimeoutMs: () => 120_000, listCacheTtlMs: () => 0,
    lastListWasLockPartial: false, lastScanPartial: false,
    readListCache: () => null, tryTakeListLock: () => true, readLockOwner: () => null,
    releaseListLock() {}, writeListCache() {},
    scanAcquirable: () => {
      report.scans++;
      if (scanFailure) throw Object.assign(new Error(scanFailure), { [scanFailure]: true });
      return free ? ['/fixture/lane-1'] : [];
    },
    sleepSyncMs: ms => { report.polls++; sleep(ms); }, jitteredDelayMs: ms => ms,
    tryClaimLane: dir => { report.claimed = dir; throw claimed; },
    liveRemoteShasProbe: () => ({ ok: true }),
    growPoolOnEmpty: () => { report.grown++; return recovery ? [] : [2]; },
    recoveryEnabled: () => recovery, readdirSync: () => ['lane-1'],
    classifyLaneNames: () => ({ valid: [1], rejected: [] }), acquireHardMaxFor: () => 2,
    recoverRepoPool: async () => { report.recovered++; return { reclaimed: [1] }; },
    invalidateListCache() {}, laneAcquirableInfo: () => ({}), isLaneAcquirable: () => true,
    log() {}, fail: message => { throw new Error(message); },
  };
  try {
    await runInNewContext(`${extract('acquirableListCachedRaw')}\n${extract('acquirableListCached')}\nasync ${extract('cmdAcquire')}\ncmdAcquire(repo)`, context);
  } catch (error) {
    if (error !== claimed) report.error = error.message;
  }
  return report;
}

export async function replay(root = REPO_ROOT) {
  const script = join(root, 'scripts', 'lane-pool.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'soak-acquire-default-wait-'));
  try {
    // The exhausted-pool failure path probes GitHub (PR listing); fake `gh` keeps the replay hermetic.
    const bin = join(tmp, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
    // The full-pool failure publishes a NEEDS-YOU event; keep it in a private temp feed, never the live stream.
    const feed = join(tmp, 'needs-you-events.jsonl');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', LANE_POOL_ROOT: join(tmp, 'pool'), WE_NEEDS_YOU_FEED: feed, LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: String(DEFAULT_WAIT_MS) };
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024 });
    const id = ['-c', 'user.name=s', '-c', 'user.email=s@s', '-c', 'commit.gpgsign=false'];
    const origin = join(tmp, 'origin.git'); const ref = join(tmp, 'reference');
    git(tmp, ['init', '--bare', '-b', 'main', origin]);
    git(tmp, ['clone', origin, ref]);
    writeFileSync(join(ref, 'file.txt'), 'v1\n');
    git(ref, ['add', 'file.txt']); git(ref, [...id, 'commit', '-m', 'v1']); git(ref, ['push', 'origin', 'HEAD:main']);
    const repoArgs = [`--origin=${origin}`, `--reference=${ref}`, '--name=soakdefwait', '--branch=main', '--no-install', '--no-reap'];
    const pool = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const prov = pool(['provision', '--count=1', ...repoArgs]);
    if (prov.status !== 0) return { harness: false, detail: String(prov.stderr).slice(0, 200) };
    const held = pool(['acquire', ...repoArgs, '--session=soak-holder', '--hard-max=1', '--no-free-list', '--wait-ms=0']);
    if (held.status !== 0) return { harness: false, detail: `holder acquire failed: ${String(held.stderr).slice(0, 200)}` };
    const startedAt = Date.now();
    const r = pool(['acquire', ...repoArgs, '--session=soak-waiter', '--hard-max=1', '--no-free-list']);
    return { harness: true, feed, feedPrivate: !feed.startsWith(join(process.env.HOME || '/nonexistent', 'workspace')), feedWritten: existsSync(feed), code: r.status, ms: Date.now() - startedAt, err: String(r.stderr).slice(-300) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default {
  id: 'lane-acquire-default-wait',
  title: 'acquire without --wait-ms failed instantly ("no lane within 0ms") on a transient pool flicker instead of polling a short bounded default',
  card: 'we:backlog/8567',
  fixedBy: { sha: 'dc8163c4ee', where: 'lane/lane-pool-default-wait', paths: ['scripts/lane-pool.mjs'] },
  fixPresent(root) { try { return /LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS/.test(readFileSync(join(root, MARKER), 'utf8')); } catch { return false; } },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      for (const options of [{ reaperMs: 60 }, { waitMs: 0, free: true }, {}, { recovery: true }]) {
        const deadline = await replayAcquireDeadline(options);
        if (!deadline.claimed || deadline.error || deadline.scans !== 1 || (options.reaperMs && deadline.polls === 0)) {
          violations.push({ invariant: 'default-deadline-preserves-first-scan-and-fallback', detail: JSON.stringify({ options, ...deadline }) });
        }
      }
      if (!report.harness) violations.push({ invariant: 'harness', detail: report.detail || 'pool did not provision' });
      else if (report.code === 0) violations.push({ invariant: 'unexpected-lane', detail: 'acquire returned a lane from a fully held 1-lane pool' });
      else if (report.ms < DEFAULT_WAIT_MS - 500) violations.push({ invariant: 'instant-fail-without-wait-ms', detail: `acquire without --wait-ms gave up after ${report.ms}ms, before the ${DEFAULT_WAIT_MS}ms default wait: ${report.err.replace(/\s+/g, ' ')}` });
      if (report.harness && (!report.feedPrivate || !report.feed.includes('soak-acquire-default-wait-'))) violations.push({ invariant: 'live-needs-you-feed', detail: `replay feed was not a private temp path: ${report.feed}` });
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
