/**
 * @file scripts/conveyor/__tests__/ci-queue-watch.test.mjs
 * @description Proof for the #3574 CI queue-wait tracking cadence, in three parts:
 *
 *   1. The PURE core (`waitSecondsOf` / `summarizeRuns` / `classifyQueueWait` / `parseHistory` /
 *      `appendSample` / `serializeHistory`) on injected values — no gh, no fs.
 *   2. The IO orchestrator ({@link sweepCiQueue}) against an injected fake `listRuns` + a real temp-file
 *      history path — proves a sweep actually GROWS the persisted history (the "over time" trend this item
 *      exists to make visible), not just that it computes one sample correctly.
 *   3. The real CLI, spawned as a subprocess against a fake `gh` shim on PATH and a temp `CONVEYOR_CI_QUEUE_FILE`
 *      — the integration/wiring test: proves argv parsing, the real `gh` shell-out shape, and the real
 *      atomic-write persistence path all work end to end, not just the in-process functions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  waitSecondsOf,
  summarizeRuns,
  classifyQueueWait,
  parseHistory,
  appendSample,
  serializeHistory,
  sweepCiQueue,
  readHistory,
  withHistoryLock,
  DEFAULT_WATCH_THRESHOLD_SEC,
  DEFAULT_BLOCKED_THRESHOLD_SEC,
  GH_UNSTARTED_SENTINEL,
} from '../ci-queue-watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'ci-queue-watch.mjs');

// ── 1. the pure core ─────────────────────────────────────────────────────────────────────────────────────────

describe('waitSecondsOf', () => {
  it('computes started-minus-created in seconds', () => {
    expect(waitSecondsOf({ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:01:30Z' })).toBe(90);
  });
  it('an instant start (0s gap, the sampled-real-runs shape from this card\'s own investigation)', () => {
    expect(waitSecondsOf({ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' })).toBe(0);
  });
  it('no startedAt yet (still queued) → null, not 0', () => {
    expect(waitSecondsOf({ createdAt: '2026-09-07T10:00:00Z', startedAt: '' })).toBeNull();
    expect(waitSecondsOf({ createdAt: '2026-09-07T10:00:00Z' })).toBeNull();
  });
  it('malformed timestamps → null, never throws', () => {
    expect(waitSecondsOf({ createdAt: 'not-a-date', startedAt: '2026-09-07T10:00:00Z' })).toBeNull();
    expect(waitSecondsOf({})).toBeNull();
    expect(waitSecondsOf(null)).toBeNull();
  });
  it('the real gh run list sentinel for "not started yet" (a truthy, parseable, non-empty string) → null, not 0', () => {
    // Found by this item's own convergence red-team: `gh run list --json startedAt` returns GitHub's zero
    // time.Time, "0001-01-01T00:00:00Z", for a still-queued run — NOT an empty string. A bare `!startedAt`
    // check misses it, Date.parse succeeds on it, and the resulting huge-negative delta clamps to 0 — a
    // still-queued run would silently count as an instant (0s) start instead of being excluded.
    expect(waitSecondsOf({ createdAt: '2026-09-07T10:00:00Z', startedAt: GH_UNSTARTED_SENTINEL })).toBeNull();
  });
  it('a negative gap (clock skew) clamps to 0, never negative', () => {
    expect(waitSecondsOf({ createdAt: '2026-09-07T10:01:00Z', startedAt: '2026-09-07T10:00:00Z' })).toBe(0);
  });
});

describe('summarizeRuns', () => {
  it('the real 20-run zero-queue sample this card\'s own investigation observed', () => {
    const runs = Array.from({ length: 20 }, () => ({ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' }));
    expect(summarizeRuns(runs)).toEqual({ sampled: 20, started: 20, maxWaitSeconds: 0, avgWaitSeconds: 0 });
  });

  it('a mixed sample: one long queue, one instant start, one still-queued', () => {
    const runs = [
      { createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:02:00Z' }, // 120s
      { createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' }, // 0s
      { createdAt: '2026-09-07T10:00:00Z', startedAt: '' }, // still queued — excluded
    ];
    expect(summarizeRuns(runs)).toEqual({ sampled: 3, started: 2, maxWaitSeconds: 120, avgWaitSeconds: 60 });
  });

  it('an all-queued sample does not silently read as a clean zero-wait sample', () => {
    const runs = [{ createdAt: '2026-09-07T10:00:00Z', startedAt: '' }, { createdAt: '2026-09-07T10:00:00Z' }];
    expect(summarizeRuns(runs)).toEqual({ sampled: 2, started: 0, maxWaitSeconds: 0, avgWaitSeconds: 0 });
  });

  it('empty / non-array input → all zeros, never throws', () => {
    expect(summarizeRuns([])).toEqual({ sampled: 0, started: 0, maxWaitSeconds: 0, avgWaitSeconds: 0 });
    expect(summarizeRuns(undefined)).toEqual({ sampled: 0, started: 0, maxWaitSeconds: 0, avgWaitSeconds: 0 });
  });
});

describe('classifyQueueWait', () => {
  it('no runs sampled → ok, with a distinct "no data" reason', () => {
    expect(classifyQueueWait({ sampled: 0 })).toEqual({ status: 'ok', reason: 'no runs sampled' });
  });
  it('under the watch line → ok', () => {
    const r = classifyQueueWait({ sampled: 20, started: 20, maxWaitSeconds: 10 });
    expect(r.status).toBe('ok');
  });
  it('past the watch line but under blocked → watch', () => {
    const r = classifyQueueWait({ sampled: 20, started: 20, maxWaitSeconds: DEFAULT_WATCH_THRESHOLD_SEC + 5 });
    expect(r.status).toBe('watch');
    expect(r.reason).toMatch(/watch line/);
  });
  it('past the blocked ceiling → blocked', () => {
    const r = classifyQueueWait({ sampled: 20, started: 20, maxWaitSeconds: DEFAULT_BLOCKED_THRESHOLD_SEC + 5 });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/ceiling/);
  });
  it('custom thresholds are honored', () => {
    expect(classifyQueueWait({ sampled: 1, started: 1, maxWaitSeconds: 15, watchThresholdSec: 10, blockedThresholdSec: 20 }).status).toBe('watch');
    expect(classifyQueueWait({ sampled: 1, started: 1, maxWaitSeconds: 25, watchThresholdSec: 10, blockedThresholdSec: 20 }).status).toBe('blocked');
  });

  // The #3574 convergence-review finding: a sample where every run is still queued (`started: 0`) must never
  // read identically to a genuinely healthy all-instant-start sample — both would otherwise compute
  // `maxWaitSeconds: 0` and misclassify a live capacity crunch as `ok`.
  it('sampled but NONE started yet → watch, never the same "ok" a real zero-wait sample gets', () => {
    const allQueued = classifyQueueWait({ sampled: 20, started: 0, maxWaitSeconds: 0 });
    expect(allQueued.status).toBe('watch');
    expect(allQueued.reason).toMatch(/none have started/);
    const allInstant = classifyQueueWait({ sampled: 20, started: 20, maxWaitSeconds: 0 });
    expect(allInstant.status).toBe('ok');
    expect(allInstant).not.toEqual(allQueued);
  });
  it('the all-queued watch fires regardless of how high the thresholds are set', () => {
    expect(classifyQueueWait({ sampled: 5, started: 0, watchThresholdSec: 999999, blockedThresholdSec: 9999999 }).status).toBe('watch');
  });
  it('an explicit 0 threshold is honored, not silently replaced by the default', () => {
    // A `> 0` guard (instead of `>= 0`) would treat 0 as "nothing set" and fall back to the 60s default,
    // reading a 1s wait as `ok` instead of `watch`.
    expect(classifyQueueWait({ sampled: 1, started: 1, maxWaitSeconds: 1, watchThresholdSec: 0 }).status).toBe('watch');
    expect(classifyQueueWait({ sampled: 1, started: 1, maxWaitSeconds: 1, watchThresholdSec: 0, blockedThresholdSec: 0 }).status).toBe('blocked');
  });
});

describe('parseHistory / appendSample / serializeHistory', () => {
  it('parses a well-formed array', () => {
    expect(parseHistory('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it('tolerates empty / bad JSON / a non-array root', () => {
    expect(parseHistory('')).toEqual([]);
    expect(parseHistory('not json')).toEqual([]);
    expect(parseHistory('{"a":1}')).toEqual([]);
    expect(parseHistory(null)).toEqual([]);
  });
  it('appendSample grows the history', () => {
    expect(appendSample([{ n: 1 }], { n: 2 })).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it('appendSample caps as a ring buffer — oldest dropped first', () => {
    const history = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(appendSample(history, { n: 4 }, { maxEntries: 3 })).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
  });
  it('serializeHistory round-trips through parseHistory', () => {
    const history = [{ checkedAt: '2026-09-07T10:00:00Z', status: 'ok' }];
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
});

// ── 2. the IO orchestrator — proves history actually GROWS over repeated sweeps ─────────────────────────────

describe('sweepCiQueue — grows the persisted history across sweeps (the "over time" trend itself)', () => {
  let dir, historyPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-queue-watch-'));
    historyPath = join(dir, 'ci-queue-history.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('three sweeps append three samples, each reflecting its own injected runs', () => {
    const samples = [
      [{ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' }], // 0s
      [{ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:02:00Z' }], // 120s → watch
      [{ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:06:00Z' }], // 360s → blocked
    ];
    let call = 0;
    const listRuns = () => samples[call++];
    let tick = 0;
    const now = () => `2026-09-07T10:0${tick++}:00Z`;

    for (let i = 0; i < 3; i++) sweepCiQueue({ listRuns, historyPath, now });

    const history = readHistory(historyPath);
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.status)).toEqual(['ok', 'watch', 'blocked']);
    expect(history[2].maxWaitSeconds).toBe(360);
  });

  it('a listRuns failure propagates (never silently reported as a clean sample)', () => {
    const listRuns = () => { throw new Error('gh: rate limited'); };
    expect(() => sweepCiQueue({ listRuns, historyPath })).toThrow(/rate limited/);
    expect(readHistory(historyPath)).toEqual([]); // nothing persisted for a sweep that never got real data
  });

  it('returns the fresh sample with persisted:true on success', () => {
    const listRuns = () => [{ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' }];
    const result = sweepCiQueue({ listRuns, historyPath, now: () => '2026-09-07T10:00:00Z' });
    expect(result).toMatchObject({ sampled: 1, started: 1, status: 'ok', persisted: true });
  });

  it('a sweep that sampled fine but could not WRITE the sidecar still reports what it found, persisted:false — never throws', () => {
    // Force a real write failure: `historyPath` sits "inside" a plain FILE, so `mkdirSync(dirname(...))`
    // throws ENOTDIR — the same class of failure a permissions error or a full disk would produce.
    const blockerFile = join(dir, 'blocker');
    writeFileSync(blockerFile, 'not a directory');
    const unwritablePath = join(blockerFile, 'ci-queue-history.json');
    const listRuns = () => [{ createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' }];
    const result = sweepCiQueue({ listRuns, historyPath: unwritablePath, now: () => '2026-09-07T10:00:00Z' });
    expect(result).toMatchObject({ sampled: 1, started: 1, status: 'ok', persisted: false });
  });
});

// ── withHistoryLock — the concurrency-review finding: a hand-run sweep racing the runner's own tick must
//    never lose one of their two samples ──────────────────────────────────────────────────────────────────

describe('withHistoryLock', () => {
  let dir, lockPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-queue-watch-lock-'));
    lockPath = join(dir, 'ci-queue-history.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs fn and returns its result, cleaning up the lock file afterward', () => {
    expect(withHistoryLock(lockPath, () => 42)).toBe(42);
    expect(existsSync(`${lockPath}.lock`)).toBe(false);
  });

  it('a STALE leftover lock (a crashed prior holder) is stolen rather than blocking', () => {
    const stale = `${lockPath}.lock`;
    writeFileSync(stale, '');
    const old = Date.now() - 60_000; // well past even the default 10s staleness window
    utimesSync(stale, old / 1000, old / 1000);
    const ran = withHistoryLock(lockPath, () => 'ran');
    expect(ran).toBe('ran');
  });

  it('a lock held by a live (non-stale) holder times out and runs fn UNLOCKED rather than wedging forever', () => {
    const held = `${lockPath}.lock`;
    writeFileSync(held, ''); // never released, never stale within this test's short timeoutMs
    const ran = withHistoryLock(lockPath, () => 'ran-unlocked', { staleMs: 10_000, timeoutMs: 20 });
    expect(ran).toBe('ran-unlocked');
    expect(readFileSync(held, 'utf8')).toBe(''); // the live holder's own lock file is untouched — never stolen or cleaned up
  });

  it('required: a lock that cannot be taken returns LOCK_UNAVAILABLE without running fn', async () => {
    const { LOCK_UNAVAILABLE } = await import('../ci-queue-watch.mjs');
    writeFileSync(`${lockPath}.lock`, 'someone-else');
    let ran = false;
    const out = withHistoryLock(lockPath, () => { ran = true; }, { staleMs: 10_000, timeoutMs: 20, required: true });
    expect(out).toBe(LOCK_UNAVAILABLE);
    expect(ran).toBe(false);
    expect(readFileSync(`${lockPath}.lock`, 'utf8')).toBe('someone-else');
  });

  it('touch() keeps a long holder from going stale, so a contender cannot steal the lock', async () => {
    const { sleepSyncMs } = await import('../../readiness/drain-lock.mjs');
    let contender;
    withHistoryLock(lockPath, (touch) => {
      for (let i = 0; i < 4; i += 1) {
        sleepSyncMs(25);
        expect(touch()).toBe(true); // refreshed between slow calls: never older than ~25 ms
      }
      contender = withHistoryLock(lockPath, () => 'stole-it', { staleMs: 60, timeoutMs: 20, required: true });
    }, { staleMs: 60 });
    expect(typeof contender).toBe('symbol'); // total hold time (>100 ms) exceeded staleMs, yet the lock was not stolen
  });

  it('a holder whose lock was taken over reports it via touch() and never deletes the new holder\'s lock', () => {
    withHistoryLock(lockPath, (touch) => {
      rmSync(`${lockPath}.lock`);
      writeFileSync(`${lockPath}.lock`, 'new-holder-token'); // a stale-steal by another process
      expect(touch()).toBe(false);
    });
    expect(readFileSync(`${lockPath}.lock`, 'utf8')).toBe('new-holder-token');
  });

  it('two REAL concurrent sweep CLI invocations against the SAME sidecar never lose either sample', async () => {
    // The exact race the review finding names: a human running `sweep` by hand while another writer (here,
    // a second concurrent process standing in for the resident runner's tick) writes the same sidecar file.
    // Real child processes, real fs — not simulated — so an unserialized read-modify-write would genuinely
    // drop one of the two appended samples.
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const ghPath = join(binDir, 'gh');
    writeFileSync(
      ghPath,
      '#!/usr/bin/env node\n' +
        "process.stdout.write(JSON.stringify([{databaseId:1,status:'completed',createdAt:'2026-09-07T10:00:00Z',startedAt:'2026-09-07T10:00:00Z'}]));\n",
    );
    chmodSync(ghPath, 0o755);
    const run = () =>
      new Promise((resolvePromise, reject) => {
        execFile(
          'node',
          [CLI, 'sweep', '--json'],
          { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: lockPath } },
          (err) => (err ? reject(err) : resolvePromise()),
        );
      });
    await Promise.all([run(), run()]);
    const history = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(history).toHaveLength(2); // both samples survived — neither writer clobbered the other's append
  });
});

// ── 3. the real CLI, end to end, against a fake `gh` on PATH ────────────────────────────────────────────────

describe('ci-queue-watch.mjs CLI — real subprocess, fake gh, real sidecar file', () => {
  let dir, binDir, historyPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-queue-watch-cli-'));
    historyPath = join(dir, 'ci-queue-history.json');
    binDir = join(dir, 'bin');
    mkdirSync(binDir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function installFakeGh(runsJson) {
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(runsJson))});\n`);
    chmodSync(ghPath, 0o755);
  }

  function runCli(args) {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: historyPath },
    });
  }

  it('sweep --json shells the fake gh, classifies the sample, and persists it to the real sidecar', () => {
    installFakeGh([
      { databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' },
      { databaseId: 2, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:01:30Z' },
    ]);
    const out = JSON.parse(runCli(['sweep', '--json']));
    expect(out).toMatchObject({ sampled: 2, started: 2, maxWaitSeconds: 90, status: 'watch', persisted: true });

    const onDisk = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ sampled: 2, maxWaitSeconds: 90 });
  });

  it('a second sweep appends rather than overwriting — the trend accumulates across real CLI invocations', () => {
    installFakeGh([{ databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z' }]);
    runCli(['sweep', '--json']);
    installFakeGh([{ databaseId: 2, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:07:00Z' }]);
    runCli(['sweep', '--json']);

    const onDisk = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(onDisk).toHaveLength(2);
    expect(onDisk.map((s) => s.status)).toEqual(['ok', 'blocked']);
  });

  it('check --json reads back the latest sample without re-sampling gh', () => {
    installFakeGh([{ databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:05:00Z' }]);
    runCli(['sweep', '--json']);
    const checked = JSON.parse(runCli(['check', '--json']));
    expect(checked).toMatchObject({ status: 'watch', samples: 1 });
  });

  it('check --json with no prior sweep → unknown, never throws', () => {
    const checked = JSON.parse(runCli(['check', '--json']));
    expect(checked).toMatchObject({ status: 'unknown', samples: 0 });
  });

  it('--watch-sec/--blocked-sec actually change the CLI classification, not just the pure function', () => {
    // 90s wait: `ok` under the (raised) custom thresholds, `blocked` under a lowered blocked-sec — proves the
    // real argv→numFlag→sweepCiQueue wiring, not just classifyQueueWait called directly with the same numbers.
    installFakeGh([{ databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:01:30Z' }]);
    const lenient = JSON.parse(runCli(['sweep', '--json', '--watch-sec=120', '--blocked-sec=300']));
    expect(lenient.status).toBe('ok');
    const strict = JSON.parse(runCli(['sweep', '--json', '--blocked-sec=60']));
    expect(strict.status).toBe('blocked');
  });

  it('--limit is threaded through to the real gh invocation argv', () => {
    const ghPath = join(binDir, 'gh');
    const argvFile = join(dir, 'gh-argv.json');
    // `sweep` also lists PRs for the hung-job check (xncfkf2) — record only the `gh run list` call's argv.
    writeFileSync(ghPath, `#!/usr/bin/env node\nif (process.argv[2] === 'run') require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('[]');\n`);
    chmodSync(ghPath, 0o755);
    runCli(['sweep', '--json', '--limit=5']);
    const ghArgv = JSON.parse(readFileSync(argvFile, 'utf8'));
    expect(ghArgv).toContain('5');
    expect(ghArgv[ghArgv.indexOf('--limit') + 1]).toBe('5');
  });

  it('--repo is threaded through to the real gh invocation argv', () => {
    const ghPath = join(binDir, 'gh');
    const argvFile = join(dir, 'gh-argv-repo.json');
    // `sweep` also lists PRs for the hung-job check (xncfkf2) — record only the `gh run list` call's argv.
    writeFileSync(ghPath, `#!/usr/bin/env node\nif (process.argv[2] === 'run') require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('[]');\n`);
    chmodSync(ghPath, 0o755);
    runCli(['sweep', '--json', '--repo=web-everything/web-everything']);
    const ghArgv = JSON.parse(readFileSync(argvFile, 'utf8'));
    expect(ghArgv[ghArgv.indexOf('--repo') + 1]).toBe('web-everything/web-everything');
  });

  it('a bare valueless --limit (no "=N") falls back to the default limit, never Number(true) === 1', () => {
    const ghPath = join(binDir, 'gh');
    const argvFile = join(dir, 'gh-argv-bare.json');
    // `sweep` also lists PRs for the hung-job check (xncfkf2) — record only the `gh run list` call's argv.
    writeFileSync(ghPath, `#!/usr/bin/env node\nif (process.argv[2] === 'run') require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('[]');\n`);
    chmodSync(ghPath, 0o755);
    runCli(['sweep', '--json', '--limit']); // no "=value" — parseFlags sets this to the boolean `true`
    const ghArgv = JSON.parse(readFileSync(argvFile, 'utf8'));
    expect(ghArgv[ghArgv.indexOf('--limit') + 1]).toBe('20'); // DEFAULT_SAMPLE_LIMIT, not "1"
  });

  it('WE_CI_QUEUE_BLOCKED_SEC env var overrides the blocked-classification threshold', () => {
    installFakeGh([{ databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:01:30Z' }]);
    const out = JSON.parse(
      execFileSync('node', [CLI, 'sweep', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${binDir}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: historyPath,
          WE_CI_QUEUE_BLOCKED_SEC: '60',
        },
      }),
    );
    expect(out.status).toBe('blocked');
  });

  it('WE_CI_QUEUE_WATCH_SEC env var overrides the watch-classification threshold, isolated from any --flag', () => {
    installFakeGh([{ databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:10Z' }]); // 10s
    const out = JSON.parse(
      execFileSync('node', [CLI, 'sweep', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${binDir}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: historyPath,
          WE_CI_QUEUE_WATCH_SEC: '5', // 10s > a 5s watch line → watch, though it's well under the DEFAULT 60s
        },
      }),
    );
    expect(out.status).toBe('watch');
  });

  it('an explicit --watch-sec=0 / --blocked-sec=0 is HONORED, never silently replaced by the default', () => {
    installFakeGh([{ databaseId: 1, status: 'completed', createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:01Z' }]); // 1s
    const out = JSON.parse(runCli(['sweep', '--json', '--watch-sec=0', '--blocked-sec=999']));
    expect(out.status).toBe('watch'); // any wait > 0 trips a 0s watch line; a `> 0` bug would fall back to the 60s default and read `ok`
  });
});

it('keeps separate per-repo histories and preserves the WE filename', async () => {
  const { resolveCiQueueHistoryPath } = await import('../ci-queue-watch.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ci-repos-'));
  const previous = process.env.CONVEYOR_CI_QUEUE_FILE;
  try {
    process.env.CONVEYOR_CI_QUEUE_FILE = join(dir, 'history.json');
    for (const [repo, suffix, count] of [['web-everything/web-everything', '', 1], ['frontier-ui/frontierui', '-frontierui', 2], ['plateauapp/plateau-app', '-plateau-app', 3]]) {
      for (let i = 0; i < count; i++) sweepCiQueue({ repo, listRuns: () => [], now: () => repo });
      const path = resolveCiQueueHistoryPath(repo);
      expect(path).toBe(join(dir, `history${suffix}.json`));
      expect(readHistory(path)).toHaveLength(count);
    }
    expect(readHistory(resolveCiQueueHistoryPath())).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.CONVEYOR_CI_QUEUE_FILE;
    else process.env.CONVEYOR_CI_QUEUE_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. hung CI jobs (we:backlog/xncfkf2) ────────────────────────────────────────────────────────────────────
// Live shape, PR #4450 2026-10-08: GitHub reported the required `daemon-soak` job `in_progress` for 90+ min
// although every step had finished and `completedAt`/`conclusion` were already set. Nothing noticed it.
describe('hung CI jobs', () => {
  const T0 = Date.parse('2026-10-08T15:02:41Z');
  const MIN = 60_000;
  const url = (run, job) => `https://github.com/web-everything/web-everything/actions/runs/${run}/job/${job}`;
  const done = (name, job, sec) => ({
    name, workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: url(9, job),
    startedAt: new Date(T0 - 3600_000).toISOString(), completedAt: new Date(T0 - 3600_000 + sec * 1000).toISOString(),
  });
  const phantom = (job = 113380540047, run = 37796107550) => ({
    name: 'daemon-soak', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: 'SUCCESS', detailsUrl: url(run, job),
    startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 3000).toISOString(),
  });
  const pr = (checks, number = 4450, head = 'db9f116') => ({ number, headRefOid: head, statusCheckRollup: checks });

  let dir;
  let statePath;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ci-hung-')); statePath = join(dir, 'hung.json'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('jobRefOf reads the run and job ids from an Actions details URL, null otherwise', async () => {
    const { jobRefOf } = await import('../ci-queue-watch.mjs');
    expect(jobRefOf({ detailsUrl: url(37796107550, 113380540047) })).toEqual({ runId: 37796107550, jobId: 113380540047 });
    expect(jobRefOf({ detailsUrl: 'https://github.com/web-everything/web-everything/runs/113376158917' })).toBeNull();
    expect(jobRefOf({})).toBeNull();
  });

  // The details URL is attacker-influenceable (any app with checks:write sets it), and its ids drive writes made
  // with the App's actions:write token — so it must be this repo's own Actions job URL, exactly.
  it.each([
    ['another repo', 'https://github.com/evil/other/actions/runs/1/job/2'],
    ['another host', 'https://evil.example/web-everything/web-everything/actions/runs/1/job/2'],
    ['a look-alike host', 'https://github.com.evil.example/web-everything/web-everything/actions/runs/1/job/2'],
    ['http', 'http://github.com/web-everything/web-everything/actions/runs/1/job/2'],
    ['userinfo', 'https://x:y@github.com/web-everything/web-everything/actions/runs/1/job/2'],
    ['a prefix before the path', 'https://github.com/evil/other/x/web-everything/web-everything/actions/runs/1/job/2'],
    ['the path inside the query', 'https://github.com/evil/other?u=/web-everything/web-everything/actions/runs/1/job/2'],
    ['a suffix after the job id', 'https://github.com/web-everything/web-everything/actions/runs/1/job/2/../../../x'],
    ['a run id past the safe-integer range', 'https://github.com/web-everything/web-everything/actions/runs/123456789012345678901234567890/job/2'],
    ['a job id past the safe-integer range', 'https://github.com/web-everything/web-everything/actions/runs/1/job/123456789012345678901234567890'],
  ])('jobRefOf rejects %s', async (_label, detailsUrl) => {
    const { jobRefOf } = await import('../ci-queue-watch.mjs');
    expect(jobRefOf({ detailsUrl })).toBeNull();
  });

  it('jobRefOf accepts a query string and compares the repo case-insensitively; a sibling repo needs its own slug', async () => {
    const { jobRefOf } = await import('../ci-queue-watch.mjs');
    expect(jobRefOf({ detailsUrl: 'https://github.com/Web-Everything/web-everything/actions/runs/7/job/8?pr=4450' })).toEqual({ runId: 7, jobId: 8 });
    expect(jobRefOf({ detailsUrl: 'https://github.com/web-everything/frontierui/actions/runs/7/job/8' })).toBeNull();
    expect(jobRefOf({ detailsUrl: 'https://github.com/web-everything/frontierui/actions/runs/7/job/8' }, 'web-everything/frontierui')).toEqual({ runId: 7, jobId: 8 });
  });

  // A third-party app with checks:write sets its own name, times and details URL — but not `workflowName`, which only
  // Actions check runs carry. A perfect-looking Actions URL on a non-Actions check must not teach or trigger anything.
  it('a non-Actions check carrying a perfect Actions URL is neither learned nor flagged', async () => {
    const { findHungChecks, learnDurations } = await import('../ci-queue-watch.mjs');
    const strip = (c) => { const { workflowName: _w, ...rest } = c; return rest; };
    const forgedSuccess = strip({ ...done('daemon-soak', 77, 36_000) }); // a fake 10-hour "success" under a real check name
    expect(learnDurations({}, [pr([forgedSuccess])])).toEqual({});
    expect(findHungChecks([pr([strip(phantom())])], {}, { now: T0 + 95 * MIN, k: 3, floorSec: 1800 })).toEqual([]);
    expect(findHungChecks([pr([{ ...phantom(), workflowName: '  ' }])], {}, { now: T0 + 95 * MIN, k: 3, floorSec: 1800 })).toEqual([]);
  });

  it('a foreign-repo URL feeds neither the hung scan nor the learned durations', async () => {
    const { findHungChecks, learnDurations } = await import('../ci-queue-watch.mjs');
    const foreign = 'https://github.com/evil/other/actions/runs/37796107550/job/113380540047';
    const prs = [pr([{ ...phantom(), detailsUrl: foreign }, { ...done('test', 1, 60), detailsUrl: foreign }])];
    expect(findHungChecks(prs, {}, { now: T0 + 95 * MIN, k: 3, floorSec: 1800 })).toEqual([]);
    expect(learnDurations({}, prs)).toEqual({});
  });

  it('percentile is nearest-rank; empty is null', async () => {
    const { percentile } = await import('../ci-queue-watch.mjs');
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
  });

  it('learnDurations keeps only successful completed jobs, dedups by job id, caps the window', async () => {
    const { learnDurations } = await import('../ci-queue-watch.mjs');
    const prs = [pr([done('test', 1, 60), done('test', 1, 60), done('test', 2, 90), phantom(),
      { ...done('test', 3, 10), conclusion: 'FAILURE' }])];
    const d = learnDurations({}, prs, { window: 50 });
    expect(d.test.map((s) => s.jobId)).toEqual([1, 2]);
    expect(d.test.map((s) => s.sec)).toEqual([60, 90]);
    expect(d['daemon-soak']).toBeUndefined();
    const capped = learnDurations(d, [pr([done('test', 4, 30), done('test', 5, 40)])], { window: 3 });
    expect(capped.test.map((s) => s.jobId)).toEqual([2, 4, 5]);
  });

  it('hungThreshold is max(floor, k × p95)', async () => {
    const { hungThreshold } = await import('../ci-queue-watch.mjs');
    expect(hungThreshold([], { k: 3, floorSec: 1800 })).toMatchObject({ thresholdSec: 1800, p95Sec: null, samples: 0 });
    const long = Array.from({ length: 10 }, (_, i) => ({ jobId: i, sec: 1200 }));
    expect(hungThreshold(long, { k: 3, floorSec: 1800 })).toMatchObject({ thresholdSec: 3600, p95Sec: 1200, samples: 10 });
  });

  it('findHungChecks flags the live #4450 shape (in_progress past the threshold) and nothing under it', async () => {
    const { findHungChecks } = await import('../ci-queue-watch.mjs');
    const durations = { 'daemon-soak': [{ jobId: 1, sec: 3 }, { jobId: 2, sec: 4 }] };
    const prs = [pr([phantom(), done('test', 7, 60)])];
    const hung = findHungChecks(prs, durations, { now: T0 + 95 * MIN, k: 3, floorSec: 1800 });
    expect(hung).toHaveLength(1);
    expect(hung[0]).toMatchObject({ pr: 4450, headSha: 'db9f116', name: 'daemon-soak', runId: 37796107550, jobId: 113380540047, thresholdSec: 1800 });
    expect(Math.round(hung[0].inProgressSec / 60)).toBe(95);
    expect(findHungChecks(prs, durations, { now: T0 + 20 * MIN, k: 3, floorSec: 1800 })).toEqual([]);
    // a check with no Actions job behind it (no rerun handle) is never flagged
    const noJob = [pr([{ ...phantom(), detailsUrl: 'https://example.com/x' }])];
    expect(findHungChecks(noJob, durations, { now: T0 + 95 * MIN, k: 3, floorSec: 1800 })).toEqual([]);
  });

  it('planHungActions: first hang recovers, the same job is not touched twice, a second hang on the head escalates', async () => {
    const { planHungActions, hungKey } = await import('../ci-queue-watch.mjs');
    const h = { pr: 4450, headSha: 'db9f116', name: 'daemon-soak', runId: 1, jobId: 10 };
    expect(planHungActions([h], {}, { maxReruns: 1 })[0].action).toBe('recover');
    const ledger = { [hungKey(h)]: { jobIds: [10], reruns: 1, stage: 'rerun-requested' } };
    expect(planHungActions([h], ledger, { maxReruns: 1 })[0].action).toBe('handled');
    expect(planHungActions([{ ...h, jobId: 11 }], ledger, { maxReruns: 1 })[0].action).toBe('escalate');
    // a different head is a fresh slate
    expect(planHungActions([{ ...h, headSha: 'beef', jobId: 12 }], ledger, { maxReruns: 1 })[0].action).toBe('recover');
  });

  function fakes(runStatus = 'completed') {
    const calls = [];
    const lines = [];
    return {
      calls, lines,
      // The run object GitHub returns: a pull_request run of the CI workflow (the only kind the sweep acts on).
      getRun: ({ runId }) => { calls.push(['getRun', runId]); return { status: typeof runStatus === 'function' ? runStatus() : runStatus, head_sha: 'db9f116', event: 'pull_request', path: '.github/workflows/ci.yml', run_attempt: 1 }; },
      getJob: ({ jobId }) => { calls.push(['getJob', jobId]); return { id: jobId, run_id: 37796107550, name: 'daemon-soak' }; },
      cancelRun: ({ runId }) => { calls.push(['cancelRun', runId]); },
      forceCancelRun: ({ runId }) => { calls.push(['forceCancelRun', runId]); },
      rerunJob: ({ jobId }) => { calls.push(['rerunJob', jobId]); },
      rerunRun: ({ runId }) => { calls.push(['rerunRun', runId]); },
      log: (l) => lines.push(l),
    };
  }

  it('sweepHungJobs re-runs a hung job whose run already completed (no cancel), records it, and never repeats it', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const prs = [pr([phantom()])];
    const opts = { repo: 'web-everything/web-everything', listPrs: () => prs, statePath, k: 3, floorSec: 1800, maxReruns: 1, ...f };
    const r1 = sweepHungJobs({ ...opts, now: () => T0 + 95 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047], ['rerunJob', 113380540047]]);
    expect(r1.actions).toEqual([expect.objectContaining({ action: 'rerun-job', jobId: 113380540047, ok: true })]);
    const entry = Object.values(readHungState(statePath).hung)[0];
    expect(entry).toMatchObject({ pr: 4450, headSha: 'db9f116', name: 'daemon-soak', reruns: 1, stage: 'rerun-requested', jobIds: [113380540047] });
    expect(f.lines.join('\n')).toMatch(/ci-job-hung: RECOVER/);
    // GitHub may keep reporting the old job in_progress — it is already handled, so nothing more happens.
    f.calls.length = 0;
    sweepHungJobs({ ...opts, now: () => T0 + 100 * MIN });
    expect(f.calls).toEqual([]);
  });

  it('a second hang on the same head escalates (a logged [high] signal) instead of re-running again', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, ...f };
    sweepHungJobs({ ...base, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN });
    f.calls.length = 0;
    const second = { ...phantom(222, 333), startedAt: new Date(T0 + 100 * MIN).toISOString() };
    const r = sweepHungJobs({ ...base, listPrs: () => [pr([phantom(), second])], now: () => T0 + 140 * MIN });
    expect(f.calls.filter(([c]) => c.startsWith('rerun') || c.includes('ancel'))).toEqual([]);
    expect(r.escalations).toEqual([expect.objectContaining({ pr: 4450, name: 'daemon-soak', jobId: 222 })]);
    const esc = f.lines.find((l) => l.startsWith('ci-job-hung: ESCALATE '));
    expect(esc).toBeTruthy();
    expect(JSON.parse(esc.slice('ci-job-hung: ESCALATE '.length))).toMatchObject({ repo: 'web-everything/web-everything', pr: 4450, check: 'daemon-soak', jobId: 222 });
    expect(Object.values(readHungState(statePath).hung)[0].escalatedAt).toBeTruthy();
  });

  it('a hung job whose run is still running is cancelled first, then re-run on a later sweep once the run completes', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    let status = 'in_progress';
    const f = fakes(() => status);
    const live = { ...phantom(), conclusion: null, completedAt: null };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, ...f };
    sweepHungJobs({ ...base, listPrs: () => [pr([live])], now: () => T0 + 95 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047], ['cancelRun', 37796107550]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'cancel-requested', reruns: 0 });
    // next sweep: the cancelled job no longer shows in_progress; the ledger drives the pending re-run
    f.calls.length = 0;
    status = 'completed';
    sweepHungJobs({ ...base, listPrs: () => [pr([{ ...live, status: 'COMPLETED', conclusion: 'CANCELLED' }])], now: () => T0 + 97 * MIN });
    // the run was cancelled WHOLE (healthy sibling jobs included), so the whole run is re-run — never just the hung job
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunRun', 37796107550]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-requested', reruns: 1 });
  });

  it('a cancel that does not take within the grace window is force-cancelled', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    const live = { ...phantom(), conclusion: null, completedAt: null };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([live])], ...f };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    f.calls.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 96 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550]]); // still inside the grace window: just wait
    f.calls.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 105 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['forceCancelRun', 37796107550]]);
  });

  it('a refused job re-run falls back to re-running the whole run; a double failure is recorded, never thrown', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    f.rerunJob = ({ jobId }) => { f.calls.push(['rerunJob', jobId]); throw new Error('HTTP 403'); };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], ...f };
    const r = sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047], ['rerunJob', 113380540047], ['rerunRun', 37796107550]]);
    expect(r.actions.at(-1)).toMatchObject({ action: 'rerun-run', ok: true });
    rmSync(statePath, { force: true });
    f.calls.length = 0;
    const r2 = sweepHungJobs({ ...base, rerunRun: () => { throw new Error('HTTP 403 run'); }, now: () => T0 + 95 * MIN });
    expect(r2.actions.at(-1)).toMatchObject({ ok: false });
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ reruns: 0, stage: 'rerun-failed' });
  });

  // Live 2026-10-08 (first live run on #4450): gh-throttle was in a shared core-API rate-limit backoff, so the
  // run-status read AND both re-run writes were refused WITHOUT being sent. That is not GitHub refusing the
  // recovery: it must be retried on a later sweep, never escalated, and never acted on blind.
  const THROTTLED = 'gh-throttle: GitHub core API rate limit exceeded for this identity — shared backoff until 2026-10-08T17:17:36.000Z, call not sent (#gh-graphql-budget)';

  it('an unreadable run status defers the recovery (no blind re-run, no ledger entry) and a later sweep recovers', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], ...f };
    const r = sweepHungJobs({ ...base, getRun: () => { throw new Error(THROTTLED); }, now: () => T0 + 95 * MIN });
    expect(f.calls).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(f.lines.join('\n')).toMatch(/ci-job-hung: DEFERRED/);
    expect(readHungState(statePath).hung).toEqual({});
    sweepHungJobs({ ...base, now: () => T0 + 100 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047], ['rerunJob', 113380540047]]);
  });

  it('a throttled (not-sent) re-run is deferred and retried next sweep — no run-rerun fallback, no escalation', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], ...f };
    sweepHungJobs({ ...base, rerunJob: ({ jobId }) => { f.calls.push(['rerunJob', jobId]); throw new Error(THROTTLED); }, now: () => T0 + 95 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047], ['rerunJob', 113380540047]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-deferred', reruns: 0 });
    f.calls.length = 0;
    const r = sweepHungJobs({ ...base, now: () => T0 + 115 * MIN });
    expect(r.escalations).toEqual([]);
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047], ['rerunJob', 113380540047]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-requested', reruns: 1 });
  });

  it('a ledger left at rerun-failed by a transient (throttled) error is retried, not escalated', async () => {
    const { planHungActions, hungKey } = await import('../ci-queue-watch.mjs');
    const h = { pr: 4450, headSha: 'db9f116', name: 'daemon-soak', runId: 1, jobId: 10 };
    const transient = { [hungKey(h)]: { jobIds: [10], reruns: 0, stage: 'rerun-failed', actions: [{ action: 'rerun-run', ok: false, error: THROTTLED }] } };
    expect(planHungActions([h], transient, { maxReruns: 1 })[0].action).toBe('recover');
    const refused = { [hungKey(h)]: { jobIds: [10], reruns: 0, stage: 'rerun-failed', actions: [{ action: 'rerun-run', ok: false, error: 'HTTP 403: Resource not accessible by integration' }] } };
    expect(planHungActions([h], refused, { maxReruns: 1 })[0].action).toBe('escalate');
  });

  // ── a recovery that started with a CANCEL keeps being driven from the ledger after the check leaves in_progress ──
  // (review finding, impact "broken"): once the cancel lands, GitHub reports the check COMPLETED/CANCELLED, so
  // `findHungChecks` never sees it again — the ledger is the only thing left that can finish or escalate it.
  const cancelledSetup = async ({ rerunRun }) => {
    const mod = await import('../ci-queue-watch.mjs');
    let status = 'in_progress';
    const f = fakes(() => status);
    f.rerunRun = rerunRun(f);
    const live = { ...phantom(), conclusion: null, completedAt: null };
    const cancelled = { ...live, status: 'COMPLETED', conclusion: 'CANCELLED' };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, ...f };
    mod.sweepHungJobs({ ...base, listPrs: () => [pr([live])], now: () => T0 + 95 * MIN });
    status = 'completed';
    f.calls.length = 0;
    f.lines.length = 0;
    return { ...mod, f, base, cancelled, setStatus: (s) => { status = s; } };
  };

  it('retries a deferred rerun after cancellation completes', async () => {
    let throttle = true;
    const { sweepHungJobs, readHungState, f, base, cancelled } = await cancelledSetup({
      rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); if (throttle) throw new Error(THROTTLED); },
    });
    const listPrs = () => [pr([cancelled])];
    sweepHungJobs({ ...base, listPrs, now: () => T0 + 97 * MIN });
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-deferred', reruns: 0 });
    // the cancelled check never returns to in_progress; only the ledger can retry the throttled re-run
    throttle = false;
    f.calls.length = 0;
    const r = sweepHungJobs({ ...base, listPrs, now: () => T0 + 99 * MIN });
    expect(r.escalations).toEqual([]);
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunRun', 37796107550]]); // the run is read before it is re-run
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-requested', reruns: 1 });
    // …and once re-run, nothing further happens
    f.calls.length = 0;
    sweepHungJobs({ ...base, listPrs, now: () => T0 + 101 * MIN });
    expect(f.calls).toEqual([]);
  });

  it('escalates a refused rerun after cancellation completes', async () => {
    const { sweepHungJobs, readHungState, f, base, cancelled } = await cancelledSetup({
      rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); throw new Error('HTTP 403: Resource not accessible by integration'); },
    });
    const listPrs = () => [pr([cancelled])];
    sweepHungJobs({ ...base, listPrs, now: () => T0 + 97 * MIN });
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-failed', reruns: 0 });
    f.calls.length = 0;
    f.lines.length = 0;
    const r1 = sweepHungJobs({ ...base, listPrs, now: () => T0 + 99 * MIN });
    expect(f.calls.filter(([c]) => c !== 'getRun')).toEqual([]); // a real refusal is never retried (only the run is read)
    expect(r1.escalations).toEqual([expect.objectContaining({ pr: 4450, name: 'daemon-soak' })]);
    const esc = (lines) => lines.filter((l) => l.startsWith('ci-job-hung: ESCALATE '));
    expect(esc(f.lines)).toHaveLength(1);
    // logged on EVERY sweep while stranded, with a line that differs each time (the daemon log folds identical lines)
    f.lines.length = 0;
    sweepHungJobs({ ...base, listPrs, now: () => T0 + 104 * MIN });
    expect(esc(f.lines)).toHaveLength(1);
    const body = (l) => JSON.parse(l.slice('ci-job-hung: ESCALATE '.length));
    expect(body(esc(f.lines)[0]).inProgressMin).toBe(104);
    expect(body(esc(f.lines)[0])).toMatchObject({ repo: 'web-everything/web-everything', pr: 4450, check: 'daemon-soak', runId: 37796107550, jobId: 113380540047, thresholdMin: 30, reruns: 0 });
  });

  it('the stranded-recovery ESCALATE line is accepted by the ci-job-hung smell (the two validators agree)', async () => {
    const { default: ciJobHung } = await import('../health-smells/ci-job-hung.mjs');
    const { sweepHungJobs, f, base, cancelled } = await cancelledSetup({
      rerunRun: () => () => { throw new Error('HTTP 403: Resource not accessible by integration'); },
    });
    const listPrs = () => [pr([cancelled])];
    sweepHungJobs({ ...base, listPrs, now: () => T0 + 97 * MIN });
    sweepHungJobs({ ...base, listPrs, now: () => T0 + 99 * MIN });
    const out = ciJobHung.evaluate({ daemonLogs: [{ name: 'ci-queue-watch', text: f.lines.join('\n') }] });
    expect(out).toEqual([expect.objectContaining({ subject: 'web-everything/web-everything#4450:daemon-soak', breach: true })]);
  });

  it('stops driving a cancelled recovery once its PR is gone, moved to a new head, or the check passed', async () => {
    for (const next of [
      [], // PR closed / merged
      [pr([{ ...phantom(), status: 'COMPLETED', conclusion: 'CANCELLED' }], 4450, 'newhead')], // force-pushed
    ]) {
      rmSync(statePath, { force: true });
      const { sweepHungJobs, f, base, cancelled } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); throw new Error(THROTTLED); } });
      sweepHungJobs({ ...base, listPrs: () => [pr([cancelled])], now: () => T0 + 97 * MIN }); // defers
      f.calls.length = 0;
      f.lines.length = 0;
      const r = sweepHungJobs({ ...base, listPrs: () => next, now: () => T0 + 99 * MIN });
      expect(f.calls).toEqual([]);
      expect(r.escalations).toEqual([]);
    }
    // a pending cancel-requested entry is not re-run for a PR that is gone either
    rmSync(statePath, { force: true });
    const { sweepHungJobs, f, base } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); } });
    // setup already cancelled; the run completed — but the PR is no longer open
    sweepHungJobs({ ...base, listPrs: () => [], now: () => T0 + 97 * MIN });
    expect(f.calls).toEqual([]);
  });

  // Review finding: the cancel kills the WHOLE run, so a later job-only re-run left cancelled siblings blocking the PR.
  it('re-runs the whole run (not just the hung job) after cancelling a multi-job run', async () => {
    const { sweepHungJobs, f, base, cancelled } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); } });
    const sibling = { name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: url(37796107550, 555), startedAt: new Date(T0).toISOString() };
    sweepHungJobs({ ...base, listPrs: () => [pr([cancelled, sibling])], now: () => T0 + 97 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunRun', 37796107550]]);
    expect(f.calls.some(([c]) => c === 'rerunJob')).toBe(false);
  });

  // Review finding (security): never write against a run or job the PR does not own.
  it('refuses any write when the run belongs to a different head', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    f.getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { status: 'in_progress', head_sha: 'someone-elses-release-sha' }; };
    const live = { ...phantom(), conclusion: null, completedAt: null };
    const r = sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([live])], now: () => T0 + 95 * MIN, ...f });
    expect(f.calls).toEqual([['getRun', 37796107550]]);
    expect(r.actions).toEqual([]);
    expect(readHungState(statePath).hung).toEqual({});
    expect(f.lines.join('\n')).toMatch(/ci-job-hung: REFUSED/);
  });

  it('refuses a run read that carries no head_sha (fail closed)', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    f.getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { status: 'completed' }; };
    const r = sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, ...f });
    expect(f.calls).toEqual([['getRun', 37796107550]]);
    expect(r.actions).toEqual([]);
  });

  it('refuses a job re-run when the job id belongs to a different run than the details URL names', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    f.getJob = ({ jobId }) => { f.calls.push(['getJob', jobId]); return { id: jobId, run_id: 999, name: 'daemon-soak' }; }; // e.g. a deploy workflow's job
    const r = sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, ...f });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047]]);
    expect(r.actions).toEqual([]);
    expect(readHungState(statePath).hung).toEqual({});
    expect(f.lines.join('\n')).toMatch(/ci-job-hung: REFUSED/);
  });

  // Review (re-review of the repair): the CANCEL path writes by run id too, so the job must be tied to the run and to
  // the check by name there as well — a third-party check may point its details URL at any real job of the same head.
  it.each([
    ['belongs to a different run', { run_id: 999, name: 'daemon-soak' }],
    ['carries a different name than the check', { run_id: 37796107550, name: 'release-deploy' }],
    ['has no name at all', { run_id: 37796107550 }],
  ])('refuses to CANCEL a running run when the named job %s', async (_label, job) => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    f.getJob = ({ jobId }) => { f.calls.push(['getJob', jobId]); return { id: jobId, ...job }; };
    const live = { ...phantom(), conclusion: null, completedAt: null };
    const r = sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([live])], now: () => T0 + 95 * MIN, ...f });
    expect(f.calls).toEqual([['getRun', 37796107550], ['getJob', 113380540047]]);
    expect(r.actions).toEqual([]);
    expect(readHungState(statePath).hung).toEqual({});
  });

  // A check NAME is an attacker-chosen string used as a key: `constructor` / `__proto__` / `toString` resolved to
  // Object's own members and made `list.some` throw at the top of the sweep, stopping recovery for the whole repo.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('a successful check named %s neither throws nor poisons the learned durations', async (name) => {
    const { learnDurations, sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const prs = [pr([done(name, 1, 60), done('test', 2, 90)])];
    const d = learnDurations({}, prs);
    expect(Object.getOwnPropertyDescriptor(d, name)?.value).toEqual([{ jobId: 1, sec: 60 }]);
    expect(d.test).toEqual([{ jobId: 2, sec: 90 }]);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    const f = fakes('completed');
    expect(() => sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([done(name, 1, 60), phantom()])], now: () => T0 + 95 * MIN, ...f })).not.toThrow();
    expect(f.calls.some(([c]) => c === 'rerunJob')).toBe(true); // recovery for the real hung job still ran
    expect(Object.keys(readHungState(statePath).durations)).toContain(name);
  });

  it('caps how many distinct check names are learned', async () => {
    const { learnDurations, MAX_DURATION_NAMES } = await import('../ci-queue-watch.mjs');
    const checks = Array.from({ length: MAX_DURATION_NAMES + 25 }, (_, i) => done(`job-${i}`, 1000 + i, 60));
    expect(Object.keys(learnDurations({}, [pr(checks)]))).toHaveLength(MAX_DURATION_NAMES);
  });

  it('canonicalises --repo (a key or a legacy form) before it anchors the details-URL check', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const r = sweepHungJobs({ repo: 'we', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, ...f });
    expect(r.hung).toHaveLength(1);
  });

  // Truncated read: `gh pr list --limit 100` — a PR missing from a FULL page is unknown, not closed.
  it('does not mistake a PR missing from a full 100-PR page for a closed one', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const { f, base } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); } });
    const fullPage = Array.from({ length: 100 }, (_, i) => pr([], 9000 + i, `${i}`.padStart(7, 'a')));
    sweepHungJobs({ ...base, listPrs: () => fullPage, now: () => T0 + 97 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunRun', 37796107550]]);
  });

  // A cancel the job outran must not re-run a run that FINISHED SUCCESSFULLY: the whole run is healthy.
  it('does not re-run the whole run when the run in fact finished successfully after the cancel', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const { f, base, cancelled } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); } });
    const getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { status: 'completed', conclusion: 'success', head_sha: 'db9f116' }; };
    sweepHungJobs({ ...base, getRun, listPrs: () => [pr([{ ...cancelled, conclusion: 'SUCCESS' }])], now: () => T0 + 97 * MIN });
    expect(f.calls.filter(([c]) => c.startsWith('rerun'))).toEqual([]);
    expect(Object.values(readHungState(statePath).hung)[0].stage).toBe('cancel-outran');
  });

  // Review finding (codex, CONFIRMED): the watched job being green says nothing about the siblings the whole-run
  // cancel killed — only the RUN's own conclusion does.
  it('restores cancelled siblings when the watched job finishes green', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const { f, base, cancelled } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); } });
    const getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { status: 'completed', conclusion: 'cancelled', head_sha: 'db9f116' }; };
    const sibling = { name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: url(37796107550, 555), startedAt: new Date(T0).toISOString() };
    sweepHungJobs({ ...base, getRun, listPrs: () => [pr([{ ...cancelled, conclusion: 'SUCCESS' }, sibling])], now: () => T0 + 97 * MIN });
    expect(f.calls.filter(([c]) => c.startsWith('rerun'))).toEqual([['rerunRun', 37796107550]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-requested', reruns: 1 });
  });

  it('retries a deferred whole-run re-run even though the watched job is green and only a sibling stays cancelled', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    let throttle = true;
    const { f, base, cancelled } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); if (throttle) throw new Error(THROTTLED); } });
    const getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { status: 'completed', conclusion: 'cancelled', head_sha: 'db9f116' }; };
    const green = { ...cancelled, conclusion: 'SUCCESS' };
    sweepHungJobs({ ...base, getRun, listPrs: () => [pr([green])], now: () => T0 + 97 * MIN });
    expect(Object.values(readHungState(statePath).hung)[0].stage).toBe('rerun-deferred');
    throttle = false;
    f.calls.length = 0;
    sweepHungJobs({ ...base, getRun, listPrs: () => [pr([green])], now: () => T0 + 99 * MIN });
    expect(f.calls.filter(([c]) => c.startsWith('rerun'))).toEqual([['rerunRun', 37796107550]]);
  });

  it('a deferred cancel-origin recovery that the lagging snapshot still shows in_progress is retried as a WHOLE-run re-run', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    let throttle = true;
    const { f, base, cancelled } = await cancelledSetup({ rerunRun: (fk) => ({ runId }) => { fk.calls.push(['rerunRun', runId]); if (throttle) throw new Error(THROTTLED); } });
    sweepHungJobs({ ...base, listPrs: () => [pr([cancelled])], now: () => T0 + 97 * MIN }); // → rerun-deferred
    throttle = false;
    f.calls.length = 0;
    const stale = { ...cancelled, status: 'IN_PROGRESS', conclusion: null };
    sweepHungJobs({ ...base, listPrs: () => [pr([stale])], now: () => T0 + 99 * MIN });
    expect(f.calls.some(([c]) => c === 'rerunJob')).toBe(false);
    expect(f.calls.some(([c]) => c === 'rerunRun')).toBe(true);
  });

  it('the stranded-recovery alert says the re-run was refused after a cancel, not that a job "hung again"', async () => {
    const { default: ciJobHung } = await import('../health-smells/ci-job-hung.mjs');
    const { sweepHungJobs, f, base, cancelled } = await cancelledSetup({ rerunRun: () => () => { throw new Error('HTTP 403: Resource not accessible by integration'); } });
    sweepHungJobs({ ...base, listPrs: () => [pr([cancelled])], now: () => T0 + 97 * MIN });
    sweepHungJobs({ ...base, listPrs: () => [pr([cancelled])], now: () => T0 + 99 * MIN });
    const [alert] = ciJobHung.evaluate({ daemonLogs: [{ name: 'ci-queue-watch', text: f.lines.join('\n') }] });
    expect(alert.summary).toMatch(/re-run was refused after it was cancelled/);
    expect(alert.summary).not.toMatch(/hung again/);
    expect(alert.recommendation).not.toMatch(/automatic re-run did not clear it/);
  });

  // ── force-cancel outcomes (review findings, codex + correctness) ──────────────────────────────────────────────
  const escLines = (lines) => lines.filter((l) => l.startsWith('ci-job-hung: ESCALATE ')).map((l) => JSON.parse(l.slice('ci-job-hung: ESCALATE '.length)));
  const writesOf = (calls) => calls.filter(([c]) => /^(cancelRun|forceCancelRun|rerunJob|rerunRun)$/.test(c)).map(([c]) => c);
  const stuckRun = () => ({ ...phantom(), conclusion: null, completedAt: null });

  it('escalates a permanent force-cancel refusal without retrying the write', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    f.forceCancelRun = ({ runId }) => { f.calls.push(['forceCancelRun', runId]); throw new Error('HTTP 403: Resource not accessible by integration'); };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], ...f };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    f.calls.length = 0;
    f.lines.length = 0;
    const r = sweepHungJobs({ ...base, now: () => T0 + 105 * MIN });
    expect(writesOf(f.calls)).toEqual(['forceCancelRun']);
    expect(escLines(f.lines)).toEqual([expect.objectContaining({ check: 'daemon-soak', reason: 'force-cancel-refused' })]); // exactly one
    expect(r.escalations).toHaveLength(1);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'cancel-requested', forceCancelRefusedAt: expect.any(String) });
    // every later sweep: no write is re-sent, and it escalates again (one line, minutes growing)
    f.calls.length = 0;
    f.lines.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 110 * MIN });
    expect(writesOf(f.calls)).toEqual([]);
    const again = escLines(f.lines);
    expect(again).toEqual([expect.objectContaining({ reason: 'force-cancel-refused' })]);
    expect(again[0].inProgressMin).toBe(110);
  });

  it('retries a transient (throttled) force-cancel failure instead of escalating it', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    let throttle = true;
    f.forceCancelRun = ({ runId }) => { f.calls.push(['forceCancelRun', runId]); if (throttle) throw new Error(THROTTLED); };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], ...f };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    f.lines.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 105 * MIN });
    expect(escLines(f.lines)).toEqual([]);
    throttle = false;
    f.calls.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 106 * MIN });
    expect(writesOf(f.calls)).toEqual(['forceCancelRun']);
    expect(Object.values(readHungState(statePath).hung)[0].forceCancelledAt).toEqual(expect.any(String));
  });

  it('escalates a run that is still not complete a grace window after the force-cancel', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], ...f };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    sweepHungJobs({ ...base, now: () => T0 + 105 * MIN }); // force-cancel
    f.calls.length = 0;
    f.lines.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 107 * MIN }); // inside the second grace window: just wait
    expect(escLines(f.lines)).toEqual([]);
    expect(writesOf(f.calls)).toEqual([]);
    sweepHungJobs({ ...base, now: () => T0 + 111 * MIN });
    expect(escLines(f.lines)).toEqual([expect.objectContaining({ reason: 'cancel-did-not-take', inProgressMin: 111 })]);
    f.lines.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 115 * MIN });
    expect(escLines(f.lines)).toEqual([expect.objectContaining({ reason: 'cancel-did-not-take', inProgressMin: 115 })]);
    expect(writesOf(f.calls)).toEqual([]);
  });

  it('names a refused initial cancel and a refused direct re-run in the escalation, not "hung again"', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const refuse = () => { throw new Error('HTTP 403: Resource not accessible by integration'); };
    {
      const f = fakes('in_progress');
      f.cancelRun = ({ runId }) => { f.calls.push(['cancelRun', runId]); refuse(); };
      const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], ...f };
      sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
      f.lines.length = 0;
      sweepHungJobs({ ...base, now: () => T0 + 100 * MIN });
      expect(escLines(f.lines)).toEqual([expect.objectContaining({ reason: 'cancel-refused' })]);
    }
    rmSync(statePath, { force: true });
    {
      const f = fakes('completed');
      f.rerunJob = ({ jobId }) => { f.calls.push(['rerunJob', jobId]); refuse(); };
      f.rerunRun = ({ runId }) => { f.calls.push(['rerunRun', runId]); refuse(); };
      const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], ...f };
      sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
      f.lines.length = 0;
      sweepHungJobs({ ...base, now: () => T0 + 100 * MIN });
      expect(escLines(f.lines)).toEqual([expect.objectContaining({ reason: 'rerun-refused' })]);
    }
  });

  // Self-review findings: the same defect class one step over.
  it('an interrupted job→run re-run fallback leaves the ledger retryable, never "handled"', async () => {
    const { sweepHungJobs, readHungState, planHungActions, hungKey } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    f.rerunJob = ({ jobId }) => { f.calls.push(['rerunJob', jobId]); throw new Error('HTTP 403: Resource not accessible by integration'); };
    let onDisk;
    f.rerunRun = ({ runId }) => { f.calls.push(['rerunRun', runId]); onDisk = Object.values(readHungState(statePath).hung)[0]; }; // the fallback, right after the refusal
    sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, ...f });
    expect(onDisk).toMatchObject({ stage: 'rerun-job-refused', reruns: 0 });
    const h = { pr: 4450, headSha: 'db9f116', name: 'daemon-soak', runId: 1, jobId: 10 };
    expect(planHungActions([h], { [hungKey(h)]: onDisk && { ...onDisk, jobIds: [10] } }, { maxReruns: 1 })[0].action).toBe('recover');
  });

  it('a force-cancel that lost the race to the run finishing is no refusal: nothing latched, nothing escalated', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    let status = 'in_progress';
    const f = fakes(() => status);
    f.forceCancelRun = ({ runId }) => { f.calls.push(['forceCancelRun', runId]); status = 'completed'; throw new Error('HTTP 409: Cannot cancel a workflow run that is completed.'); };
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], ...f };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    f.lines.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 105 * MIN });
    expect(escLines(f.lines)).toEqual([]);
    expect(Object.values(readHungState(statePath).hung)[0].forceCancelRefusedAt).toBeUndefined();
    f.calls.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 106 * MIN }); // the run is completed now: the whole run is re-run
    expect(writesOf(f.calls)).toEqual(['rerunRun']);
  });

  it('a run the ledger cannot read is never silent: permanent → ESCALATE run-unreadable, transient → DEFERRED and retried', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], ...f };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN }); // cancel
    f.getRun = ({ runId }) => { f.calls.push(['getRun', runId]); throw new Error(THROTTLED); };
    f.lines.length = 0;
    sweepHungJobs({ ...base, getRun: f.getRun, now: () => T0 + 97 * MIN });
    expect(escLines(f.lines)).toEqual([]);
    expect(f.lines.join('\n')).toMatch(/ci-job-hung: DEFERRED .*run status unreadable/);
    f.lines.length = 0;
    const gone = ({ runId }) => { f.calls.push(['getRun', runId]); throw new Error('HTTP 404: Not Found'); };
    const r = sweepHungJobs({ ...base, getRun: gone, now: () => T0 + 99 * MIN });
    expect(escLines(f.lines)).toEqual([expect.objectContaining({ reason: 'run-unreadable' })]);
    expect(r.escalations).toHaveLength(1);
  });

  it('a ledger that cannot be parsed is set aside loudly, not silently overwritten', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    writeFileSync(statePath, '{"durations": {"soak": [');
    const f = fakes('completed');
    sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, ...f });
    const reset = f.lines.find((l) => l.startsWith('ci-job-hung: LEDGER-RESET '));
    expect(reset).toBeTruthy();
    const { aside } = JSON.parse(reset.slice('ci-job-hung: LEDGER-RESET '.length));
    expect(readFileSync(aside, 'utf8')).toBe('{"durations": {"soak": [');
  });

  // The state machine, exhaustively: for every ledger stage the next sweep either ACTS (exactly these writes), WAITS
  // (no write, no escalation) or ESCALATES (exactly one ESCALATE line, with its reason, and no write).
  describe('ledger stage table', () => {
    const iso = (min) => new Date(T0 + min * MIN).toISOString();
    const entryAt = (over) => ({
      pr: 4450, headSha: 'db9f116', name: 'daemon-soak', runId: 37796107550, jobIds: [113380540047], reruns: 0,
      startedAt: iso(0), detectedAt: iso(95), thresholdSec: 1800, updatedAt: iso(95), actions: [], ...over,
    });
    const lagging = () => stuckRun(); // GitHub still reports the check in_progress
    const cancelled = () => ({ ...phantom(), status: 'COMPLETED', conclusion: 'CANCELLED' });
    const rows = [
      // [label, ledger entry, run, check, minute, expected writes, expected escalation reason | null]
      ['cancel-requested, inside the grace window → waits', { stage: 'cancel-requested', cancelRequestedAt: iso(95) }, { status: 'in_progress' }, lagging, 97, [], null],
      ['cancel-requested, grace window passed → force-cancels', { stage: 'cancel-requested', cancelRequestedAt: iso(95) }, { status: 'in_progress' }, lagging, 105, ['forceCancelRun'], null],
      ['force-cancelled, inside the second grace window → waits', { stage: 'cancel-requested', cancelRequestedAt: iso(95), forceCancelledAt: iso(100) }, { status: 'in_progress' }, lagging, 103, [], null],
      ['force-cancelled, second grace window passed → escalates', { stage: 'cancel-requested', cancelRequestedAt: iso(95), forceCancelledAt: iso(100) }, { status: 'in_progress' }, lagging, 106, [], 'cancel-did-not-take'],
      ['force-cancel refused → escalates, never re-sent', { stage: 'cancel-requested', cancelRequestedAt: iso(95), forceCancelRefusedAt: iso(100) }, { status: 'in_progress' }, lagging, 106, [], 'force-cancel-refused'],
      ['cancel-requested, run cancelled → re-runs the whole run', { stage: 'cancel-requested', cancelRequestedAt: iso(95) }, { status: 'completed', conclusion: 'cancelled' }, cancelled, 97, ['rerunRun'], null],
      ['cancel-requested, run succeeded → resolved, no write', { stage: 'cancel-requested', cancelRequestedAt: iso(95) }, { status: 'completed', conclusion: 'success' }, cancelled, 97, [], null],
      ['rerun-deferred, run still cancelled → retries the whole run', { stage: 'rerun-deferred', cancelRequestedAt: iso(95), actions: [{ ok: false, error: THROTTLED }] }, { status: 'completed', conclusion: 'cancelled' }, cancelled, 99, ['rerunRun'], null],
      ['rerun-failed (refused), run still cancelled → escalates', { stage: 'rerun-failed', cancelRequestedAt: iso(95), actions: [{ ok: false, error: 'HTTP 403: nope' }] }, { status: 'completed', conclusion: 'cancelled' }, cancelled, 99, [], 'rerun-refused-after-cancel'],
      ['rerun-failed (refused), snapshot still in_progress → escalates ONCE', { stage: 'rerun-failed', cancelRequestedAt: iso(95), actions: [{ ok: false, error: 'HTTP 403: nope' }] }, { status: 'completed', conclusion: 'cancelled' }, lagging, 99, [], 'rerun-refused-after-cancel'],
      ['rerun-requested, run re-running → waits', { stage: 'rerun-requested', cancelRequestedAt: iso(95), reruns: 1 }, { status: 'in_progress' }, lagging, 99, [], null],
      ['cancel-outran → nothing', { stage: 'cancel-outran', cancelRequestedAt: iso(95) }, { status: 'completed', conclusion: 'success' }, cancelled, 99, [], null],
      ['cancel-failed (refused) → escalates (cancel-refused)', { stage: 'cancel-failed', actions: [{ ok: false, error: 'HTTP 403: nope' }] }, { status: 'in_progress' }, lagging, 99, [], 'cancel-refused'],
      ['cancel-deferred (throttled) → cancels again', { stage: 'cancel-deferred', actions: [{ ok: false, error: THROTTLED }] }, { status: 'in_progress' }, lagging, 99, ['cancelRun'], null],
    ];
    it.each(rows)('%s', async (_label, over, run, check, minute, writes, reason) => {
      const { sweepHungJobs, hungKey } = await import('../ci-queue-watch.mjs');
      const e = entryAt(over);
      writeFileSync(statePath, JSON.stringify({ durations: {}, hung: { [hungKey({ pr: e.pr, headSha: e.headSha, name: e.name })]: e } }));
      const f = fakes(run.status);
      f.getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { event: 'pull_request', path: '.github/workflows/ci.yml', run_attempt: 1, ...run, head_sha: 'db9f116' }; };
      const r = sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([check()])], now: () => T0 + minute * MIN, ...f });
      expect(writesOf(f.calls)).toEqual(writes);
      expect(escLines(f.lines).map((x) => x.reason)).toEqual(reason ? [reason] : []);
      expect(r.escalations).toHaveLength(reason ? 1 : 0);
    });
  });

  // ── the ledger lock (review finding): gh calls run inside it, so it must outlive a slow call and never be
  //    shared with an overlapping sweep ───────────────────────────────────────────────────────────────────────
  describe('the hung sweep ledger lock', () => {
    it('skips (makes no write) while another sweep holds a live lock, instead of running unlocked', async () => {
      const { sweepHungJobs, withHistoryLock } = await import('../ci-queue-watch.mjs');
      const f = fakes('completed');
      const opts = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, lock: { staleMs: 5000, timeoutMs: 30 }, ...f };
      let inner;
      withHistoryLock(statePath, () => { inner = sweepHungJobs(opts); }, { staleMs: 5000 });
      expect(inner).toMatchObject({ skipped: 'lock-held', actions: [] });
      expect(f.calls).toEqual([]);
      expect(f.lines.join('\n')).toMatch(/ci-job-hung: SKIPPED/);
    });

    it('a sweep whose lock was taken over mid-sweep stops without writing, and the other sweep acts exactly once', async () => {
      const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
      const { sleepSyncMs } = await import('../../readiness/drain-lock.mjs');
      const lock = { staleMs: 40, timeoutMs: 400 };
      const common = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, lock };
      const fB = fakes('completed');
      let resB;
      const fA = fakes('completed');
      // sweep A's first gh read outlives the lock's staleness window; sweep B (an operator's hand-run `hung`) starts then
      fA.getRun = ({ runId }) => {
        fA.calls.push(['getRun', runId]);
        sleepSyncMs(120);
        resB = sweepHungJobs({ ...common, ...fB });
        return { status: 'completed', head_sha: 'db9f116' };
      };
      const rA = sweepHungJobs({ ...common, ...fA });
      expect(resB.actions).toEqual([expect.objectContaining({ action: 'rerun-job', ok: true })]);
      expect(rA).toMatchObject({ skipped: 'lock-lost', actions: [] });
      expect(writesOf(fA.calls)).toEqual([]);
      expect(fA.lines.join('\n')).toMatch(/ci-job-hung: ABORTED/);
      expect(writesOf(fB.calls)).toEqual(['rerunJob']);
      expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ reruns: 1, stage: 'rerun-requested' });
    });

    it('a cancel is in the ledger the moment it is sent, not only when the sweep ends', async () => {
      const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
      const f = fakes('in_progress');
      // what a process that died right after the cancel would leave on disk: read it back at the moment the cancel
      // is logged, long before the sweep's own final write
      let onDisk;
      f.log = (l) => { f.lines.push(l); if (l.startsWith('ci-job-hung: RECOVER')) onDisk = Object.values(readHungState(statePath).hung)[0]; };
      sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([stuckRun()])], now: () => T0 + 95 * MIN, ...f });
      expect(writesOf(f.calls)).toEqual(['cancelRun']);
      expect(onDisk).toMatchObject({ stage: 'cancel-requested', cancelRequestedAt: expect.any(String) });
    });
  });

  it('apply:false reports the plan with no GitHub writes', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const r = sweepHungJobs({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN, apply: false, ...f });
    expect(r.hung).toEqual([expect.objectContaining({ jobId: 113380540047, action: 'recover' })]);
    expect(f.calls.filter(([c]) => c !== 'getRun')).toEqual([]);
  });

  it('learns durations across sweeps into the persisted state', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 60, maxReruns: 1, ...f };
    sweepHungJobs({ ...base, listPrs: () => [pr(Array.from({ length: 10 }, (_, i) => done('soak', 100 + i, 600)))], now: () => T0 });
    expect(readHungState(statePath).durations.soak).toHaveLength(10);
    // 25 min in progress: past the 60 s floor but under 3 × p95 (30 min) — not hung
    const running = { name: 'soak', workflowName: 'CI', status: 'IN_PROGRESS', detailsUrl: url(5, 500), startedAt: new Date(T0).toISOString() };
    const r = sweepHungJobs({ ...base, listPrs: () => [pr([running])], now: () => T0 + 25 * MIN });
    expect(r.hung).toEqual([]);
  });

  // ── review round 3 (fix-4479): five findings ────────────────────────────────────────────────────────────
  const RUN = 37796107550;
  const siblingCheck = () => ({ ...stuckRun(), name: 'test', detailsUrl: url(RUN, 113380540048) });
  const jobsOf = ({ jobId }) => ({ id: jobId, run_id: RUN, name: jobId === 113380540047 ? 'daemon-soak' : 'test' });
  /** A run whose status / conclusion / attempt the test drives; every call is logged on `f.calls`. */
  const drivenRun = (f, state, extra = {}) => ({ runId }) => {
    f.calls.push(['getRun', runId]);
    return { status: state.status, conclusion: state.conclusion, head_sha: 'db9f116', event: 'pull_request', path: '.github/workflows/ci.yml', run_attempt: state.attempt ?? 1, ...extra };
  };
  const sharedBase = (f) => ({ repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, ...f });

  it('recovers two hung checks sharing one run without cancelling the recovery', async () => {
    const { sweepHungJobs, readHungState, CANCEL_GRACE_MS } = await import('../ci-queue-watch.mjs');
    const state = { status: 'in_progress', conclusion: null, attempt: 1 };
    const f = fakes();
    f.getRun = drivenRun(f, state);
    f.getJob = jobsOf;
    const base = sharedBase(f);
    // sweep 1: BOTH checks are past their threshold in the same run → ONE cancel for the run, the second rides on it
    sweepHungJobs({ ...base, listPrs: () => [pr([stuckRun(), siblingCheck()])], now: () => T0 + 95 * MIN });
    expect(writesOf(f.calls)).toEqual(['cancelRun']);
    // the cancel lands: the run completed cancelled → ONE whole-run re-run
    f.calls.length = 0;
    state.status = 'completed'; state.conclusion = 'cancelled';
    const cancelled = [{ ...stuckRun(), status: 'COMPLETED', conclusion: 'CANCELLED' }, { ...siblingCheck(), status: 'COMPLETED', conclusion: 'CANCELLED' }];
    sweepHungJobs({ ...base, listPrs: () => [pr(cancelled)], now: () => T0 + 97 * MIN });
    expect(writesOf(f.calls)).toEqual(['rerunRun']);
    // the re-run attempt is still running past the cancel grace window: it must NOT be force-cancelled or re-run
    f.calls.length = 0;
    state.status = 'in_progress'; state.conclusion = null; state.attempt = 2;
    const rerunning = [{ ...stuckRun(), startedAt: new Date(T0 + 97 * MIN).toISOString() }, { ...siblingCheck(), startedAt: new Date(T0 + 97 * MIN).toISOString() }]
      .map((c, i) => ({ ...c, detailsUrl: url(RUN, 113380540100 + i) }));
    for (const minute of [98, 98 + CANCEL_GRACE_MS / MIN + 1, 98 + 2 * CANCEL_GRACE_MS / MIN + 2]) {
      sweepHungJobs({ ...base, listPrs: () => [pr(rerunning)], now: () => T0 + minute * MIN });
    }
    expect(writesOf(f.calls)).toEqual([]);
    expect(escLines(f.lines)).toEqual([]);
    // both checks spent their one re-run on that single whole-run re-run
    expect(Object.values(readHungState(statePath).hung).map((e) => e.reruns)).toEqual([1, 1]);
  });

  it('a hung check that crosses its threshold a sweep AFTER its sibling cancelled the run rides on that cancel', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const state = { status: 'in_progress', conclusion: null };
    const f = fakes();
    f.getRun = drivenRun(f, state);
    f.getJob = jobsOf;
    const base = sharedBase(f);
    const late = () => ({ ...siblingCheck(), startedAt: new Date(T0 + 80 * MIN).toISOString() });
    sweepHungJobs({ ...base, listPrs: () => [pr([stuckRun(), late()])], now: () => T0 + 95 * MIN });
    expect(writesOf(f.calls)).toEqual(['cancelRun']); // the sibling is only 15 min in: not hung yet
    f.calls.length = 0;
    // 32 min in now → hung, but its run is already being recovered: no second cancel (the owner's cancel has not
    // taken in all that time, so the OWNER is force-cancelled — that is its own, unchanged, recovery)
    sweepHungJobs({ ...base, listPrs: () => [pr([stuckRun(), late()])], now: () => T0 + 112 * MIN });
    expect(writesOf(f.calls)).not.toContain('cancelRun');
    expect(Object.values(readHungState(statePath).hung).find((e) => e.name === 'test')).toMatchObject({ stage: 'covered-by-sibling' });
  });

  it('two hung checks of one run that already COMPLETED are recovered by one whole-run re-run, not a job re-run each', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    f.getJob = jobsOf;
    sweepHungJobs({ ...sharedBase(f), listPrs: () => [pr([phantom(), { ...phantom(113380540048), name: 'test' }])], now: () => T0 + 95 * MIN });
    expect(writesOf(f.calls)).toEqual(['rerunRun']);
  });

  it('never force-cancels a run that has a NEWER attempt than the one it cancelled (someone re-ran it)', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    const state = { status: 'in_progress', conclusion: null, attempt: 1 };
    const f = fakes();
    f.getRun = drivenRun(f, state);
    const base = { ...sharedBase(f), listPrs: () => [pr([stuckRun()])] };
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    expect(writesOf(f.calls)).toEqual(['cancelRun']);
    f.calls.length = 0;
    state.attempt = 2; // a person re-ran the cancelled run; it is running again, past the grace window
    sweepHungJobs({ ...base, now: () => T0 + 110 * MIN });
    expect(writesOf(f.calls)).toEqual([]);
  });

  it('a first cancel that lost the race to the run finishing (409) is no refusal: the completed run is re-run, nothing escalates', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    let status = 'in_progress';
    const f = fakes(() => status);
    f.cancelRun = ({ runId }) => { f.calls.push(['cancelRun', runId]); status = 'completed'; throw new Error('HTTP 409: Cannot cancel a workflow run that is completed.'); };
    sweepHungJobs({ ...sharedBase(f), listPrs: () => [pr([stuckRun()])], now: () => T0 + 95 * MIN });
    expect(writesOf(f.calls)).toEqual(['cancelRun', 'rerunJob']);
    expect(escLines(f.lines)).toEqual([]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-requested', reruns: 1 });
    // a refusal while the run really IS still running stays a refusal
    status = 'in_progress';
    const g = fakes(() => status);
    g.cancelRun = ({ runId }) => { g.calls.push(['cancelRun', runId]); throw new Error('HTTP 403: Resource not accessible by integration'); };
    const other = { ...stuckRun(), name: 'daemon-soak', detailsUrl: url(RUN, 113380540047) };
    sweepHungJobs({ ...sharedBase(g), statePath: `${statePath}.b`, listPrs: () => [pr([other], 4451)], now: () => T0 + 95 * MIN });
    expect(Object.values(readHungState(`${statePath}.b`).hung)[0].stage).toBe('cancel-failed');
  });

  // Adversarial self-review of the repair (round 3): the four holes it found.
  it('a 409 on the first cancel whose run cannot be re-read is DEFERRED (retried), never latched as a permanent refusal', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    let readable = true;
    const state = { status: 'in_progress', conclusion: null };
    const f = fakes();
    const read = drivenRun(f, state);
    f.getRun = (a) => { const r = read(a); if (!readable && f.calls.filter(([c]) => c === 'cancelRun').length) throw new Error('HTTP 503: Service Unavailable'); return r; };
    f.cancelRun = ({ runId }) => { f.calls.push(['cancelRun', runId]); throw new Error('HTTP 409: Conflict'); };
    const base = { ...sharedBase(f), listPrs: () => [pr([stuckRun()])] };
    readable = false;
    sweepHungJobs({ ...base, now: () => T0 + 95 * MIN });
    expect(Object.values(readHungState(statePath).hung)[0].stage).toBe('cancel-deferred');
    expect(escLines(f.lines)).toEqual([]);
    // next sweep: the run reads fine and is still running → the cancel is tried again (not 'handled' forever)
    readable = true;
    f.calls.length = 0;
    sweepHungJobs({ ...base, now: () => T0 + 96 * MIN });
    expect(writesOf(f.calls)).toEqual(['cancelRun']);
  });

  it("GitHub's own 'cannot cancel a run that is completed' settles a lost race even when the re-read still looks in progress", async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('in_progress'); // a stale / lagging read: the run still reads in_progress
    f.cancelRun = ({ runId }) => { f.calls.push(['cancelRun', runId]); throw new Error('HTTP 409: Cannot cancel a workflow run that is completed.'); };
    sweepHungJobs({ ...sharedBase(f), listPrs: () => [pr([stuckRun()])], now: () => T0 + 95 * MIN });
    expect(writesOf(f.calls)).toEqual(['cancelRun', 'rerunJob']);
    expect(Object.values(readHungState(statePath).hung)[0].stage).toBe('rerun-requested');
  });

  describe('a run re-run by someone else, and attempt-based coverage', () => {
    const ownerKey = '4450@db9f116:daemon-soak';
    const followerKey = '4450@db9f116:test';
    const seed = (extra = {}) => writeFileSync(statePath, JSON.stringify({ durations: {}, hung: {
      [ownerKey]: { pr: 4450, headSha: 'db9f116', name: 'daemon-soak', runId: RUN, reruns: 0, jobIds: [1], stage: 'cancel-outran', runAttempt: 1, wholeRunAt: new Date(T0 + 94 * MIN).toISOString(), wholeRunAttempt: 1, updatedAt: new Date(T0 + 94 * MIN).toISOString(), ...extra },
      [followerKey]: { pr: 4450, headSha: 'db9f116', name: 'test', runId: RUN, reruns: 0, jobIds: [2], stage: 'covered-by-sibling', coveredBy: ownerKey, updatedAt: new Date(T0 + 94 * MIN).toISOString() },
    } }));
    const attempt2Jobs = ({ jobId }) => ({ id: jobId, run_id: RUN, name: jobId === 113380540047 ? 'daemon-soak' : jobId === 113380540048 ? 'test' : 'lint', run_attempt: 2 });
    const hungInAttempt2 = (name, job) => ({ ...stuckRun(), name, detailsUrl: url(RUN, job), startedAt: new Date(T0 + 60 * MIN).toISOString() });

    it('a run re-run by a person budgets the followers too: their new hang escalates, it does not cancel the recovery', async () => {
      const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
      const state = { status: 'in_progress', conclusion: null, attempt: 2 };
      const f = fakes();
      f.getRun = drivenRun(f, state);
      f.getJob = attempt2Jobs;
      // both checks were cancelled by one recovery (owner stage cancel-requested); a person re-ran the run → attempt 2
      seed({ stage: 'cancel-requested', cancelRequestedAt: new Date(T0 + 94 * MIN).toISOString() });
      const live = [stuckRun(), { ...siblingCheck(), status: 'COMPLETED', conclusion: 'CANCELLED' }];
      sweepHungJobs({ ...sharedBase(f), listPrs: () => [pr(live)], now: () => T0 + 100 * MIN });
      expect(readHungState(statePath).hung[followerKey]).toMatchObject({ reruns: 1 });
      // attempt 2's job of the follower hangs: escalates (budget spent), never cancels the running recovery
      f.calls.length = 0;
      sweepHungJobs({ ...sharedBase(f), listPrs: () => [pr([{ ...hungInAttempt2('test', 113380540100) }])], now: () => T0 + 135 * MIN });
      expect(writesOf(f.calls)).toEqual([]);
      expect(escLines(f.lines).map((e) => e.check)).toContain('test');
    });

    it('a follower that takes over recovery in a later attempt owns it (no stale coveredBy), and a third check rides on IT; attempt, not the clock, decides', async () => {
      const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
      const state = { status: 'in_progress', conclusion: null, attempt: 2 };
      const f = fakes();
      f.getRun = drivenRun(f, state);
      f.getJob = attempt2Jobs;
      seed(); // the owner's wholeRunAt (T0+94) is AFTER the attempt-2 jobs started (T0+60): a clock rule would wrongly cover them
      const checks = [hungInAttempt2('test', 113380540048), hungInAttempt2('lint', 113380540049)];
      sweepHungJobs({ ...sharedBase(f), listPrs: () => [pr(checks)], now: () => T0 + 135 * MIN });
      expect(writesOf(f.calls)).toEqual(['cancelRun']); // 'test' recovers attempt 2; 'lint' rides on it — one cancel, not two
      const hung = readHungState(statePath).hung;
      expect(hung[followerKey].coveredBy).toBeUndefined();
      expect(hung[followerKey]).toMatchObject({ stage: 'cancel-requested', wholeRunAttempt: 2 });
      expect(hung['4450@db9f116:lint']).toMatchObject({ stage: 'covered-by-sibling', coveredBy: followerKey });
    });
  });

  it('resolveHungSettings: an empty, zero or too-small floor / k falls back to the default, never to 0', async () => {
    const { resolveHungSettings, DEFAULT_HUNG_FLOOR_SEC, DEFAULT_HUNG_K, MIN_HUNG_FLOOR_SEC } = await import('../ci-queue-watch.mjs');
    for (const bad of ['', ' ', '0', '-5', 'abc', String(MIN_HUNG_FLOOR_SEC - 1), true]) {
      expect(resolveHungSettings({ 'hung-floor-sec': bad }, {}).floorSec).toBe(DEFAULT_HUNG_FLOOR_SEC);
      expect(resolveHungSettings({}, { WE_CI_HUNG_FLOOR_SEC: bad === true ? 'x' : bad }).floorSec).toBe(DEFAULT_HUNG_FLOOR_SEC);
    }
    for (const bad of ['', '0', '0.5', 'abc', true]) expect(resolveHungSettings({ 'hung-k': bad }, {}).k).toBe(DEFAULT_HUNG_K);
    expect(resolveHungSettings({ 'hung-floor-sec': String(MIN_HUNG_FLOOR_SEC), 'hung-k': '2' }, {})).toMatchObject({ floorSec: MIN_HUNG_FLOOR_SEC, k: 2 });
    expect(resolveHungSettings({}, { WE_CI_HUNG_FLOOR_SEC: '3600', WE_CI_HUNG_K: '4' })).toMatchObject({ floorSec: 3600, k: 4 });
  });

  it('one very long (forged or real) success sample cannot push the hang threshold past the ceiling', async () => {
    const { hungThreshold, findHungChecks, DEFAULT_HUNG_CEILING_SEC } = await import('../ci-queue-watch.mjs');
    const forged = [{ jobId: 1, sec: 5 * 3600 }];
    expect(hungThreshold(forged, { k: 3, floorSec: 1800 }).thresholdSec).toBe(DEFAULT_HUNG_CEILING_SEC);
    // the reviewer's case: a 5 h success sample, then a 2 h in_progress check is still flagged
    const hung = findHungChecks([pr([stuckRun()])], { 'daemon-soak': forged }, { now: T0 + 120 * MIN, k: 3, floorSec: 1800 });
    expect(hung).toHaveLength(1);
    // the ceiling never drops below the floor
    expect(hungThreshold(forged, { k: 3, floorSec: 7200, ceilingSec: 3600 }).thresholdSec).toBe(7200);
    // and a normal history is untouched
    expect(hungThreshold([{ jobId: 1, sec: 1200 }], { k: 3, floorSec: 1800 }).thresholdSec).toBe(3600);
  });

  it('durations are not learned from a fork PR (its workflows are written by its author)', async () => {
    const { learnDurations } = await import('../ci-queue-watch.mjs');
    const fork = { ...pr([done('daemon-soak', 7, 5 * 3600)], 4460), isCrossRepository: true };
    const own = { ...pr([done('daemon-soak', 8, 600)], 4461), isCrossRepository: false };
    expect(learnDurations({}, [fork, own])['daemon-soak']).toEqual([{ jobId: 8, sec: 600 }]);
  });

  it('acts only on a pull_request run of an allowed workflow; a deploy / push / unknown run is REFUSED with no write', async () => {
    const { sweepHungJobs } = await import('../ci-queue-watch.mjs');
    for (const run of [
      { event: 'push', path: '.github/workflows/ci.yml' },
      { event: 'workflow_run', path: '.github/workflows/deploy.yml' },
      { event: 'workflow_dispatch', path: '.github/workflows/deploy.yml' },
      { path: '.github/workflows/ci.yml' }, // no event at all: fail closed
    ]) {
      const f = fakes('in_progress');
      const getRun = ({ runId }) => { f.calls.push(['getRun', runId]); return { status: 'in_progress', head_sha: 'db9f116', run_attempt: 1, ...run }; };
      sweepHungJobs({ ...sharedBase(f), statePath: join(dir, `refuse-${run.event}-${run.path.length}.json`), getRun, listPrs: () => [pr([stuckRun()])], now: () => T0 + 95 * MIN });
      expect(f.calls.filter(([c]) => c !== 'getRun')).toEqual([]);
      expect(f.lines.join('\n')).toMatch(/ci-job-hung: REFUSED .*pull_request/);
    }
    // a pull_request run is acted on; with an explicit workflow allow-list only the listed files are
    const ok = fakes('completed');
    sweepHungJobs({ ...sharedBase(ok), workflows: ['ci.yml'], listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN });
    expect(writesOf(ok.calls)).toEqual(['rerunJob']);
    const notListed = fakes('completed');
    notListed.getRun = ({ runId }) => { notListed.calls.push(['getRun', runId]); return { status: 'completed', head_sha: 'db9f116', event: 'pull_request', path: '.github/workflows/deploy.yml@refs/pull/4450/merge', run_attempt: 1 }; };
    sweepHungJobs({ ...sharedBase(notListed), statePath: join(dir, 'notlisted.json'), workflows: ['ci.yml'], listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN });
    expect(writesOf(notListed.calls)).toEqual([]);
    const withRef = fakes('completed');
    withRef.getRun = ({ runId }) => { withRef.calls.push(['getRun', runId]); return { status: 'completed', head_sha: 'db9f116', event: 'pull_request', path: '.github/workflows/ci.yml@refs/pull/4450/merge', run_attempt: 1 }; };
    sweepHungJobs({ ...sharedBase(withRef), statePath: join(dir, 'withref.json'), workflows: ['ci.yml'], listPrs: () => [pr([phantom()])], now: () => T0 + 95 * MIN });
    expect(writesOf(withRef.calls)).toEqual(['rerunJob']);
  });

  it('the PR list asks for isCrossRepository, which the duration learner depends on', async () => {
    const { defaultListPrs } = await import('../ci-queue-watch.mjs');
    let argv;
    defaultListPrs({ repo: 'web-everything/web-everything', exec: (_bin, a) => { argv = a; return '[]'; } });
    expect(argv[argv.indexOf('--json') + 1].split(',')).toContain('isCrossRepository');
  });

  it('`hung` with an EMPTY WE_CI_HUNG_FLOOR_SEC does not treat a 10-minute-old check as hung', () => {
    const cdir = mkdtempSync(join(tmpdir(), 'ci-hung-floor-'));
    try {
      const bin = join(cdir, 'bin');
      mkdirSync(bin);
      const started = new Date(Date.now() - 10 * 60_000).toISOString();
      const prs = [{ number: 4450, headRefOid: 'db9f116', statusCheckRollup: [{ name: 'daemon-soak', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: null, startedAt: started, detailsUrl: url(RUN, 113380540047) }] }];
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(prs))});\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      for (const floor of ['', '0']) {
        const out = JSON.parse(execFileSync('node', [CLI, 'hung', '--dry-run', '--json', '--repo=web-everything/web-everything'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: join(cdir, 'history.json'), WE_CI_HUNG_FLOOR_SEC: floor },
        }));
        expect(out.hung).toEqual([]);
      }
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
  });
});

