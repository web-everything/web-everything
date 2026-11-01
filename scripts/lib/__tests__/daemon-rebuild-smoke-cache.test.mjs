/** @file Durable full-smoke proofs, using copied ready-test real-git fixtures. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rebuildClone, readRebuildState, readyCandidatePath } from '../daemon-rebuild.mjs';
import { SMOKE_CHECKS, runLiveSmoke } from '../daemon-live-smoke.mjs';
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';
import { writeRebuildState } from '../daemon-rebuild/state.mjs';
import { smokePassKey, smokePassIdentity, smokePassTtlMs, resolveSmokeReuse, smokeHarnessHash } from '../daemon-rebuild/smoke.mjs';

vi.mock('../resource-admission.mjs', () => ({ shadowAdmission: vi.fn(), admit: vi.fn() }));

// Pre-dates daemonRebuild.skipUnrelated: these tests assert a smoke runs for non-code moves, so pin the knob off.
process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

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
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function pushBranch(originDir, ref, mutate) {
  const parent = mktemp('we-rebuild-ready-author-');
  const dir = join(parent, 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  gitOk(dir, ['checkout', '-q', '-B', ref, 'origin/main']);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `change: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}
const advanceMain = (originDir, mutate) => pushBranch(originDir, 'main', mutate);

function makeFixture() {
  const base = mktemp('we-rebuild-ready-fixture-');
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
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-rebuild-ready-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rebuild-ready-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-rebuild-ready-overlay-'),
  };
  return { originDir, cloneDir, env };
}

const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: SMOKE_CHECKS.map(({ name }) => ({ name, ok: true })) } };
const FAIL = { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } };

beforeEach(() => { tempDirs.length = 0; });
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

const rebuild = (f, runSmoke, extra = {}) => rebuildClone({
  root: f.cloneDir, env: f.env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS, ...extra,
});
const head = (f) => gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim();
const identity = (f, sha) => smokePassIdentity((args) => git(f.cloneDir, args), sha, 'clone');

// Move main to a distinct commit with identical content, and restore the clone's original base.
function repeatTree(f, base) {
  const sha = gitOk(f.cloneDir, ['commit-tree', `${head(f)}^{tree}`, '-p', head(f), '-m', 'same content, new commit']).trim();
  gitOk(f.cloneDir, ['push', '-q', 'origin', `${sha}:refs/heads/main`]);
  gitOk(f.cloneDir, ['reset', '--hard', base]);
  return sha;
}

describe('durable smoke pass cache', () => {
  it.each([false, true])('keeps healthy overlays when a cached fallback shares the broken harness (already running: %s)', async (alreadyRunning) => {
    const f = makeFixture();
    const base = head(f);
    advanceMain(f.originDir, dir => writeFile(dir, 'main.txt', 'm'));
    await rebuild(f, async () => PASS);
    if (!alreadyRunning) gitOk(f.cloneDir, ['reset', '--hard', base]);
    pushBranch(f.originDir, 'lane/healthy', dir => writeFile(dir, 'overlay.txt', 'healthy'));
    addOverlay(f.cloneDir, { ref: 'lane/healthy' }, { env: f.env });
    const calls = [];
    const smoke = async (options) => {
      const result = await runLiveSmoke({ ...options, runChild: async (cmd, args, opts) => {
        if (opts.env.GH_CALLER === 'rebuild-smoke:dispatch-dry-run') return 'malformed JSON';
        if (args[1] === 'list') return '[]';
        if (args[1] === 'acquire') return JSON.stringify({ lane: 2 });
        if (cmd === 'node') return JSON.stringify({ ok: true });
        return '';
      } });
      calls.push({ options, result });
      return { verdict: result.pass ? 'pass' : 'code', smoke: result };
    };
    const result = await rebuild(f, smoke);
    expect(result.reason).toBe('harness-broken-adopted-not-worse');
    expect(readOverlays(f.cloneDir, { env: f.env }).map(row => row.ref)).toContain('lane/healthy');
    expect(calls).toHaveLength(3);
    for (const { options, result: checked } of calls) {
      expect(options.reuseCode).toBe(false);
      expect(checked.results.find(row => row.name === 'dispatch-dry-run')).toMatchObject({ ok: false,
        detail: expect.stringContaining('unparsable output') });
      expect(checked.results.filter(row => SMOKE_CHECKS.find(check => check.name === row.name)?.kind === 'env').every(row => row.ok)).toBe(true);
    }
    expect(calls.slice(1).every(({ options }) => options.changedFiles === null)).toBe(true);
  });

  it('reuses code proof for an identical tree while materializing and re-running env checks', async () => {
    const f = makeFixture();
    const base = head(f);
    advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    const smoke = vi.fn(async () => PASS);
    expect((await rebuild(f, smoke)).adopted).toBe(true);
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(smoke.mock.calls[0][0].changedFiles).toBeNull();
    const first = head(f);
    const proofs = readRebuildState(f.cloneDir, f.env).smokePassed;
    expect(proofs).toHaveLength(1);
    expect(existsSync(readyCandidatePath(f.cloneDir, f.env))).toBe(false);
    const target = repeatTree(f, base);
    expect(target).not.toBe(first);
    expect(identity(f, target)).toEqual(identity(f, first));
    const run = vi.fn((args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }));
    const log = { error: vi.fn() };
    const second = await rebuild(f, smoke, { run, log });
    expect(log.error).toHaveBeenCalledWith(`daemon-rebuild: smoke reused from ${proofs[0].passedAt} on tree ${proofs[0].tree} (env checks re-run)`);
    expect(second.adopted).toBe(true);
    expect(head(f)).toBe(target);
    expect(smoke).toHaveBeenCalledTimes(2);
    expect(smoke.mock.calls[1][0].reuseCode).toBe(true);
    expect(run.mock.calls.some(([args]) => args.includes('worktree') && args.includes('add'))).toBe(true);
    expect(readRebuildState(f.cloneDir, f.env).smokePassed).toEqual(proofs);
  });

  it.each(['a.txt', 'package-lock.json'])('smokes changed content in %s', async (file) => {
    const f = makeFixture();
    advanceMain(f.originDir, (dir) => writeFile(dir, file, 'first'));
    const smoke = vi.fn(async () => PASS);
    await rebuild(f, smoke);
    const first = identity(f, head(f));
    advanceMain(f.originDir, (dir) => writeFile(dir, file, 'second'));
    expect((await rebuild(f, smoke)).adopted).toBe(true);
    expect(smoke).toHaveBeenCalledTimes(2);
    expect(identity(f, head(f)).key).not.toBe(first.key);
  });

  it.each(['code', 'transient', 'threw', 'cached', 'busy', 'partial', 'skipped', 'disabled'])('does not record a %s result', async (kind) => {
    const f = makeFixture();
    const base = head(f);
    const target = advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    const smoke = vi.fn(async () => {
      if (kind === 'partial') return { ...PASS, smoke: { results: PASS.smoke.results.slice(1) } };
      if (kind === 'skipped') return { ...PASS, smoke: { results: PASS.smoke.results.map(row => ({ ...row, skipped: true })) } };
      if (kind === 'disabled') return { ...PASS, disabled: true };
      if (kind === 'threw') throw new Error('smoke error');
      if (kind === 'cached') return { ...PASS, cached: true };
      if (kind === 'busy') return { verdict: 'pass', smoke: { results: [{ name: 'pool', ok: true, skipReason: 'busy-pool' }] } };
      return { ...FAIL, verdict: kind };
    });
    await rebuild(f, smoke);
    expect(readRebuildState(f.cloneDir, f.env).smokePassed).toBeNull();
    // Retry a different commit of the rejected tree, avoiding the existing inputs rejection gate.
    gitOk(f.cloneDir, ['reset', '--hard', target]);
    repeatTree(f, base);
    const retry = vi.fn(async () => PASS);
    expect((await rebuild(f, retry)).adopted).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('never records the fallback confirm pass of a failed A', async () => {
    const f = makeFixture();
    advanceMain(f.originDir, (dir) => writeFile(dir, 'main.txt', 'm'));
    pushBranch(f.originDir, 'lane/overlay', (dir) => writeFile(dir, 'overlay.txt', 'o'));
    addOverlay(f.cloneDir, { ref: 'lane/overlay' }, { env: f.env });
    let calls = 0;
    const smoke = vi.fn(async () => {
      calls++;
      return calls === 1 ? { verdict: 'code', smoke: { results: [{
        ok: false, name: 'dispatch-dry-run', mayBeTransient: false, ms: 45_100,
        detail: 'dispatch dry-run child failed: timed out after 45000ms (process group killed)',
      }] } } : PASS;
    });
    const result = await rebuild(f, smoke);
    expect(result.reason).toBe('smoke-load-confirm-passed');
    expect(smoke).toHaveBeenCalledTimes(3);
    const proofs = readRebuildState(f.cloneDir, f.env).smokePassed;
    expect(proofs).toHaveLength(1); // B passed a full smoke; the confirm of A is excluded.
    expect(proofs[0].key).not.toBe(identity(f, head(f)).key);
  });

  it('does not record skip-unchanged passes', async () => {
    const f = makeFixture();
    advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    await rebuild(f, async () => PASS);
    const proofs = readRebuildState(f.cloneDir, f.env).smokePassed;
    advanceMain(f.originDir, (dir) => writeFile(dir, 'b.txt', 'b'));
    const smoke = vi.fn(async () => PASS);
    await rebuild(f, smoke);
    expect(smoke.mock.calls[0][0].changedFiles).toEqual(['b.txt']);
    expect(readRebuildState(f.cloneDir, f.env).smokePassed).toEqual(proofs);
  });

  it('smokes an expired proof and deduplicates the refreshed entry', async () => {
    const f = makeFixture();
    f.env.WE_REBUILD_SMOKE_REUSE_HOURS = String(1 / 3600);
    const base = head(f);
    advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    const time = Date.now();
    await rebuild(f, async () => PASS, { now: () => time });
    repeatTree(f, base);
    const smoke = vi.fn(async () => PASS);
    await rebuild(f, smoke, { now: () => time + 1001 });
    expect(smoke).toHaveBeenCalledTimes(1);
    const proofs = readRebuildState(f.cloneDir, f.env).smokePassed;
    expect(proofs).toHaveLength(1);
    expect(proofs[0].passedAt).toBe(new Date(time + 1001).toISOString());
  });

  it.each(['disabled', 'partial', 'env-failed'])('%s cannot bypass a new smoke', async kind => {
    const f = makeFixture();
    const base = head(f);
    advanceMain(f.originDir, dir => writeFile(dir, 'a.txt', 'a'));
    await rebuild(f, async () => kind === 'partial' ? { verdict: 'pass', smoke: { results: [] } } : PASS);
    repeatTree(f, base);
    if (kind === 'disabled') f.env.WE_REBUILD_SMOKE_REUSE_ENABLED = '0';
    const smoke = vi.fn(async () => kind === 'env-failed'
      ? { verdict: 'code', smoke: { results: [{ name: 'daemon-entries-boot', ok: false, detail: 'boot failed' }] } } : PASS);
    const result = await rebuild(f, smoke);
    expect(smoke.mock.calls[0][0].reuseCode).toBe(kind === 'env-failed');
    if (kind === 'env-failed') {
      expect(result.moved).toBe(false);
      expect(head(f)).toBe(base);
      expect(result.reason).toBe('smoke-reused-env-failed');
      expect(smoke).toHaveBeenCalledTimes(1);
    }
  });

  it('runs all six env rows and skips only code rows in the live runner', async () => {
    const runChild = vi.fn(async (cmd, args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'acquire') return JSON.stringify({ lane: 2 });
      if (cmd === 'node') return JSON.stringify({ ok: true });
      return '';
    });
    const smoke = await runLiveSmoke({ root: '.', env: {}, runChild, reuseCode: true,
      changedFiles: [], closureOf: () => { throw new Error('must not inspect closure'); } });
    expect(smoke.pass).toBe(true);
    expect(smoke.results.filter(row => row.skipped).map(row => row.name)).toEqual(['reconcile-dry-run', 'dispatch-dry-run']);
    expect(smoke.results.filter(row => !row.skipped).map(row => row.name)).toEqual(SMOKE_CHECKS.filter(row => row.kind === 'env').map(row => row.name));
    expect(SMOKE_CHECKS.every(row => ['code', 'env'].includes(row.kind))).toBe(true);
    const failed = await runLiveSmoke({ root: '.', env: {}, reuseCode: true, runChild: async (cmd, args, opts) => {
      if (cmd === 'gh') throw new Error('environment failed');
      return runChild(cmd, args, opts);
    } });
    expect(failed.pass).toBe(false);
  });

  it('retains only the newest five proofs', async () => {
    const f = makeFixture();
    const base = head(f);
    for (let i = 0; i < 6; i++) {
      advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', String(i)));
      gitOk(f.cloneDir, ['reset', '--hard', base]);
      await rebuild(f, async () => PASS);
    }
    const proofs = readRebuildState(f.cloneDir, f.env).smokePassed;
    expect(proofs).toHaveLength(5);
    expect(proofs[0].key).toBe(identity(f, head(f)).key);
  });

  it.each(['lockHash', 'nodeVersion', 'harnessHash', 'cloneKind'])('does not reuse a proof with a different %s', async (field) => {
    const f = makeFixture();
    const target = advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
    const tree = identity(f, target).tree;
    const parts = { tree, cloneKind: 'clone', lockHash: '', nodeVersion: process.version,
      harnessHash: smokeHarnessHash() };
    expect(smokePassKey(parts)).toBe(identity(f, target).key);
    writeRebuildState(f.cloneDir, { smokePassed: [{ tree, key: smokePassKey({ ...parts, [field]: 'different' }), passedAt: new Date().toISOString() }] }, f.env);
    const smoke = vi.fn(async () => PASS);
    await rebuild(f, smoke);
    expect(smoke).toHaveBeenCalledTimes(1);
  });

  it('defaults to twelve hours and resolves overrides with sources', () => {
    expect(smokePassTtlMs({})).toBe(43_200_000);
    expect(resolveSmokeReuse({ WE_REBUILD_SMOKE_REUSE_ENABLED: '0', WE_REBUILD_SMOKE_REUSE_HOURS: '3' })).toMatchObject({
      reuseEnabled: false, reuseHours: 3, sources: { reuseEnabled: 'env', reuseHours: 'env' },
    });
    expect(resolveSmokeReuse({ WE_REBUILD_SMOKE_REUSE_HOURS: '-1' }).reuseHours).toBe(12);
    expect(smokePassTtlMs({ WE_REBUILD_SMOKE_REUSE_HOURS: '0' })).toBe(0);
    expect(smokePassTtlMs({ WE_REBUILD_SMOKE_REUSE_HOURS: '2' })).toBe(7_200_000);
  });
}, 60_000);
