import { beforeEach, afterEach, afterAll, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_GH_DIR_ENV, lazyTmpPath, writeFakeGhShim } from './scripts/lib/test-tmp-root.mjs';
import { HERMETIC_ENV, isHermetic } from './scripts/lib/hermetic-tests.mjs';
import { setupHermeticTestFile } from './scripts/lib/hermetic-tests-vitest.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
// Captured BEFORE the sandbox strip below, so the hermetic guard also covers a state root the LAUNCHING shell
// pinned (an operator's CONVEYOR_STATE_ROOT, a daemon's WE_DAEMON_STATE_DIR).
const ambientEnv = { ...process.env };
// Decided by the CONFIG (`test.env.WE_TEST_HERMETIC`), read before the strip removes every WE_* key.
const hermetic = isHermetic(process.env);

// tmp-leak fix (2026-10-04): this file runs once per test FILE, and every temp dir it makes used to be left
// behind — ~1.15M dirs in the operator's `$TMPDIR` (2m39s to list). Each dir this file creates is removed in
// `afterAll`, with the env var it backed reset so a later file in the same worker makes its own fresh one
// instead of reusing a deleted path. `vitest.globalSetup.mjs` is the run-wide backstop for leaks in test files
// themselves.
//
// test-churn cut (2026-10-07): that cleanup was itself the churn (76k file events/min in `$TMPDIR`; per test one
// mkdtemp + rm for the coordination root, per file 4 mkdtemps + a fake `gh` write). Now:
//   - the three env-backed roots (coordination, gh-throttle, daemon-state) are LAZY PATHS under one per-file base
//     dir. Nothing is created here; the code under test creates a root with `mkdir -p` when it first writes
//     (every real writer does), and a test that needs the dir to exist up front calls
//     `ensureTestTmpDir()` from scripts/lib/test-tmp-root.mjs.
//     A file that never touches them costs ZERO filesystem operations.
//   - the per-test coordination reset (#3901) is "remove the dir if a test made it", not mkdtemp + rm each time.
//   - the fake `gh` shim is written ONCE PER RUN by `vitest.globalSetup.mjs` and shared by every file; the
//     per-file write below is only the fallback for a runner that has no such globalSetup.
let fileTmpBase: string | undefined;
function lazyRoot(name: string): string {
  fileTmpBase ??= lazyTmpPath('we-test-', tmpdir());
  return join(fileTmpBase, name);
}
const ownedTmpDirs: string[] = [];
let addedPathPrefix: string | undefined;
afterAll(() => {
  if (fileTmpBase && existsSync(fileTmpBase)) rmSync(fileTmpBase, { recursive: true, force: true });
  for (const key of ['WE_COORDINATION_ROOT', 'WE_GH_THROTTLE_LOCK_ROOT', 'WE_DAEMON_STATE_DIR']) {
    const v = process.env[key];
    if (fileTmpBase && v && v.startsWith(`${fileTmpBase}/`)) delete process.env[key];
  }
  for (const dir of ownedTmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (addedPathPrefix && process.env.PATH?.startsWith(`${addedPathPrefix}:`)) {
    process.env.PATH = process.env.PATH.slice(addedPathPrefix.length + 1);
  }
});

// #xpc3krl (ci-heal-2684, 2026-09-25; extended by operator-approved follow-up the same day) — SANDBOX BY
// DEFAULT, FIRST, before anything below reads `process.env`. Live-caught on this Mac: 6 tests across
// main-staleness.test.mjs, review-dispatch.test.mjs, reconcile-fix-dispatch.test.mjs and
// daemon-self-sync.test.mjs failed ONLY on a host running real daemon sessions (ambient
// `WE_DAEMON_MANAGED_CLONE=1`/`WE_GITHUB_APP_*`), never in CI. The per-test env snapshot/restore further down
// this file (PR #2625) only guards a write LEAKING from one test into a LATER one in the SAME run — it does
// nothing about the run's own STARTING point, which is whatever the launching process's ambient env already
// was. This block makes that starting point identical to CI's, every time:
//
//   1. A fake `gh` placed ahead of everything else on `PATH`, so a test that shells a bare `gh` without
//      overriding PATH or injecting its own `run` can never reach a host's real authenticated `gh` OR its
//      GitHub App shim. It fails the same way a real, unauthenticated `gh` does (message + exit 1), so a test
//      asserting "gh failed" still gets a realistic failure.
//   2. Every ambient `WE_*`/`CONVEYOR_*`/`GH_*`/`CLAUDE_*` env var stripped, minus a tiny allowlist — the
//      exact categories a live daemon process (or an operator's own fleet-configured shell) sets that a test
//      must never silently inherit as "the unconfigured default". This runs BEFORE the `WE_COORDINATION_ROOT`
//      and `WE_TELEMETRY` blocks below so their own "was this already set?" checks see the sandboxed
//      baseline, never a live daemon's real value.
//
// NOT DONE HERE, DELIBERATELY, after trying it and finding it BROKEN rather than just "not cheap" — a
// throwaway `$HOME` (so `os.homedir()`-derived real-path defaults, `~/.claude/*` chief among them, redirect
// tree-wide with no per-call-site change). Built it, then caught a live regression proving it does NOT work
// under this repo's default vitest `threads` pool: `lane-pool-health-watch.test.mjs` started failing because
// `resolveLanePoolRepoPath`'s `home = homedir()` kept returning the REAL home while the test's own
// `process.env.HOME` correctly showed the sandboxed one. Root cause, confirmed with a minimal two-file
// `worker_threads` repro: `os.homedir()`'s native binding does NOT consult a Worker thread's own (virtualized,
// per-thread) `process.env` — only a `child_process` spawn's inherited env does, which is why the `PATH` trick
// below still works fine. A real `$HOME` sandbox would need the heavier `forks` pool (real OS processes, where
// `process.env` mutation IS process-wide) or a per-call-site change — worth knowing before the separate
// detection-checks follow-up card picks a mechanism; it should not re-reach for this same "cheap" fix.
//
// ALSO NOT DONE HERE, same reason: a general guard that FAILS a test for touching the real `~/.claude`/real
// lane folders. Checked empirically — mutating `node:fs`'s exported functions from this setup file does NOT
// intercept a test file's own `import { readFileSync, writeFileSync, ... } from 'node:fs'` named-import calls
// (confirmed with a minimal two-file repro: a patched `fs.writeFileSync` never fired for a sibling module's
// named-import call to it), which is this codebase's dominant `fs` import style. A real interception guard
// needs a loader/`vi.mock`-level hook, not a setup-file patch.
//
// OPT OUT, per config, for the tier that means to prove REAL host/subprocess behavior on purpose
// (`vitest.integration.config.ts`'s real-git/real-`gh` files, `vitest.soak.config.ts`'s real daemons) via
// `test.env: { WE_TEST_SANDBOX: '0' }` — vitest applies a config's own `env` before `setupFiles` runs
// (empirically verified: a probe config/test pair read it inside `setupFiles` and inside the test body
// alike), so this checks that BEFORE doing anything else. A single file inside the DEFAULT (sandboxed)
// config that itself needs the real thing moves to that opt-out tier instead of fighting the default here —
// see `route-pr-outcome-io-live.test.mjs`, moved to `vitest.integration.config.ts` for exactly this reason:
// its whole point is a real, unauthenticated `gh` failure, which the fake `gh` below would otherwise mask.
//
// A test that means to exercise the CONFIGURED path (a real env var, a real `gh`) sets it itself, inside its
// own test body — that always wins over this file, since it runs after.
if (process.env.WE_TEST_SANDBOX !== '0') {
  const ENV_STRIP_PREFIXES = ['WE_', 'CONVEYOR_', 'GH_', 'CLAUDE_'];
  const ENV_STRIP_ALLOWLIST = new Set([
    'WE_TELEMETRY', // an operator's own explicit local opt-in, handled below — never ambient daemon state.
  ]);
  for (const key of Object.keys(process.env)) {
    if (ENV_STRIP_ALLOWLIST.has(key)) continue;
    if (ENV_STRIP_PREFIXES.some((p) => key.startsWith(p))) delete process.env[key];
  }
}

// HERMETIC BY DEFAULT (card xcu4cqf — main was red ~5.5 h on 2026-10-08 because a soak scenario read live GitHub
// and the live origin/main backlog). Independent of the sandbox above: the integration and soak tiers keep their
// real env but are hermetic too. Only `vitest.live.config.ts` (the scheduled, non-blocking live suite) turns it off.
//   1. the hermetic shims first on PATH: a fake `gh` that never reaches GitHub, a `git` that refuses remote reads in
//      the real checkout — both RECORD the access against the running test (we:scripts/lib/hermetic-tests.mjs);
//   2. an in-process fs + fetch guard over the declared live roots (conveyor state, jobs, lane pool, primary
//      backlog — we:scripts/hermetic-tests.settings.json). This CORRECTS the old note above: patching `node:fs`
//      does reach `import { readFileSync } from 'node:fs'` named imports once `syncBuiltinESMExports()` runs;
//   3. `afterEach` fails a test that made any live access with `live GitHub/backlog access in test`, even when the
//      code under test swallowed the error.
// Not wrapped in a try: a guard that silently failed to install would be a gate that fails open.
if (hermetic) {
  process.env[HERMETIC_ENV] = '1';
  let fakeGhDir = process.env[FAKE_GH_DIR_ENV];
  if (!fakeGhDir || !existsSync(join(fakeGhDir, 'gh')) || !existsSync(join(fakeGhDir, 'git'))) {
    fakeGhDir = mkdtempSync(join(tmpdir(), 'we-fake-gh-'));
    ownedTmpDirs.push(fakeGhDir);
    writeFakeGhShim(fakeGhDir);
  }
  addedPathPrefix = fakeGhDir;
  process.env.PATH = `${fakeGhDir}:${process.env.PATH || ''}`;
  setupHermeticTestFile({ beforeEach, afterEach, afterAll, expect, repoRoot: REPO_ROOT, ambient: ambientEnv, violationsDir: lazyRoot('hermetic') });
}

process.env.WE_UNDER_TEST = '1';

// #3383: isolate tests from home AND from each other's durable action holds.
const ownsCoordinationRoot = process.env.WE_COORDINATION_ROOT === undefined;
if (ownsCoordinationRoot) process.env.WE_COORDINATION_ROOT = lazyRoot('coord');
beforeEach(() => {
  // Each test starts with the coordination root absent (= clean); the env restore below may have changed it.
  if (ownsCoordinationRoot) process.env.WE_COORDINATION_ROOT = lazyRoot('coord');
});
afterEach(() => {
  if (ownsCoordinationRoot) {
    const dir = lazyRoot('coord');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ci-heal PR #2794: keep every test off the host's REAL `gh`-throttle semaphore. `ghThrottleLockRoot` is
// cwd-independent (falls back to `$HOME/workspace/.lanes/.admission/gh` when neither `WE_GH_THROTTLE_LOCK_ROOT`
// nor `LANE_POOL_ROOT` is set), so any test running a `gh` call through `gh-throttle.mjs` in-process, or a child
// that inherits this env, would otherwise create that real directory — caught in CI, where it tripped the
// scenario simulator's real-state isolation check (`sim-scenario-lane-starvation.test.mjs`). Set in BOTH tiers
// (outside the sandbox block): the integration tier proves real `gh`, never the host's real throttle state.
// Tests of the resolution itself pass an explicit `env`, so this default never reaches them.
if (process.env.WE_GH_THROTTLE_LOCK_ROOT === undefined) {
  process.env.WE_GH_THROTTLE_LOCK_ROOT = lazyRoot('gh-throttle');
}

// decouple-primary-checkout (epic #4075): the conveyor build queue's DEFAULT path is now the machine-wide
// automation state home (`<WE_DAEMON_STATE_DIR || ~/.claude/daemon-self-sync-state>/conveyor-state`), not the
// checkout's own `.conveyor/`. A test that reads/writes the queue through the defaults would otherwise touch the
// host's REAL queue (the one the live build-dispatch daemon reads). Same both-tiers default as the throttle root
// above; tests of the resolution itself pass an explicit `env`, so this never reaches them.
if (process.env.WE_DAEMON_STATE_DIR === undefined) {
  process.env.WE_DAEMON_STATE_DIR = lazyRoot('daemon-state');
}
// ...and its one-release fallback read of the OLD in-checkout queue (which, on the operator's laptop, is the
// primary checkout's real `.conveyor/queue.json`) is switched off for the same reason.
if (process.env.CONVEYOR_NO_LEGACY_QUEUE === undefined) process.env.CONVEYOR_NO_LEGACY_QUEUE = '1';

// #3383 bugfix: default the delivery-telemetry recorder OFF for the whole unit/integration test run, so
// wrapper tests (`deliver-item-wrapper.test.mjs` and siblings, plus the real-subprocess integration suite)
// that exercise the real dispatch wrappers through `createTelemetryRecorder()`/`recorderFor()` — with
// nothing forcing an in-memory or disabled store — don't append fixture spans to the shared, file-backed
// `.operations/telemetry/*.jsonl` log. Confirmed on disk before this fix: sub-10ms durations and fixture
// item ids (9999/1234/…) made up the large majority of a day's file, drowning out real dispatch data.
//
// `WE_TELEMETRY=0` makes `createTelemetryRecorder` hand back the no-op null recorder (see
// `scripts/operations/telemetry-store.mjs#telemetryEnabled`/`createNullRecorder`) with the EXACT same
// call-site shape as the real one, so nothing about a test's control flow changes.
//
// Wired here — a global Vitest `setupFiles` entry both `vitest.config.ts` (the ~2000-file unit suite) and
// `vitest.integration.config.ts` (the real-subprocess tier, whose spawned `node`/CLI children inherit this
// process's env unless a call site overrides it) load — rather than in each test file, because that
// per-file-opt-in shape is exactly how this regressed silently before: nothing forced it, so it quietly
// didn't happen.
//
// A test that means to exercise the REAL recorder passes `enabled: true` explicitly (see
// `scripts/operations/__tests__/telemetry-wiring.test.mjs` and `telemetry.test.mjs`), which bypasses the
// env check entirely (`createTelemetryRecorder`'s `enabled` param wins over `telemetryEnabled()`) — so this
// default can never block a real telemetry test, only an incidental one.
//
// Respects an operator's own explicit `WE_TELEMETRY` (e.g. `WE_TELEMETRY=1 npm run test:unit` to deliberately
// watch real wrapper tests emit telemetry) rather than clobbering it — the sandbox block above allowlists
// this exact key so a live daemon's own ambient value can never masquerade as that operator opt-in.
if (process.env.WE_TELEMETRY === undefined) {
  process.env.WE_TELEMETRY = '0';
}

// PR #2625 advisory (correctness/test-pollution): a test that writes `process.env` must never leak that write
// into LATER tests. Worker threads are reused across many files, so a leaked `WE_DAEMON_MANAGED_CLONE=1` (set
// on purpose by `daemon-self-sync.mjs#withSelfSync`, whose real children must inherit it) silently flipped
// `main-staleness.mjs#assertMainNotStale` into managed-clone mode in unrelated files, order-dependently.
// Snapshot before each test, restore after it: keys added are deleted, keys changed or deleted are put back.
// Env set at module load or in `beforeAll` is taken before the snapshot, so it is kept.
let envSnapshot: Record<string, string | undefined> | undefined;
beforeEach(() => {
  envSnapshot = { ...process.env };
});
afterEach(() => {
  if (!envSnapshot) return;
  const snap = envSnapshot;
  envSnapshot = undefined;
  // One pass over the live env (drop added keys, restore changed ones), one over the snapshot (restore deleted
  // ones) — no `Object.entries` copy.
  for (const key of Object.keys(process.env)) {
    if (!(key in snap)) delete process.env[key];
    else if (process.env[key] !== snap[key]) process.env[key] = snap[key];
  }
  for (const key in snap) {
    if (!(key in process.env)) process.env[key] = snap[key];
  }
});
