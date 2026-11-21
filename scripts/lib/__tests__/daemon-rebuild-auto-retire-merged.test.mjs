import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { proveRetirement } from '../../daemon-overlay.mjs';
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';

vi.setConfig({ testTimeout: 60_000 });
const temps = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
const git = (cwd, args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

async function fixture({ second = false, attributes = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'we-auto-retire-'));
  temps.push(base);
  const origin = join(base, 'origin.git'), root = join(base, 'clone'), author = join(base, 'author');
  git(base, ['init', '--bare', '-q', origin]);
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'worker.txt'), 'initial\n');
  if (attributes) writeFileSync(join(root, '.gitattributes'), 'worker.txt merge=discard\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-qu', 'origin', 'main']);
  git(base, ['clone', '-q', '-b', 'main', origin, author]);
  const initial = git(author, ['rev-parse', 'HEAD']);
  const push = (ref, from, file, content) => {
    git(author, ['checkout', '-qB', ref, from]);
    writeFileSync(join(author, file), content);
    if (ref === 'lane/worker-m1') writeFileSync(join(author, 'snapshot.txt'), 'baseline change\n');
    git(author, ['add', '.']);
    git(author, ['commit', '-qm', ref]);
    git(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
    return git(author, ['rev-parse', 'HEAD']);
  };
  // A snapshot of a PR, with a different commit identity from its squash merge on main.
  const ref = 'lane/worker-m1';
  const tip = push(ref, initial, 'worker.txt', 'PR change\n');
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(base, 'state'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'), WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_REBUILD_SKIP_UNRELATED: '0', WE_DAEMON_AUTO_REBASE: '0', WE_OVERLAY_STALE: '0' };
  addOverlay(root, { ref, pr: null }, { env });
  if (second) {
    push('lane/other-m1', initial, 'other.txt', 'other PR\n');
    addOverlay(root, { ref: 'lane/other-m1', pr: null }, { env });
  }
  const runSmoke = vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }));
  const options = { root, env, runSmoke, asJob: false, prState: async () => 'OPEN',
    prBaseChain: () => [], log: { error() {} } };
  expect(await rebuildClone(options)).toMatchObject({ adopted: true });
  const liveHead = git(root, ['rev-parse', 'HEAD']);
  const merged = push('main', initial, 'worker.txt', 'PR change\n');
  const baseline = push('main', merged, 'snapshot.txt', 'baseline change\n');
  push('main', baseline, 'worker.txt', 'main subsequent rewrite\n');
  if (second) push('main', 'main', 'other.txt', 'main other rewrite\n');
  runSmoke.mockClear();
  return { ...options, options, ref, tip, liveHead };
}

// Proof and remote IO are injected; the real guarded retirement still removes the registration.
const approved = (tip) => ({ action: 'retire', reason: 'pr-merged', tip,
  evidence: { prState: 'MERGED', prVia: 'merge-ref-base', contentInMain: true } });

