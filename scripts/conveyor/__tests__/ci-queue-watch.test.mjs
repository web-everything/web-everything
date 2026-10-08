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
    name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: url(9, job),
    startedAt: new Date(T0 - 3600_000).toISOString(), completedAt: new Date(T0 - 3600_000 + sec * 1000).toISOString(),
  });
  const phantom = (job = 113380540047, run = 37796107550) => ({
    name: 'daemon-soak', status: 'IN_PROGRESS', conclusion: 'SUCCESS', detailsUrl: url(run, job),
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
      getRun: ({ runId }) => { calls.push(['getRun', runId]); return { status: typeof runStatus === 'function' ? runStatus() : runStatus }; },
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
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunJob', 113380540047]]);
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
    expect(f.calls).toEqual([['getRun', 37796107550], ['cancelRun', 37796107550]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'cancel-requested', reruns: 0 });
    // next sweep: the cancelled job no longer shows in_progress; the ledger drives the pending re-run
    f.calls.length = 0;
    status = 'completed';
    sweepHungJobs({ ...base, listPrs: () => [pr([{ ...live, status: 'COMPLETED', conclusion: 'CANCELLED' }])], now: () => T0 + 97 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunJob', 113380540047]]);
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
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunJob', 113380540047], ['rerunRun', 37796107550]]);
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
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunJob', 113380540047]]);
  });

  it('a throttled (not-sent) re-run is deferred and retried next sweep — no run-rerun fallback, no escalation', async () => {
    const { sweepHungJobs, readHungState } = await import('../ci-queue-watch.mjs');
    const f = fakes('completed');
    const base = { repo: 'web-everything/web-everything', statePath, k: 3, floorSec: 1800, maxReruns: 1, listPrs: () => [pr([phantom()])], ...f };
    sweepHungJobs({ ...base, rerunJob: ({ jobId }) => { f.calls.push(['rerunJob', jobId]); throw new Error(THROTTLED); }, now: () => T0 + 95 * MIN });
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunJob', 113380540047]]);
    expect(Object.values(readHungState(statePath).hung)[0]).toMatchObject({ stage: 'rerun-deferred', reruns: 0 });
    f.calls.length = 0;
    const r = sweepHungJobs({ ...base, now: () => T0 + 115 * MIN });
    expect(r.escalations).toEqual([]);
    expect(f.calls).toEqual([['getRun', 37796107550], ['rerunJob', 113380540047]]);
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
    const running = { name: 'soak', status: 'IN_PROGRESS', detailsUrl: url(5, 500), startedAt: new Date(T0).toISOString() };
    const r = sweepHungJobs({ ...base, listPrs: () => [pr([running])], now: () => T0 + 25 * MIN });
    expect(r.hung).toEqual([]);
  });
});

describe('hung CLI verb', () => {
  it('`hung --dry-run --json` lists the hung job from gh pr list without acting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-hung-cli-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const started = new Date(Date.now() - 120 * 60_000).toISOString();
      const prs = [{ number: 4450, headRefOid: 'db9f116', statusCheckRollup: [{ name: 'daemon-soak', status: 'IN_PROGRESS', conclusion: 'SUCCESS', startedAt: started, detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/37796107550/job/113380540047' }] }];
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
