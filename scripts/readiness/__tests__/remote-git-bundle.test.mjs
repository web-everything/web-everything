// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanBundleRange } from '../remote-git-bundle.mjs';
import { runRemote } from '../remote-exec.mjs';

const ident = ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid'];
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const exec = async ({ file, args, cwd, input }) => {
  const result = spawnSync(file, args, { cwd, input });
  return { code: result.status ?? 254, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
};
const literal = 'abcdefghij0123456789XYZ';
const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const workflowReference = 'steps:\n  - with:\n      private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}\n';
let root, lane, originMain;
const write = (name, content) => {
  const path = join(lane, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  git(lane, 'add', '--', name);
};
const commit = message => {
  git(lane, ...ident, 'commit', '-q', '-m', message);
  return git(lane, 'rev-parse', 'HEAD');
};
const scan = (injectedExec = exec) => scanBundleRange({
  cwd: lane, head: git(lane, 'rev-parse', 'HEAD'), prerequisite: originMain, exec: injectedExec,
});

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR, 'remote-git-bundle-'));
  const source = join(root, 'public');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'base.txt'), 'public base\n');
  git(source, 'add', '.');
  git(source, ...ident, 'commit', '-q', '-m', 'public base');
  lane = join(root, 'lane');
  git(root, 'clone', source, lane);
  git(lane, 'checkout', '-q', '-b', 'lane');
  originMain = git(lane, 'rev-parse', 'origin/main');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

// Advance public main locally, then merge it with the lane as first parent.
const beginMainMerge = (publicContent = 'public update\n') => {
  git(lane, 'checkout', '-q', 'main');
  write('upstream.yml', publicContent);
  originMain = commit('public update');
  git(lane, 'update-ref', 'refs/remotes/origin/main', originMain);
  git(lane, 'checkout', '-q', 'lane');
  git(lane, ...ident, 'merge', '--no-ff', '--no-commit', 'main');
};

describe('scanBundleRange lane first-parent scope', () => {
  it('does not rescan secret-looking main content already present at origin/main after a lane merge', async () => {
    write('lane.txt', 'clean lane change\n');
    commit('lane change');
    beginMainMerge(`api_key: ${literal}\n`);
    commit('merge main');
    expect(await scan()).toBeNull();
  });

  it('accepts a clean lane with the ci.yml reference after merging secret-looking origin/main content', async () => {
    write('.github/workflows/ci.yml', workflowReference);
    commit('lane workflow');
    beginMainMerge(`api_key: ${literal}\n`);
    commit('merge main');
    expect(await scan()).toBeNull();
  });

  it.each([
    ['literal api_key', `api_key: ${literal}\n`, 'high-entropy-api_key'],
    ['GitHub token', `${token}\n`, 'github-token'],
  ])('still catches a lane-authored %s committed before merging main, even after scrubbing', async (_name, content, finding) => {
    write('lane.yml', content);
    commit('lane change');
    beginMainMerge();
    commit('merge main');
    write('lane.yml', 'clean\n');
    commit('scrub lane');
    expect(await scan()).toMatchObject({ path: 'lane.yml', finding });
  });

  it.each([
    ['literal api_key', `api_key: ${literal}\n`, 'high-entropy-api_key'],
    ['GitHub token', `${token}\n`, 'github-token'],
  ])('catches a %s introduced only in an evil merge resolution, even after scrubbing', async (_name, content, finding) => {
    write('lane.txt', 'clean lane change\n');
    commit('lane change');
    beginMainMerge();
    write('resolution.yml', content);
    commit('merge main with resolution');
    write('resolution.yml', 'clean\n');
    commit('scrub resolution');
    expect(await scan()).toMatchObject({ path: 'resolution.yml', finding });
  });

  it('fails closed with bundle-credential-scan-failed when first-parent Git scoping fails', async () => {
    write('lane.txt', 'clean lane change\n');
    commit('lane change');
    const failingScopeExec = vi.fn(async call => {
      if (call.file === 'git' && call.args.includes('--first-parent')) {
        return { code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('injected first-parent failure') };
      }
      return exec(call);
    });
    await expect(scan(failingScopeExec)).rejects.toMatchObject({ code: 'bundle-credential-scan-failed' });
    expect(failingScopeExec.mock.calls.some(([call]) => call.args.includes('--first-parent'))).toBe(true);
  });
});

describe('runRemote local fallback location logging', () => {
  it.each(['injected log', 'default stderr'])('logs exactly one local location and reason through %s without remote dispatch', async sink => {
    const log = vi.fn(() => true);
    if (sink === 'default stderr') vi.spyOn(process.stderr, 'write').mockImplementation(log);
    const noDispatch = vi.fn(async () => { throw new Error('invalid host must not execute any command'); });
    const result = await runRemote({
      cwd: lane, argv: ['npm', 'run', 'test:unit'], env: {}, host: 'invalid host', exec: noDispatch,
      ...(sink === 'injected log' ? { log } : {}),
    });
    expect(result).toMatchObject({ mode: 'not-started', terminated: true, reason: 'invalid-parameters' });
    expect(noDispatch).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([['location=local reason=invalid-parameters\n']]);
  });
});
