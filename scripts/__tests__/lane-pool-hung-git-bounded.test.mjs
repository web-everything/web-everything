/**
 * @file scripts/__tests__/lane-pool-hung-git-bounded.test.mjs
 * @description Proof of the #x5n4zn3 fix: the 2026-09-23 incident (#3383) — a hung `git` child (typically its
 *   network transport, e.g. under `fetch`/`ls-remote`) inside `we:scripts/lane-pool.mjs` used to block the
 *   caller INDEFINITELY, no timeout anywhere outside an explicit `list --acquirable` scan. One hung call burned
 *   the drain's whole 45-minute pass cap and merged nothing. `we:scripts/lane-pool.mjs`'s `git`/`gitQuiet` core
 *   now defaults every child to a hard `timeout` + `killSignal: 'SIGKILL'` (reusing
 *   `we:scripts/lib/bounded-child.mjs#resolveChildTimeoutMs`'s shared budget/env-knob policy), so a hung `git`
 *   fails that ONE call fast instead of hanging the whole command.
 *
 * REAL PROCESS, REAL HANG — not a mock. A tiny shim `git` on `PATH` (ahead of the real one) traps and IGNORES
 * `SIGTERM` and sleeps forever for the ONE subcommand under test, so a plain default `killSignal` (`SIGTERM`)
 * would NOT have stopped it — only the `killSignal: 'SIGKILL'` this fix adds actually reaps it (SIGKILL cannot
 * be trapped/ignored by any process, unlike SIGTERM).
 *
 * NO AUTOMATED "RED" CASE HERE, DELIBERATELY — a live before/after was proven BY HAND instead (see the PR body
 * for the transcript: the ORIGINAL bare `execFileSync` calls, run against this exact shim, sat blocked well
 * past a 12s check with the shim process still alive; the patched code here completes and leaves nothing
 * running). Discovered live while first drafting this file: `child_process.spawnSync`/`execFileSync` are
 * SYNCHRONOUS — they cannot return until the child's stdio actually closes, so a `timeout` whose `killSignal`
 * FAILS to kill the child (the default `SIGTERM`, against a child that traps it, is exactly that failure) does
 * not time out at all — it blocks the calling process forever, same as no timeout. Automating that as an
 * in-process vitest case would (and, mid-authorship, DID) wedge the whole synchronous test worker rather than
 * fail cleanly. The GREEN case below is the safe, permanent regression test; it never exercises that
 * SIGTERM-only path.
 *
 * This is `we:scripts/__tests__/lane-pool-acquire-stale-origin.test.mjs`'s exact fixture shape (real throwaway
 * bare origin + reference checkout, no shared pool root), reused so provisioning the lane under test still uses
 * a REAL, unshimmed `git` — only the ONE probe command under test runs with the hung shim on `PATH`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  // A generous but FINITE outer bound, with `killSignal: 'SIGKILL'` (never `'SIGTERM'` — see the file header:
  // a `SIGTERM`-only bound on a child that ignores it does not time out at all, it hangs). This is a TEST-SIDE
  // safety net, not the fix under test: if `we:scripts/lane-pool.mjs`'s own internal bound ever regressed back
  // to unbounded, this outer one turns that into a clean, fast test FAILURE instead of a wedged CI job.
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 25_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || ''), timedOut: !!r.error };
}

/** True while `pid` is still alive (any signal-0 success — same liveness probe the codebase's own
 *  `we:scripts/conveyor/resolve-runner-checkout.mjs`-style checks use). */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let base, originDir, referenceDir, poolRoot, shimDir;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-hung-git-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-pool-hung-git-'));
  poolRoot = join(base, 'pool');
  shimDir = join(base, 'shimbin');
});

afterEach(() => {
  // Belt-and-suspenders (never relied on to PASS the test — the assertions below are): a regression that
  // brought back an unbounded/SIGTERM-only call could in principle leave the shim running past this test's own
  // life. SIGKILL is always effective (untrappable), so this can never itself hang.
  try { execFileSync('pkill', ['-KILL', '-f', join(shimDir, 'git')]); } catch { /* nothing to reap — the common case */ }
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=hunggit', '--branch=trunk', '--no-install'];

/**
 * Write a `git` shim onto its own private bin dir: real `git` for every subcommand EXCEPT `hangOn`, which it
 * traps SIGTERM and sleeps on forever — printing its own pid to `pidFile` first so the test can confirm both
 * that it actually ran AND (later) that it actually died. Returns the shim's bin dir (prepend to PATH).
 */
function installHangingGitShim(hangOn, pidFile) {
  const real = execFileSync('command', ['-v', 'git'], { shell: '/bin/bash', encoding: 'utf8' }).trim();
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'git');
  const script = [
    '#!/usr/bin/env bash',
    `REAL_GIT=${JSON.stringify(real)}`,
    `if [ "$1" = ${JSON.stringify(hangOn)} ]; then`,
    '  trap "" TERM',
    `  echo $$ > ${JSON.stringify(pidFile)}`,
    '  while true; do sleep 3600; done',
    'fi',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n');
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  return shimDir;
}

describe('lane-pool: a hung git child fails fast, not indefinitely (#x5n4zn3)', () => {
  it('GREEN: lane-pool.mjs status kills a hung git via SIGKILL, fails fast, and leaves no leftover process', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);

    const pidFile = join(base, 'hang.pid');
    // `rev-parse` is the FIRST git call every invocation makes (CHECKOUT_ROOT resolution) — hanging it here
    // reproduces the incident's own shape: a wedged git blocking the very first probe of a routine command.
    installHangingGitShim('rev-parse', pidFile);

    const started = Date.now();
    const r = runPool(['status', ...poolArgs()], {
      PATH: `${shimDir}:${process.env.PATH}`,
      WE_CHILD_TIMEOUT_MS: '500', // dials the shared budget down for a fast, deterministic test
    });
    const elapsedMs = Date.now() - started;

    // Never hit this test's own 25s outer safety net — the fix's OWN 500ms-dialed bound is what resolved it.
    expect(r.timedOut).toBe(false);
    // Bounded — nowhere near "up to an hour" (the incident), and well under the DEFAULT 5-minute ceiling this
    // WE_CHILD_TIMEOUT_MS override dials down from. A generous multiple of the 500ms budget absorbs CI jitter.
    expect(elapsedMs).toBeLessThan(15_000);

    // The hung shim's own pid file proves it was actually invoked (the hang is real, not skipped).
    expect(existsSync(pidFile)).toBe(true);
    const hungPid = Number(readFileSync(pidFile, 'utf8').trim());

    // THE PROOF BAR: no leftover child process. Only `killSignal: 'SIGKILL'` (this fix) reaps a child that
    // traps SIGTERM — Node's own default killSignal would have left it running forever (see the file header).
    expect(isAlive(hungPid)).toBe(false);

    // A killed git probe is unreadable, never mistaken for "dead"/"free" — CHECKOUT_ROOT falls back to `cwd()`
    // and the command still runs to a normal, well-formed completion (possibly failing later on a real
    // precondition, e.g. no resolvable origin) rather than crashing or hanging.
    expect(r.code === 0 || /could not determine an origin url|not a checkout|no free lane/i.test(r.err)).toBeTruthy();
  }, 30_000);
});