describe('hung CLI verb', () => {
  it('`hung --dry-run --json` lists the hung job from gh pr list without acting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-hung-cli-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const started = new Date(Date.now() - 120 * 60_000).toISOString();
      const prs = [{ number: 4450, headRefOid: 'db9f116', statusCheckRollup: [{ name: 'daemon-soak', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: 'SUCCESS', startedAt: started, detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/37796107550/job/113380540047' }] }];
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(prs))});\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      const out = JSON.parse(execFileSync('node', [CLI, 'hung', '--dry-run', '--json', '--repo=web-everything/web-everything'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: join(dir, 'history.json') },
      }));
      expect(out.hung).toEqual([expect.objectContaining({ pr: 4450, jobId: 113380540047, action: 'recover' })]);
      expect(out.actions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Review finding: the `WE_CI_HUNG_ACTION=0` kill switch and the `sweep` → hung-sweep wiring had no test (the only CLI
// test used `--dry-run`). A fake `gh` that answers per-argv and LOGS every write lets the CLI prove both for real.
describe('hung sweep wiring through the real CLI (kill switch + sweep integration)', () => {
  let dir, writeLog;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ci-hung-wire-')); writeLog = join(dir, 'posts.log'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function installGh() {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const started = new Date(Date.now() - 120 * 60_000).toISOString();
    const prs = [{ number: 4450, headRefOid: 'db9f116', statusCheckRollup: [{ name: 'daemon-soak', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: 'SUCCESS', startedAt: started, detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/37796107550/job/113380540047' }] }];
    writeFileSync(join(bin, 'gh'), [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const a = process.argv.slice(2);',
      `if (a.includes("-X")) { fs.appendFileSync(${JSON.stringify(writeLog)}, a.join(" ") + "\\n"); process.stdout.write("{}"); process.exit(0); }`,
      'if (a[0] === "run") process.stdout.write("[]");',
      `else if (a[0] === "pr") process.stdout.write(${JSON.stringify(JSON.stringify(prs))});`,
      'else if (a[0] === "api" && /actions\\/runs\\/\\d+$/.test(a[1])) process.stdout.write(JSON.stringify({ status: "completed", head_sha: "db9f116", event: "pull_request", path: ".github/workflows/ci.yml", run_attempt: 1 }));',
      'else if (a[0] === "api" && /actions\\/jobs\\/\\d+$/.test(a[1])) process.stdout.write(JSON.stringify({ id: 113380540047, run_id: 37796107550, name: "daemon-soak" }));',
      'else process.stdout.write("{}");',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    return bin;
  }
  const runCli = (args, extraEnv = {}) => {
    const bin = installGh();
    return JSON.parse(execFileSync('node', [CLI, ...args, '--json', '--repo=web-everything/web-everything'], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CONVEYOR_CI_QUEUE_FILE: join(dir, 'history.json'),
        WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'), ...extraEnv,
      },
    }));
  };
  const writes = () => (existsSync(writeLog) ? readFileSync(writeLog, 'utf8').trim().split('\n') : []);

  it('sweep runs the hung pass, attaches result.hung, and performs the re-run when writes are on', () => {
    const out = runCli(['sweep'], { WE_CI_HUNG_ACTION: '' });
    expect(out.hung).toEqual({ count: 1, actions: 1, escalations: 0 });
    expect(writes()).toEqual([expect.stringContaining('jobs/113380540047/rerun')]);
  });

  it('WE_CI_HUNG_ACTION=0 turns every hung-job write off on `sweep` — the hang is still detected', () => {
    const out = runCli(['sweep'], { WE_CI_HUNG_ACTION: '0' });
    expect(out.hung).toEqual({ count: 1, actions: 0, escalations: 0 });
    expect(writes()).toEqual([]);
  });

  it('WE_CI_HUNG_ACTION=0 turns the writes off on the `hung` verb too', () => {
    const out = runCli(['hung'], { WE_CI_HUNG_ACTION: '0' });
    expect(out.hung).toEqual([expect.objectContaining({ pr: 4450, action: 'recover' })]);
    expect(out.actions).toEqual([]);
    expect(writes()).toEqual([]);
  });
});
