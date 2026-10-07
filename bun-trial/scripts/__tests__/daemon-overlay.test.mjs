/**
 * @file scripts/__tests__/daemon-overlay.test.mjs
 * @description The `scripts/daemon-overlay.mjs add` CLI's overlay-conflict guard (epic #3383/#4075). Live
 *   incident 2026-09-27: `lane/promote-stale-green` was registered while KNOWINGLY conflicting with
 *   `lane/fix-procedure` in a shared file — nothing refused it, so the next rebuild silently dropped it and its
 *   own fix never went live. Spawns the REAL CLI (never a mocked import) against a real temp origin+clone pair,
 *   exactly the shape a real daemon clone has — the same fixture pattern `daemon-rebuild.test.mjs` uses for
 *   {@link previewOverlayConflict} itself (the pure guard is tested there; this file proves the CLI wiring:
 *   refuse by default, `--allow-conflict --reason=` overrides and prints what it overrode, `--check` never
 *   mutates the overlay state file either way).
 */
import { describe, it, test, expect } from 'bun:test';
const __ORIG_URL = new URL('../../../scripts/__tests__/daemon-overlay.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withAddGuardLock } from '../../../scripts/daemon-overlay.mjs';
import { overlayFilePath } from '../../../scripts/lib/daemon-overlays.mjs';

const HERE = dirname(fileURLToPath(__ORIG_URL));
const CLI = resolve(HERE, '..', 'daemon-overlay.mjs');

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
function mktemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function makeAuthorClone(originDir) {
  const dir = join(mktemp('we-overlay-cli-author-'), 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return dir;
}
function pushBranch(originDir, ref, mutate, { base = 'origin/main' } = {}) {
  const dir = makeAuthorClone(originDir);
  gitOk(dir, ['fetch', '-q', 'origin']);
  gitOk(dir, ['checkout', '-q', '-B', ref, base]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `overlay: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
}
function advanceMain(originDir, mutate) {
  pushBranch(originDir, 'main', mutate, { base: 'origin/main' });
}

/** Fresh {originDir, cloneDir, env} — a real bare origin + a real working clone tracking it, one commit on
 *  main, every per-clone state dir a fresh mkdtemp (never `~/.claude/*`). */
function makeFixture() {
  const base = mktemp('we-overlay-cli-fixture-');
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
  gitOk(cloneDir, ['fetch', '-q', 'origin']);
  const overlayDir = mktemp('we-overlay-cli-state-');
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir };
  return { originDir, cloneDir, overlayDir, env };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env });
}

function overlayStateFile(overlayDir, cloneDir) {
  // one file per clone, named by a hash of its realpath — just read whatever the dir contains, there is only one.
  void cloneDir;
  const names = readdirSync(overlayDir).filter((n) => n.endsWith('.json'));
  return names.length ? JSON.parse(readFileSync(join(overlayDir, names[0]), 'utf8')) : null;
}

describe('daemon-overlay.mjs add — the overlay-conflict guard', () => {
  it('REFUSES (exit 3) a conflicting overlay by default, and registers NOTHING', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/promote-stale-green', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));

    const first = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/fix-procedure', '--pr=2821'], env);
    expect(first.status).toBe(0);

    const second = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/promote-stale-green', '--pr=2826', '--json'], env);
    expect(second.status).toBe(3);
    expect(second.stderr).toMatch(/REFUSED/);
    expect(second.stderr).toMatch(/shared\.mjs/);
    expect(second.stderr).toMatch(/lane\/fix-procedure/);

    const state = overlayStateFile(overlayDir, cloneDir);
    expect(state.overlays.map((o) => o.ref)).toEqual(['lane/fix-procedure']); // #2826 never registered
  });

  it('--allow-conflict --reason=... registers anyway, and PRINTS which overlay/file conflicts', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/promote-stale-green', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));
    runCli(['add', `--clone=${cloneDir}`, '--ref=lane/fix-procedure', '--pr=2821'], env);

    const r = runCli([
      'add', `--clone=${cloneDir}`, '--ref=lane/promote-stale-green', '--pr=2826',
      '--allow-conflict', '--reason=operator-approved override',
    ], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/registering DESPITE a known conflict/);
    expect(r.stderr).toMatch(/shared\.mjs/);

    const state = overlayStateFile(overlayDir, cloneDir);
    expect(state.overlays.map((o) => o.ref).sort()).toEqual(['lane/fix-procedure', 'lane/promote-stale-green']);
  });

  it('--allow-conflict with no --reason is a usage error (exit 2), never silently ignored', () => {
    const { cloneDir, env } = makeFixture();
    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/whatever', '--allow-conflict'], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--allow-conflict requires --reason/);
  });

  it('a clean (non-conflicting) overlay registers normally, no refusal at all', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'a.mjs', 'a\n'));
    pushBranch(originDir, 'lane/other', (dir) => writeFile(dir, 'b.mjs', 'b\n'));
    runCli(['add', `--clone=${cloneDir}`, '--ref=lane/fix-procedure'], env);

    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/other'], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');

    const state = overlayStateFile(overlayDir, cloneDir);
    expect(state.overlays.map((o) => o.ref).sort()).toEqual(['lane/fix-procedure', 'lane/other']);
  });

  it('--check reports the conflict but registers NOTHING — safe to run against a live clone', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/fix-procedure', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/promote-stale-green', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));
    runCli(['add', `--clone=${cloneDir}`, '--ref=lane/fix-procedure', '--pr=2821'], env);
    expect(existsSync(overlayDir)).toBe(true);
    const before = overlayStateFile(overlayDir, cloneDir);

    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/promote-stale-green', '--pr=2826', '--check', '--json'], env);
    expect(r.status).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.check.clean).toBe(false);
    expect(parsed.check.files).toEqual(['shared.mjs']);
    expect(parsed.wouldRegister).toBe(false);

    const after = overlayStateFile(overlayDir, cloneDir);
    expect(after).toEqual(before); // untouched — --check never calls addOverlay
  });

  it('--check on a clean candidate reports wouldRegister:true and still registers nothing', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    pushBranch(originDir, 'lane/solo', (dir) => writeFile(dir, 'c.mjs', 'c\n'));
    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/solo', '--check', '--json'], env);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.check.clean).toBe(true);
    expect(parsed.wouldRegister).toBe(true);
    // `--check` never calls `addOverlay` — no state file is ever created for this clone at all.
    const state = overlayStateFile(overlayDir, cloneDir);
    expect(state?.overlays ?? []).toEqual([]);
  });

  // ── PR #2827 review findings ──────────────────────────────────────────────────────────────────────────────

  it('a stuck PINNED overlay (now conflicting with main) does not block an unrelated, clean add', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/pinned-thing', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    expect(runCli(['add', `--clone=${cloneDir}`, '--ref=lane/pinned-thing', '--pinned'], env).status).toBe(0);
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 9;\n')); // pinned now conflicts
    pushBranch(originDir, 'lane/unrelated', (dir) => writeFile(dir, 'other.mjs', 'o\n'));

    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/unrelated'], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/lane\/pinned-thing/); // the stuck overlay is NAMED, not swallowed
    expect(r.stderr).toMatch(/pinned-overlay-conflict/);
    const state = overlayStateFile(overlayDir, cloneDir);
    expect(state.overlays.map((o) => o.ref)).toEqual(['lane/pinned-thing', 'lane/unrelated']);
  });

  it('two CONCURRENT adds of mutually-conflicting refs register at most one of them', async () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    advanceMain(originDir, (dir) => writeFile(dir, 'shared.mjs', 'export const X = 1;\n'));
    pushBranch(originDir, 'lane/a', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 2;\n'));
    pushBranch(originDir, 'lane/b', (dir) => writeFile(dir, 'shared.mjs', 'export const X = 3;\n'));

    const { spawn } = await import('node:child_process');
    const run = (ref) => new Promise((res) => {
      const p = spawn(process.execPath, [CLI, 'add', `--clone=${cloneDir}`, `--ref=${ref}`], { env });
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (status) => res({ status, stderr }));
    });
    const results = await Promise.all([run('lane/a'), run('lane/b')]);

    expect(results.map((x) => x.status).sort()).toEqual([0, 3]);
    const state = overlayStateFile(overlayDir, cloneDir);
    expect(state.overlays).toHaveLength(1);
  }, 60_000);

  it('--check against a corrupt overlay store fails (exit 1, wouldRegister:false) — never a false "would register"', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    pushBranch(originDir, 'lane/solo', (dir) => writeFile(dir, 'c.mjs', 'c\n'));
    expect(runCli(['add', `--clone=${cloneDir}`, '--ref=lane/solo'], env).status).toBe(0);
    const file = readdirSync(overlayDir).find((n) => n.endsWith('.json'));
    writeFileSync(join(overlayDir, file), '{not json');

    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/solo', '--check', '--json'], env);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).wouldRegister).toBe(false);
  });

  it('a merge-tree execution error is refused even with --allow-conflict (it is not a confirmed conflict)', () => {
    const { originDir, cloneDir, overlayDir, env } = makeFixture();
    const dir = makeAuthorClone(originDir);
    gitOk(dir, ['checkout', '-q', '--orphan', 'lane/unrelated']);
    gitOk(dir, ['rm', '-rq', '--cached', '--ignore-unmatch', '.']); // the author clone's index can be empty (CI)
    writeFile(dir, 'z.mjs', 'z\n');
    gitOk(dir, ['add', 'z.mjs']);
    gitOk(dir, ['commit', '-q', '-m', 'orphan']);
    gitOk(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/lane/unrelated']);

    const r = runCli(['add', `--clone=${cloneDir}`, '--ref=lane/unrelated', '--allow-conflict', '--reason=try it'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/merge-tree-failed/);
    expect(overlayStateFile(overlayDir, cloneDir)?.overlays ?? []).toEqual([]);
  });
});

