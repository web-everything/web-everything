import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addOverlay, readOverlays, writeOverlays } from '../../daemon-overlays.mjs';
import { planRebuild } from '../plan.mjs';
import { rebuildClone } from '../index.mjs';

const ref = 'lane/exact-pin';
let base, root, origin, author, env, main, a, b;

function git(cwd, args, extraEnv = {}) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20_000,
    killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
function commit(name, content) {
  writeFileSync(join(author, name), content);
  gitOk(author, ['add', name]);
  gitOk(author, ['commit', '-q', '-m', name]);
  return gitOk(author, ['rev-parse', 'HEAD']);
}
function register(expectedSha = a) {
  addOverlay(root, { ref, pinned: true, ...(expectedSha ? { expectedSha } : {}) }, { env });
  // Isolate the planner contract from the writer's missing persistence (tested separately).
  // Seed the on-disk entry a fixed writer will produce, also exercising persisted state reads.
  if (expectedSha) writeOverlays(root, readOverlays(root, { env }).map(o => ({ ...o, expectedSha })), { env });
}
function advance({ sibling = false } = {}) {
  if (sibling) gitOk(author, ['checkout', '-q', '-B', ref, main]);
  b = commit('unapproved-B.txt', 'unapproved B\n');
  gitOk(author, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${ref}`]);
  gitOk(root, ['fetch', '-q', 'origin']);
}
function missingA() {
  // A is a sibling of B here: removing A cannot break B's ancestry or tree.
  advance({ sibling: true });
  rmSync(join(root, '.git', 'objects', a.slice(0, 2), a.slice(2)));
  expect(git(root, ['cat-file', '-e', `${a}^{commit}`]).status).not.toBe(0);
  expect(gitOk(root, ['rev-parse', `origin/${ref}`])).toBe(b);
}
function plan(probe = (args, opts = {}) => git(root, args, opts.env)) {
  return planRebuild({ git: probe, headSha: main, mainRef: 'origin/main',
    overlays: readOverlays(root, { env }), prState: () => null });
}
function assertOnlyA(result) {
  expect(result.ok).toBe(true);
  expect(result.applied).toContainEqual(expect.objectContaining({ ref, sha: a, pinnedFrom: b }));
  expect(gitOk(root, ['show', `${result.finalSha}:approved-A.txt`])).toBe('approved A');
  expect(gitOk(root, ['ls-tree', '-r', '--name-only', result.finalSha]).split('\n')).not.toContain('unapproved-B.txt');
  expect(git(root, ['merge-base', '--is-ancestor', b, result.finalSha]).status).toBe(1);
}

beforeEach(() => {
  base = mkdtempSync(join(process.env.TMPDIR, 'overlay-sha-pin-'));
  root = join(base, 'clone');
  origin = join(base, 'origin.git');
  author = join(base, 'author');
  env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
    WE_NEEDS_YOU_FEED: join(base, 'attention.jsonl'), WE_DAEMON_AUTO_REBASE: '0',
    WE_OVERLAY_STALE: '0', WE_DAEMON_OVERLAY_FOLLOW_TIP: '1' };
  mkdirSync(author);
  gitOk(base, ['init', '--bare', '-q', origin]);
  gitOk(author, ['init', '-q', '-b', 'main']);
  main = commit('README.md', 'main\n');
  gitOk(author, ['remote', 'add', 'origin', origin]);
  gitOk(author, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(base, ['clone', '-q', '--branch=main', origin, root]);
  gitOk(author, ['checkout', '-q', '-b', ref]);
  a = commit('approved-A.txt', 'approved A\n');
  gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  gitOk(root, ['fetch', '-q', 'origin']);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

describe('exact-SHA overlay pin', () => {
  it('plans A after registration at A and a push of B, reports pinnedFrom B, and excludes B from the result tree', async () => {
    register();
    advance();
    assertOnlyA(await plan());
    expect(gitOk(root, ['rev-parse', 'HEAD'])).toBe(main);
  });

  it('rebuilds and adopts A after the branch advances to B, without B in HEAD', async () => {
    register();
    advance();
    const result = await rebuildClone({ root, env, prState: () => null, prBaseChain: () => [],
      runSmoke: async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }) });
    assertOnlyA(result.plan);
    expect(result.moved).toBe(true);
    expect(gitOk(root, ['rev-parse', 'HEAD'])).toBe(result.plan.finalSha);
    expect(git(root, ['merge-base', '--is-ancestor', b, 'HEAD']).status).toBe(1);
  });

  it('fetches missing A by exact SHA from origin and verifies the fetched commit before applying it', async () => {
    register();
    missingA();
    const probe = vi.fn((args, opts = {}) => git(root, args, opts.env));
    const result = await plan(probe);
    expect(probe.mock.calls.some(([args]) => args[0] === 'fetch' && args.includes('origin') && args.includes(a))).toBe(true);
    expect(gitOk(root, ['rev-parse', '--verify', `${a}^{commit}`])).toBe(a);
    assertOnlyA(result);
  });

  it.each(['fetch fails', 'fetch succeeds without the object', 'verification resolves to a different SHA'])(
    'REFUSES when %s, holding the last good HEAD and registration', async (failure) => {
      register();
      missingA();
      let fetched = false;
      const probe = vi.fn((args, opts = {}) => {
        if (args[0] === 'fetch' && args.includes(a)) {
          fetched = true;
          return { status: failure === 'fetch fails' ? 128 : 0, stdout: '', stderr: 'injected exact-fetch outcome' };
        }
        if (fetched && failure === 'verification resolves to a different SHA'
          && args[0] === 'rev-parse' && args.some(arg => arg === a || arg === `${a}^{commit}`)) {
          return { status: 0, stdout: b + '\n', stderr: '' };
        }
        return git(root, args, opts.env);
      });
      const before = readOverlays(root, { env });
      const result = await plan(probe);
      expect(result.ok).toBe(false);
      expect(fetched).toBe(true);
      expect(result.reason).toEqual(expect.any(String));
      const runSmoke = vi.fn();
      const rebuilt = await rebuildClone({ root, env, prState: () => null, prBaseChain: () => [],
        run: probe, runSmoke });
      expect(rebuilt.moved).toBe(false);
      expect(runSmoke).not.toHaveBeenCalled();
      expect(gitOk(root, ['rev-parse', 'HEAD'])).toBe(main);
      expect(readOverlays(root, { env })).toEqual(before);
      expect(gitOk(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).not.toContain('unapproved-B.txt');
    },
  );

  it('keeps following the branch tip for an old pinned entry without expectedSha', async () => {
    register(null);
    advance();
    const result = await plan();
    expect(result.ok).toBe(true);
    expect(result.applied).toContainEqual(expect.objectContaining({ ref, sha: b }));
    expect(result.applied.find(o => o.ref === ref).pinnedFrom).toBeUndefined();
    expect(gitOk(root, ['show', `${result.finalSha}:unapproved-B.txt`])).toBe('unapproved B');
  });
});
