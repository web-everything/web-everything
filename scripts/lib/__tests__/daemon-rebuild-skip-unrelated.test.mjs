/**
 * @file scripts/lib/__tests__/daemon-rebuild-skip-unrelated.test.mjs
 * @description daemonRebuild.skipUnrelated — real temp git repos: a rebuild whose move touches nothing the daemon
 *   imports (docs/backlog only) adopts WITHOUT the candidate smoke; an imported file, a package manifest/lockfile
 *   or a config change still builds + smokes. Plus the knob and the pure decision.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { writeRebuildState } from '../daemon-rebuild/state.mjs';
import { SMOKE_CHECKS } from '../daemon-live-smoke.mjs';
import { DAEMON_ENTRY_MODULES } from '../daemon-boot-smoke.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import { decideSkipRebuild, resolveSkipUnrelated, smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';

const LOCK_OPTS = { waitMs: 0 };

const tempDirs = [];

function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** A throwaway clone of `originDir`, used to push commits/branches without ever touching the daemon clone
 *  under test. Its parent dir is registered for cleanup (the clone itself doesn't need separate registration). */
function makeAuthorClone(originDir) {
  const parent = mktemp('we-daemon-rebuild-author-');
  const dir = join(parent, 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], {
    encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return dir;
}

/** Push one new commit onto `ref` (created from `base`, default `origin/main`) via a throwaway author clone.
 *  Returns the pushed commit sha. */
function pushBranch(originDir, ref, mutate, { base = 'origin/main' } = {}) {
  const dir = makeAuthorClone(originDir);
  gitOk(dir, ['fetch', '-q', 'origin']);
  gitOk(dir, ['checkout', '-q', '-B', ref, base]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `overlay: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

/** Advance `main` on origin with one new commit via a throwaway author clone. */
function advanceMain(originDir, mutate) {
  return pushBranch(originDir, 'main', mutate, { base: 'origin/main' });
}

function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Fresh {origin (bare), clone (working tree under test), env} fixture. The clone starts on `main`, clean,
 *  tracking `origin`, one commit. Every per-clone state/lock/overlay dir is a fresh mkdtemp threaded via `env`. */
function makeFixture() {
  const base = mktemp('we-daemon-rebuild-fixture-');
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  mkdirSync(cloneDir, { recursive: true });
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(cloneDir, ['init', '-q', '-b', 'main']);
  writeFile(cloneDir, 'README.md', 'init\n');
  gitOk(cloneDir, ['add', '-A']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(cloneDir, ['fetch', '-q', 'origin']); // guarantee refs/remotes/origin/main exists locally

  const stateDir = mktemp('we-daemon-rebuild-state-');
  const lockDir = mktemp('we-daemon-rebuild-lock-');
  const overlayDir = mktemp('we-daemon-rebuild-overlay-');
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: stateDir,
    WE_DAEMON_CLONE_LOCK_ROOT: lockDir,
    WE_DAEMON_OVERLAY_DIR: overlayDir,
  };
  return { base, originDir, cloneDir, stateDir, lockDir, overlayDir, env };
}

function passSmoke() {
  return vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }));
}


afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true }); });

const entry = 'scripts/d.mjs';
async function adoptBaseline(f) {
  // Daemon entry + one imported lib, adopted through a real (smoked) rebuild so HEAD == adopted.head.
  advanceMain(f.originDir, (dir) => {
    writeFile(dir, entry, "import './lib/a.mjs';\n");
    writeFile(dir, 'scripts/lib/a.mjs', 'export const a = 1;\n');
    writeFile(dir, 'package.json', '{}\n');
  });
  const smoke = passSmoke();
  const r = await rebuildClone({ root: f.cloneDir, env: f.env, runSmoke: smoke, prState: async () => null, lockOpts: LOCK_OPTS });
  expect(r.adopted).toBe(true);
  expect(smoke).toHaveBeenCalledTimes(1);
  const closure = collectImportClosure({ root: f.cloneDir, entries: [entry] });
  expect(closure.complete).toBe(true);
  return (files) => decideSkipRebuild({ changedFiles: files, closure });
}

async function next(f, skipCheck, mutate, knob = '1') {
  advanceMain(f.originDir, mutate);
  const runSmoke = passSmoke();
  const log = { error: vi.fn() };
  const r = await rebuildClone({
    root: f.cloneDir, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: knob }, log, runSmoke, skipCheck, prState: async () => null, lockOpts: LOCK_OPTS,
  });
  return { r, runSmoke, log };
}

describe('daemonRebuild.skipUnrelated', () => {
  it('a docs/backlog-only move skips the smoke, still moves the clone, and logs the reason', async () => {
    const f = makeFixture();
    const skipCheck = await adoptBaseline(f);
    const { r, runSmoke, log } = await next(f, skipCheck, (dir) => {
      writeFile(dir, 'backlog/9.md', 'nine\n');
      writeFile(dir, 'docs/x.md', 'x\n');
    });
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.adopted).toBe(true);
    expect(r.reason).toBe('skipped-unrelated');
    expect(existsSync(join(f.cloneDir, 'backlog/9.md'))).toBe(true);
    expect(gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(r.head);
    expect(readRebuildState(f.cloneDir, f.env).adopted.head).toBe(r.head);
    expect(log.error.mock.calls.map((c) => c[0]).join('\n')).toMatch(/skipped rebuild\+smoke .*none of 2 changed file\(s\) is imported/);
  });

  it('default (no injected check) skips a docs-only move using the daemon entries, but not an imported change', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    const run = async (mutate) => {
      advanceMain(f.originDir, mutate);
      const runSmoke = passSmoke();
      const r = await rebuildClone({
        root: f.cloneDir, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: '1' }, entries: [entry], runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
      });
      return { r, runSmoke };
    };
    const docs = await run((dir) => writeFile(dir, 'docs/z.md', 'z\n'));
    expect(docs.runSmoke).not.toHaveBeenCalled();
    expect(docs.r.reason).toBe('skipped-unrelated');
    const code = await run((dir) => writeFile(dir, 'scripts/lib/a.mjs', 'export const a = 3;\n'));
    expect(code.runSmoke).toHaveBeenCalledTimes(1);
  });

  it('a change to an imported file still builds and smokes', async () => {
    const f = makeFixture();
    const skipCheck = await adoptBaseline(f);
    const { r, runSmoke } = await next(f, skipCheck, (dir) => writeFile(dir, 'scripts/lib/a.mjs', 'export const a = 2;\n'));
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(r.adopted).toBe(true);
    expect(r.reason).not.toBe('skipped-unrelated');
  });

  it('a lockfile or package.json change still builds and smokes', async () => {
    const f = makeFixture();
    const skipCheck = await adoptBaseline(f);
    const lock = await next(f, skipCheck, (dir) => writeFile(dir, 'package-lock.json', '{"v":1}\n'));
    expect(lock.runSmoke).toHaveBeenCalledTimes(1);
    const pkg = await next(f, skipCheck, (dir) => writeFile(dir, 'package.json', '{"x":1}\n'));
    expect(pkg.runSmoke).toHaveBeenCalledTimes(1);
  });

  it('knob off (WE_DAEMON_REBUILD_SKIP_UNRELATED=0): even a docs-only move smokes', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    const { runSmoke } = await next(f, undefined, (dir) => writeFile(dir, 'docs/y.md', 'y\n'), '0');
    expect(runSmoke).toHaveBeenCalledTimes(1);
  });
});

describe('decideSkipRebuild / resolveSkipUnrelated', () => {
  const closure = { complete: true, files: new Set(['scripts/d.mjs']), bareDeps: false, jsonNames: new Set(['cfg.json']) };
  it('decides', () => {
    expect(decideSkipRebuild({ changedFiles: ['docs/a.md'], closure }).skip).toBe(true);
    expect(decideSkipRebuild({ changedFiles: ['scripts/d.mjs'], closure }).skip).toBe(false);
    expect(decideSkipRebuild({ changedFiles: ['x/cfg.json'], closure }).skip).toBe(false);
    expect(decideSkipRebuild({ changedFiles: ['yarn.lock'], closure }).skip).toBe(false);
    expect(decideSkipRebuild({ changedFiles: null, closure }).skip).toBe(false);
    expect(decideSkipRebuild({ changedFiles: ['docs/a.md'], closure: { ...closure, complete: false } }).skip).toBe(true);
    expect(decideSkipRebuild({ changedFiles: ['scripts/other.mjs'], closure: { ...closure, complete: false } }).skip).toBe(false);
  });
  it('knob: default on, env turns off', () => {
    expect(resolveSkipUnrelated({}, { path: '/nonexistent' })).toBe(true);
    expect(resolveSkipUnrelated({ WE_DAEMON_REBUILD_SKIP_UNRELATED: '0' })).toBe(false);
    expect(resolveSkipUnrelated({})).toBe(true);
  });
});

// ── review round 1 (#4272): the skip must consider the WHOLE smoke surface, not the caller's closure alone ──────
describe('the skip decision covers everything the shared candidate smoke exercises', () => {
  const surface = smokeSurfaceEntries({});

  it('the surface is derived from the smoke definitions (daemon entries, every check codeEntries, the smoke modules)', () => {
    for (const e of DAEMON_ENTRY_MODULES) expect(surface).toContain(e);
    for (const c of SMOKE_CHECKS) for (const e of c.codeEntries || []) expect(surface).toContain(e);
    expect(surface).toContain('scripts/lane-pool.mjs');
    expect(surface).toContain('scripts/conveyor/reconcile-pass.mjs');
    expect(surface).toContain('scripts/lib/daemon-live-smoke.mjs');
    expect(smokeSurfaceEntries({ WE_SMOKE_DAEMON_ENTRIES: 'x/extra-daemon.mjs' })).toContain('x/extra-daemon.mjs');
  });

  it.each([
    ['a sibling daemon entry', 'skills-src/conveyor/review-daemon.mjs'],
    ['lane-pool.mjs (lane-pool-list / lane-acquire-release)', 'scripts/lane-pool.mjs'],
    ['reconcile-pass.mjs (reconcile-dry-run)', 'scripts/conveyor/reconcile-pass.mjs'],
    ['a dispatch module (dispatch-dry-run)', 'scripts/operations/review-dispatch.mjs'],
  ])('a move that changes only %s smokes, whether the file exists before the move or is added by it', async (_label, file) => {
    for (const existsBefore of [true, false]) {
      const f = makeFixture();
      advanceMain(f.originDir, (dir) => {
        writeFile(dir, entry, "import './lib/a.mjs';\n");
        writeFile(dir, 'scripts/lib/a.mjs', 'export const a = 1;\n');
        writeFile(dir, 'package.json', '{}\n');
        if (existsBefore) writeFile(dir, file, 'export const v = 1;\n');
      });
      const baseline = await rebuildClone({ root: f.cloneDir, env: f.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
      expect(baseline.adopted).toBe(true);
      advanceMain(f.originDir, (dir) => writeFile(dir, file, 'export const v = 2;\n'));
      const runSmoke = passSmoke();
      const r = await rebuildClone({
        root: f.cloneDir, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: '1' }, entries: [entry], runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
      });
      expect(runSmoke).toHaveBeenCalledTimes(1);
      expect(r.reason).not.toBe('skipped-unrelated');
    }
  });

  it('the same sibling-only change is still unrelated to a docs-only neighbour: docs still skip', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    advanceMain(f.originDir, (dir) => writeFile(dir, 'docs/ok.md', 'ok\n'));
    const runSmoke = passSmoke();
    const r = await rebuildClone({
      root: f.cloneDir, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: '1' }, entries: [entry], runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.reason).toBe('skipped-unrelated');
  });
});

describe('a file the daemon can run or read without importing it is never "unrelated"', () => {
  const closure = { complete: true, files: new Set(['scripts/d.mjs']), bareDeps: false, jsonNames: new Set() };
  it.each([
    'scripts/helper.sh', 'scripts/tool.py', '.github/workflows/ci.yml', 'config/x.yaml', 'x/y.toml',
    'skills-src/conveyor/prompt.md', '.claude/settings.md',
  ])('%s takes the smoke', (file) => {
    const d = decideSkipRebuild({ changedFiles: [file], closure });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('executable-or-runtime-file-change');
  });
  it('plain docs/backlog markdown still skips', () => {
    expect(decideSkipRebuild({ changedFiles: ['docs/a.md', 'backlog/1-x.md'], closure }).skip).toBe(true);
  });
});

describe('a rename out of the closure is not hidden', () => {
  it('renaming an imported module away (importer untouched) still smokes', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    // Rename detection on explicitly (not left to the host's git config) — the diff must list BOTH endpoints.
    gitOk(f.cloneDir, ['config', 'diff.renames', 'true']);
    const author = makeAuthorClone(f.originDir);
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    gitOk(author, ['config', 'diff.renames', 'true']);
    mkdirSync(join(author, 'docs'), { recursive: true });
    gitOk(author, ['mv', 'scripts/lib/a.mjs', 'docs/a.md']);
    gitOk(author, ['commit', '-q', '-m', 'rename imported module away']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const runSmoke = passSmoke();
    const r = await rebuildClone({
      root: f.cloneDir, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: '1' }, entries: [entry], runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(r.reason).not.toBe('skipped-unrelated');
  });
});

// ── the shortcut's own preconditions: each guard, removed alone, must redden a test here ────────────────────────
describe('unverified, mismatched, held, quarantined and mid-build clones never take the shortcut', () => {
  /** Run one unrelated (docs-only) move through a spy `skipCheck` that ALWAYS says skip: if a guard fails to stop
   *  the shortcut, the result is `skipped-unrelated` and the spy has been consulted. */
  async function unrelatedMove(f, { env = f.env } = {}) {
    advanceMain(f.originDir, (dir) => writeFile(dir, 'docs/guard.md', 'g\n'));
    const skipCheck = vi.fn(() => ({ skip: true, reason: 'spy' }));
    const runSmoke = passSmoke();
    const r = await rebuildClone({
      root: f.cloneDir, env, runSmoke, skipCheck, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    return { r, skipCheck, runSmoke };
  }
  const patchState = (f, patch) => writeRebuildState(f.cloneDir, { ...readRebuildState(f.cloneDir, f.env), ...patch }, f.env);

  it('control: with every precondition met the spy check IS consulted and the shortcut IS taken', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    const { r, skipCheck, runSmoke } = await unrelatedMove(f);
    expect(skipCheck).toHaveBeenCalledTimes(1);
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.reason).toBe('skipped-unrelated');
  });

  it('never adopted (no verified baseline): the check is not consulted and the smoke runs', async () => {
    const f = makeFixture();
    expect(readRebuildState(f.cloneDir, f.env).adopted?.head ?? null).toBeNull();
    const { r, skipCheck, runSmoke } = await unrelatedMove(f);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(r.reason).not.toBe('skipped-unrelated');
  });

  it('adopted head is not the clone HEAD (a tree that was never the verified build): no shortcut', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    patchState(f, { adopted: { ...readRebuildState(f.cloneDir, f.env).adopted, head: '0'.repeat(40) } });
    const { r, skipCheck } = await unrelatedMove(f);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(r.reason).not.toBe('skipped-unrelated');
  });

  it('held clone: no shortcut', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    patchState(f, { held: { reason: 'smoke-rejected', lastGood: 'x', at: new Date().toISOString() } });
    const { r, skipCheck } = await unrelatedMove(f);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(r.reason).not.toBe('skipped-unrelated');
  });

  it('quarantined clone: no shortcut', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    patchState(f, { quarantine: { prevHead: '0'.repeat(40), reason: 'rebuild-threw' } });
    const { r, skipCheck } = await unrelatedMove(f);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(r.reason).not.toBe('skipped-unrelated');
  });

  it('a sibling daemon mid-smoke (live build lease): the clone is not moved under it', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    const headBefore = gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim();
    patchState(f, {
      building: {
        token: 'sibling-token', pid: process.ppid, host: hostname(), startedAt: new Date().toISOString(),
        target: 'deadbeef', inputsKey: 'k', path: join(f.base, 'sibling-candidate'),
      },
    });
    const { r, skipCheck, runSmoke } = await unrelatedMove(f);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(runSmoke).not.toHaveBeenCalled();
    expect(r.reason).toBe('rebuild-in-progress');
    expect(gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('a build adopted with a busy-skipped probe is not carried forward unsmoked', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    patchState(f, { busySkippedTrees: [gitOk(f.cloneDir, ['rev-parse', 'HEAD^{tree}']).trim()] });
    const { r, skipCheck, runSmoke } = await unrelatedMove(f);
    expect(skipCheck).not.toHaveBeenCalled();
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(r.reason).not.toBe('skipped-unrelated');
  });

  it('a busy-skipped record for some OTHER tree does not block the shortcut', async () => {
    const f = makeFixture();
    await adoptBaseline(f);
    patchState(f, { busySkippedTrees: ['0'.repeat(40)] });
    const { r, skipCheck } = await unrelatedMove(f);
    expect(skipCheck).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('skipped-unrelated');
  });
});

describe('a non-ASCII changed path is matched, not C-quoted past the closure', () => {
  it('changing an imported module with a non-ASCII name still smokes', async () => {
    const f = makeFixture();
    advanceMain(f.originDir, (dir) => {
      writeFile(dir, entry, "import './lib/ü.mjs';\n");
      writeFile(dir, 'scripts/lib/ü.mjs', 'export const u = 1;\n');
      writeFile(dir, 'package.json', '{}\n');
    });
    const base = await rebuildClone({ root: f.cloneDir, env: f.env, runSmoke: passSmoke(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(base.adopted).toBe(true);
    advanceMain(f.originDir, (dir) => writeFile(dir, 'scripts/lib/ü.mjs', 'export const u = 2;\n'));
    const runSmoke = passSmoke();
    const r = await rebuildClone({
      root: f.cloneDir, env: { ...f.env, WE_DAEMON_REBUILD_SKIP_UNRELATED: '1' }, entries: [entry], runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
    });
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(r.reason).not.toBe('skipped-unrelated');
  });
});