// ── withAddGuardLock — deterministic interleavings (PR #2827 review prevention guards) ───────────────────────
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A pid that is guaranteed dead: a child that already exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

function lockFixture(waitMs) {
  const overlayDir = mktemp('we-overlay-lock-');
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir };
  if (waitMs) env.WE_DAEMON_OVERLAY_ADD_GUARD_WAIT_MS = String(waitMs);
  const root = mktemp('we-overlay-lock-root-');
  const lockDir = `${overlayFilePath(root, env)}.add-guard.lock`;
  return { env, root, lockDir };
}

function backdate(dir, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(dir, t, t);
}

describe('withAddGuardLock', () => {
  it('withAddGuardLock — three contenders stay exclusive through a paused stale recovery', async () => {
    const { env, root, lockDir } = lockFixture();
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), String(deadPid())); // legacy bare pid of a dead holder

    let active = 0;
    let maxActive = 0;
    let ran = 0;
    const enter = async (hold) => {
      active += 1; maxActive = Math.max(maxActive, active); ran += 1;
      await hold; active -= 1;
    };
    const aInspected = deferred(); const releaseA1 = deferred();
    const aRemoving = deferred(); const releaseA2 = deferred();
    const bIn = deferred(); const gateB = deferred();
    const cAtAttempt = deferred(); const gateC = deferred();

    const a = withAddGuardLock(root, env, () => enter(sleep(20)), {
      async onPhase(phase) {
        if (phase === 'inspected') { aInspected.resolve(); await releaseA1.promise; }
        if (phase === 'removing') { aRemoving.resolve(); await releaseA2.promise; }
      },
    });
    await aInspected.promise;
    const b = withAddGuardLock(root, env, () => { bIn.resolve(); return enter(gateB.promise); });
    await bIn.promise;
    const c = withAddGuardLock(root, env, () => enter(sleep(20)), {
      async onPhase(phase) { if (phase === 'attempt') { cAtAttempt.resolve(); await gateC.promise; } },
    });
    await cAtAttempt.promise;

    releaseA1.resolve();
    await aRemoving.promise; // A holds the recovery mutex, between its inspection and its removal step
    gateC.resolve();         // C tries to enter exactly now
    await sleep(300);
    expect(active).toBe(1);  // only B is inside
    releaseA2.resolve();
    await sleep(300);
    expect(active).toBe(1);
    gateB.resolve();
    await Promise.all([a, b, c]);

    expect(ran).toBe(3);
    expect(maxActive).toBe(1);
  });

  it('withAddGuardLock — a fresh owner-less lock is never broken', async () => {
    const { env, root, lockDir } = lockFixture(400);
    mkdirSync(lockDir, { recursive: true }); // a live holder between mkdir and its owner write
    await expect(withAddGuardLock(root, env, async () => 'x')).rejects.toThrow(/still held/);
    expect(existsSync(lockDir)).toBe(true);

    backdate(lockDir, 10_000); // now indistinguishable from a crashed holder
    await expect(withAddGuardLock(root, env, async () => 'ok')).resolves.toBe('ok');
  });

  it('withAddGuardLock — a fresh owner-less lock is never broken when its holder writes its owner mid-recovery', async () => {
    const { env, root, lockDir } = lockFixture(600);
    mkdirSync(lockDir, { recursive: true });
    backdate(lockDir, 10_000);
    const inspected = deferred(); const release = deferred();
    const contender = withAddGuardLock(root, env, async () => 'x', {
      async onPhase(phase) { if (phase === 'inspected') { inspected.resolve(); await release.promise; } },
    });
    const settled = contender.catch((e) => e);
    await inspected.promise;
    const holderToken = `${process.pid}:holder`;
    writeFileSync(join(lockDir, 'owner'), holderToken); // the holder finally writes its owner
    release.resolve();

    expect(String(await settled)).toMatch(/still held/);
    expect(readFileSync(join(lockDir, 'owner'), 'utf8')).toBe(holderToken);
  });

  it('withAddGuardLock — release removes only our own token', async () => {
    const { env, root, lockDir } = lockFixture();
    const bIn = deferred(); const gateB = deferred();
    let b;
    await withAddGuardLock(root, env, async () => {
      backdate(lockDir, 11 * 60_000); // pid is live, so age is the only stale path
      b = withAddGuardLock(root, env, async () => { bIn.resolve(); await gateB.promise; });
      await bIn.promise;
    });
    // A's finally has run: B's lock (same pid, different token) must be untouched.
    expect(existsSync(lockDir)).toBe(true);
    gateB.resolve();
    await b;
    expect(existsSync(lockDir)).toBe(false);
  });

  it('withAddGuardLock — a stale .recover mutex is broken and a resumed old recoverer does nothing', async () => {
    const { env, root, lockDir } = lockFixture();
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), String(deadPid()));
    const removing = deferred(); const releaseOld = deferred();
    const bIn = deferred(); const gateB = deferred();

    const old = withAddGuardLock(root, env, async () => 'old', {
      async onPhase(phase) { if (phase === 'removing') { removing.resolve(); await releaseOld.promise; } },
    });
    await removing.promise; // the old recoverer holds `.recover`, then stalls
    backdate(`${lockDir}.recover`, 60_000);

    const b = withAddGuardLock(root, env, async () => { bIn.resolve(); await gateB.promise; });
    await bIn.promise; // B broke the stale `.recover`, recovered the dead lock, and took a fresh one
    const bToken = readFileSync(join(lockDir, 'owner'), 'utf8');

    releaseOld.resolve();
    await sleep(300); // the old recoverer resumes: token/inode/mtime changed, so it must not touch B's lock
    expect(readFileSync(join(lockDir, 'owner'), 'utf8')).toBe(bToken);

    gateB.resolve();
    await expect(Promise.all([b, old])).resolves.toEqual([undefined, 'old']);
  });
});
