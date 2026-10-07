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
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import { decideSkipRebuild, resolveSkipUnrelated } from '../daemon-rebuild/skip-unrelated.mjs';

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
