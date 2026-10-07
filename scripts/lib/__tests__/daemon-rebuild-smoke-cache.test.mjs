/** @file Durable full-smoke proofs, using copied ready-test real-git fixtures. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rebuildClone, readRebuildState, readyCandidatePath } from '../daemon-rebuild.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import { writeRebuildState } from '../daemon-rebuild/state.mjs';
import { smokePassKey, smokePassIdentity, smokePassTtlMs } from '../daemon-rebuild/smoke.mjs';

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
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
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
const identity = (f, sha) => smokePassIdentity((args) => git(f.cloneDir, args), sha);

// Move main to a distinct commit with identical content, and restore the clone's original base.
function repeatTree(f, base) {
  const sha = gitOk(f.cloneDir, ['commit-tree', `${head(f)}^{tree}`, '-p', head(f), '-m', 'same content, new commit']).trim();
  gitOk(f.cloneDir, ['push', '-q', 'origin', `${sha}:refs/heads/main`]);
  gitOk(f.cloneDir, ['reset', '--hard', base]);
  return sha;
}

describe('durable smoke pass cache', () => {
  it('adopts a new SHA of a proven tree after the ready record was cleared, without a worktree', async () => {
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
    const second = await rebuild(f, smoke, { run });
    expect(second.adopted).toBe(true);
    expect(head(f)).toBe(target);
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.some(([args]) => args.includes('worktree') && args.includes('add'))).toBe(false);
    expect(second.alerts).toContainEqual({ kind: 'smoke-skipped-proven-tree', detail: {
      tree: proofs[0].tree, provenAt: proofs[0].passedAt,
      reason: 'tree already passed a full smoke (same lock, node, harness)',
    } });
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

  it.each(['code', 'transient', 'threw', 'cached', 'busy'])('does not record a %s result', async (kind) => {
    const f = makeFixture();
    const base = head(f);
    const target = advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    const smoke = vi.fn(async () => {
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
    f.env.WE_DAEMON_SMOKE_PASS_TTL_MS = '1000';
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

  it.each(['lockHash', 'nodeVersion', 'harnessHash'])('does not reuse a proof with a different %s', async (field) => {
    const f = makeFixture();
    const target = advanceMain(f.originDir, (dir) => writeFile(dir, 'a.txt', 'a'));
    gitOk(f.cloneDir, ['fetch', '-q', 'origin']);
    const tree = identity(f, target).tree;
    const parts = { tree, lockHash: '', nodeVersion: process.version,
      harnessHash: createHash('sha256').update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../daemon-live-smoke.mjs'))).digest('hex') };
    expect(smokePassKey(parts)).toBe(identity(f, target).key);
    writeRebuildState(f.cloneDir, { smokePassed: [{ tree, key: smokePassKey({ ...parts, [field]: 'different' }), passedAt: new Date().toISOString() }] }, f.env);
    const smoke = vi.fn(async () => PASS);
    await rebuild(f, smoke);
    expect(smoke).toHaveBeenCalledTimes(1);
  });

  it('defaults to two hours and honors zero and explicit TTL settings', () => {
    expect(smokePassTtlMs({})).toBe(7_200_000);
    expect(smokePassTtlMs({ WE_DAEMON_SMOKE_PASS_TTL_MS: '0' })).toBe(0);
    expect(smokePassTtlMs({ WE_DAEMON_SMOKE_PASS_TTL_MS: '123' })).toBe(123);
  });
}, 60_000);
