// Run-scoped temp root for vitest runs (tmp-leak fix, 2026-10-04).
//
// Live-caught on the operator's Mac: `$TMPDIR` held 1,217,982 entries and a plain `ls -f` of it took 2m39s,
// feeding fseventsd CPU and host load. ~1.15M of them were four prefixes made by `vitest.setup.ts`
// (`we-coord-test-`, `we-gh-throttle-test-`, `we-fake-gh-`, `we-daemon-state-test-`) — created once per
// test FILE and never removed — plus a long tail of per-test `mkdtemp` dirs with no cleanup.
//
// Fix at the root, not per leaker: `vitest.globalSetup.mjs` gives each vitest run ONE private temp root
// (`<os tmp>/we-vitest/<pid>-XXXXXX`) and points `TMPDIR`/`TMP`/`TEMP` at it before any worker spawns, so every
// `os.tmpdir()` call — in a worker or in a spawned child that inherits the env — lands inside it. Teardown
// counts what tests left behind (the leak signal), warns or fails per policy, then removes the whole root.
// A run that dies before teardown leaves its root behind; the next run sweeps roots whose pid is dead.
//
// Policy (env, all optional):
//   WE_TMP_LEAK_MODE  'warn' (default) | 'fail' | 'off'
//   WE_TMP_LEAK_MAX   leftover entries allowed before warn/fail fires (default 50)
//   WE_TMP_LEAK_KEEP  '1' keeps the root on disk for debugging instead of removing it
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const RUN_ROOT_PARENT = 'we-vitest';
export const DEFAULT_LEAK_MAX = 50;
export const STALE_ROOT_MIN_AGE_MS = 10 * 60 * 1000;

export function resolveTmpLeakPolicy(env = process.env) {
  const rawMode = String(env.WE_TMP_LEAK_MODE || 'warn').toLowerCase();
  const mode = ['warn', 'fail', 'off'].includes(rawMode) ? rawMode : 'warn';
  const parsed = Number.parseInt(env.WE_TMP_LEAK_MAX ?? '', 10);
  const max = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LEAK_MAX;
  return { mode, max, keep: env.WE_TMP_LEAK_KEEP === '1' };
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// Remove run roots left by vitest processes that are gone. Only touches `<baseTmp>/we-vitest/<pid>-*`
// entries whose pid is dead AND that are older than `minAgeMs` (guards against pid reuse races).
export function sweepStaleRunRoots({ baseTmp, isAlive = isPidAlive, now = Date.now(), minAgeMs = STALE_ROOT_MIN_AGE_MS } = {}) {
  const parent = join(baseTmp, RUN_ROOT_PARENT);
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const m = /^(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const full = join(parent, name);
    try {
      if (now - statSync(full).mtimeMs < minAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // best-effort
    }
  }
  return removed;
}

export function createRunTmpRoot({ baseTmp, pid = process.pid }) {
  const parent = join(baseTmp, RUN_ROOT_PARENT);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${pid}-`));
}

// Group leftover entries by name prefix (the random mkdtemp suffix stripped) so a warning names the leaker.
export function summarizeLeftovers(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return { count: 0, byPrefix: [] };
  }
  const counts = new Map();
  for (const name of names) {
    const prefix = name.replace(/[-_.][A-Za-z0-9]{6,}$/, '');
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  const byPrefix = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([prefix, count]) => ({ prefix, count }));
  return { count: names.length, byPrefix };
}

// Teardown: count leftovers, report per policy, remove the root. Returns the verdict so callers/tests can
// assert on it; sets `failed` when mode is 'fail' and the count exceeds `max`.
export function finishRunTmpRoot({ root, policy = resolveTmpLeakPolicy(), log = console.warn }) {
  const summary = policy.mode === 'off' ? { count: 0, byPrefix: [] } : summarizeLeftovers(root);
  const exceeded = policy.mode !== 'off' && summary.count > policy.max;
  if (exceeded) {
    const top = summary.byPrefix.slice(0, 10).map((p) => `${p.count}× ${p.prefix}`).join(', ');
    log(
      `[tmp-leak] tests left ${summary.count} temp entries (max ${policy.max}, mode ${policy.mode}): ${top}. `
      + 'Remove them in afterEach/afterAll/finally. Tune with WE_TMP_LEAK_MAX / WE_TMP_LEAK_MODE.',
    );
  }
  if (!policy.keep) rmSync(root, { recursive: true, force: true });
  return { ...summary, exceeded, failed: exceeded && policy.mode === 'fail' };
}

// test-churn cut (2026-10-07): helpers for the lazy / write-once temp state `vitest.setup.ts` now uses.

// A unique path under `baseTmp` that is NOT created. The caller (or the code under test) creates it on demand.
export function lazyTmpPath(prefix, baseTmp) {
  return join(baseTmp, `${prefix}${randomBytes(6).toString('hex')}`);
}

// The fake `gh` every sandboxed test file puts first on PATH: fails like an unauthenticated `gh`. Written ONCE
// PER RUN by `vitest.globalSetup.mjs` (dir passed to workers via FAKE_GH_DIR_ENV), not once per test file.
export const FAKE_GH_DIR_ENV = 'VITEST_SHARED_FAKE_GH_DIR';
export function writeFakeGhShim(dir) {
  const path = join(dir, 'gh');
  writeFileSync(
    path,
    '#!/bin/sh\n'
    + 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2\n'
    + 'echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2\n'
    + 'exit 1\n',
  );
  chmodSync(path, 0o755);
  return path;
}

// Run-wide shared state (the fake `gh` dir) lives in a dot-dir inside the run root; removed before the leak
// count so it never shows up as a leftover.
export const SHARED_DIR_NAME = '.we-run-shared';
export function createSharedFakeGh(root) {
  const dir = join(root, SHARED_DIR_NAME, 'fake-gh');
  mkdirSync(dir, { recursive: true });
  writeFakeGhShim(dir);
  return dir;
}
export function removeSharedDir(root) {
  rmSync(join(root, SHARED_DIR_NAME), { recursive: true, force: true });
}

// Explicit opt-in for a test that reads a lazy root BEFORE anything wrote to it (and for the old "dir already
// exists, empty" contract): `ensureTestTmpDir('WE_COORDINATION_ROOT')` creates and returns it.
export function ensureTestTmpDir(envKey, env = process.env) {
  const dir = env[envKey];
  if (!dir) throw new Error(`ensureTestTmpDir: ${envKey} is not set`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