describe('rebuild retirement before established overlay hold', () => {
  it('an overlay whose PR is merged is retired automatically on the next rebuild instead of failing established-overlay-conflict', async () => {
    const f = await fixture();
    expect(await rebuildClone({ ...f.options, deps: { prove: () => ({ action: 'keep', reason: 'not-proved' }) } }))
      .toMatchObject({ reason: 'established-overlay-conflict' });
    const entry = readOverlays(f.root, { env: f.env })[0];
    const prove = vi.fn(() => approved(f.tip));
    const result = await rebuildClone({ ...f.options, deps: { prove, tip: () => f.tip } });
    expect(result).toMatchObject({ moved: false, reason: 'established-overlay-retired' });
    expect(prove).toHaveBeenCalledWith(entry);
    expect(readOverlays(f.root, { env: f.env })).toEqual([]);
    expect(readRebuildState(f.root, f.env).held ?? null).toBeNull();
    expect(f.runSmoke).not.toHaveBeenCalled();
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.liveHead);
    expect(await rebuildClone(f.options)).toMatchObject({ adopted: true });
  });

  it.each(['pr-open', 'unique-commits-not-on-main', 'not-proved', 'stacked'])('keeps the hold when retirement proof refuses: %s', async (reason) => {
    const f = await fixture();
    const prove = vi.fn(() => ({ action: 'keep', reason, tip: f.tip }));
    const result = await rebuildClone({ ...f.options, deps: { prove, tip: () => f.tip } });
    expect(prove).toHaveBeenCalledOnce();
    expect(result.reason).toBe('established-overlay-conflict');
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
    expect(readRebuildState(f.root, f.env).held).toMatchObject({ reason: 'established-overlay-conflict' });
    expect(f.runSmoke).not.toHaveBeenCalled();
  });

  it.each(['in-main', 'pr-merged'])('allows only landed proof reasons: %s', async (reason) => {
    const f = await fixture();
    const result = await rebuildClone({ ...f.options, deps: {
      prove: () => ({ ...approved(f.tip), reason }), tip: () => f.tip,
    } });
    expect(result.reason).toBe('established-overlay-retired');
    expect(readOverlays(f.root, { env: f.env })).toEqual([]);
  });

  it.each(['redundant-merge-sibling', 'superseded', 'pr-squash-merged', 'unknown', undefined])(
    'keeps the hold for a disallowed retire reason: %s', async (reason) => {
      const f = await fixture();
      const result = await rebuildClone({ ...f.options, deps: {
        prove: () => ({ ...approved(f.tip), reason }),
      } });
      expect(result.reason).toBe('established-overlay-conflict');
      expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
      expect(readRebuildState(f.root, f.env).held).toMatchObject({ reason: 'established-overlay-conflict' });
      expect(f.runSmoke).not.toHaveBeenCalled();
    });

  it('real retirement proof keeps a MERGED snapshot with remaining work and ignores inherited merge drivers', async () => {
    const f = await fixture({ attributes: true });
    const config = join(f.env.WE_DAEMON_STATE_DIR, 'host.gitconfig');
    writeFileSync(config, '[merge "discard"]\n  driver = true\n');
    const env = { ...f.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config };
    const gh = vi.fn((args) => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({
        nameWithOwner: 'test/repo', url: 'https://github.com/test/repo',
      }) };
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      return { status: 0, stdout: JSON.stringify([{ number: 7, state: 'MERGED', headRefName: f.ref }]) };
    });
    const run = (cmd, args, opts) => {
      if (cmd === 'gh') return gh(args);
      expect(cmd).toBe('git');
      return spawnSync(cmd, args, { ...opts, maxBuffer: 1024 * 1024 });
    };
    const prove = vi.fn((entry) => proveRetirement({ root: f.root, entry, env, run }));
    const result = await rebuildClone({ ...f.options, deps: { prove } });
    expect(prove).toHaveBeenCalledOnce();
    expect(gh).toHaveBeenCalled();
    expect(prove.mock.results[0].value).toMatchObject({ action: 'keep', reason: 'unique-commits-not-on-main',
      evidence: { contentInMain: false } });
    expect(result.reason).toBe('established-overlay-conflict');
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
    expect(f.runSmoke).not.toHaveBeenCalled();
  });

  it('keeps the hold when retirement throws', async () => {
    const f = await fixture();
    const result = await rebuildClone({ ...f.options, deps: { prove: () => { throw new Error('unreadable'); } } });
    expect(result.reason).toBe('established-overlay-conflict');
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
  });

  it('keeps the hold when the proof names a different tip', async () => {
    const f = await fixture();
    const result = await rebuildClone({ ...f.options, deps: { prove: () => approved('a'.repeat(40)) } });
    expect(result.reason).toBe('established-overlay-conflict');
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
  });

  it('does not attempt retirement during read-only preparation', async () => {
    const f = await fixture();
    const retireRegistration = vi.fn();
    await rebuildClone({ ...f.options, readyOnly: true, deps: { retireRegistration } });
    expect(retireRegistration).not.toHaveBeenCalled();
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
  });

  it('holds only remaining lost refs after a partial retirement', async () => {
    const f = await fixture({ second: true });
    const result = await rebuildClone({ ...f.options, deps: {
      prove: (entry) => entry.ref === f.ref ? approved(f.tip) : { action: 'keep', reason: 'pr-open' },
      tip: () => f.tip,
    } });
    expect(result).toMatchObject({ reason: 'established-overlay-conflict', detail: { refs: ['lane/other-m1'] } });
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual(['lane/other-m1']);
    expect(readRebuildState(f.root, f.env).held).toMatchObject({ reason: 'established-overlay-conflict' });
  });
});
