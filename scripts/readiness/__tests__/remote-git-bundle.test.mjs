// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanBundleRange } from '../remote-git-bundle.mjs';
import { logLocalLocation, runRemote } from '../remote-exec.mjs';

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
  it('rejects a regular-file-to-symlink mode-only transition with the same prerequisite path and blob', async () => {
    write('link.txt', '.env.local');
    originMain = commit('public regular file');
    const sha = git(lane, 'rev-parse', `${originMain}:link.txt`);
    git(lane, 'update-index', '--cacheinfo', `120000,${sha},link.txt`);
    commit('lane mode-only transition');
    expect(git(lane, 'ls-tree', 'HEAD', '--', 'link.txt')).toBe(`120000 blob ${sha}\tlink.txt`);
    expect(await scan()).toEqual({ path: 'link.txt', finding: 'symlink' });
  });

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

  it.each([
    ['literal api_key', `api_key: ${literal}\n`, 'high-entropy-api_key'],
    ['GitHub token', `${token}\n`, 'github-token'],
  ])('catches a %s added and deleted on a merged side branch, though the merge tree is clean', async (_name, content, finding) => {
    write('lane.txt', 'clean lane change\n');
    commit('lane change');
    git(lane, 'checkout', '-q', '-b', 'side');
    write('side.yml', content);
    commit('side adds credential');
    git(lane, 'rm', '-q', '--', 'side.yml');
    commit('side removes credential');
    git(lane, 'checkout', '-q', 'lane');
    git(lane, ...ident, 'merge', '--no-ff', '-q', '-m', 'merge side', 'side');
    expect(git(lane, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('side.yml');
    expect(await scan()).toMatchObject({ path: 'side.yml', finding });
  });

  // The prerequisite-skip key is path + mode + blob sha: an entry is skipped only when ALL THREE equal origin/main's.
  it('scans a public path whose blob changed to a credential (same path and mode, different sha)', async () => {
    write('cfg.yml', 'public\n');
    originMain = commit('public cfg');
    write('cfg.yml', `api_key: ${literal}\n`);
    commit('lane edits cfg');
    expect(await scan()).toMatchObject({ path: 'cfg.yml', finding: 'high-entropy-api_key' });
  });

  it.each([
    ['a credential-looking blob copied to a new path', 'copy.yml', 'high-entropy-api_key'],
    ['a public blob copied to an excluded path', 'keys/server.pem', 'excluded-path'],
  ])('scans %s (same mode and sha, different path)', async (_name, path, finding) => {
    write('public.yml', `api_key: ${literal}\n`);
    originMain = commit('public blob');
    write(path, `api_key: ${literal}\n`);
    commit('lane copies public blob');
    expect(await scan()).toMatchObject({ path, finding });
  });

  it.each(['deploy/id_rsa', 'certs/server.pem', 'keys/signing.key'])('rejects a lane-added regular key file %s even with innocuous contents', async path => {
    write(path, 'not a secret\n');
    commit('lane adds key-named file');
    expect(await scan()).toEqual({ path, finding: 'excluded-path' });
  });
});

describe('scanBundleRange fails closed on every Git failure shape', () => {
  const ok = (stdout = '') => ({ code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
  const sha = 'a'.repeat(40);
  const failing = (matches, reply) => vi.fn(async call => (matches(call) ? reply(call) : exec(call)));
  const isLsTree = call => call.args.includes('ls-tree');
  const isRevList = call => call.args.includes('rev-list');
  const isRawLog = call => call.args.includes('--raw');
  const isMessageLog = call => call.args.includes('log') && call.args.some(arg => arg.startsWith('--format=%an'));

  it.each([
    ['non-zero exit', () => ({ code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') })],
    ['thrown exec', () => { throw new Error('spawn failed'); }],
    ['null stdout', () => ({ code: 0, stdout: null, stderr: Buffer.alloc(0) })],
    ['output without trailing NUL', () => ok(`100644 blob ${sha}\tbase.txt`)],
    ['malformed meta', () => ok('not-a-mode blob zzz\tbase.txt\0')],
    ['entry without a tab', () => ok('no-tab-entry\0')],
    ['entry with an empty path', () => ok(`100644 blob ${sha}\t\0`)],
  ])('refuses when the prerequisite ls-tree has %s', async (_name, reply) => {
    write('lane.txt', 'clean lane change\n');
    commit('lane change');
    const injected = failing(isLsTree, reply);
    await expect(scan(injected)).rejects.toMatchObject({ code: 'bundle-credential-scan-failed' });
    expect(injected.mock.calls.some(([call]) => isLsTree(call))).toBe(true);
  });

  it.each([
    ['rev-list non-zero exit', isRevList, () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') })],
    ['rev-list returns a non-SHA token', isRevList, () => ok('not-a-sha\n')],
    ['rev-list succeeds with null stdout', isRevList, () => ({ code: 0, stdout: null, stderr: Buffer.alloc(0) })],
    ['rev-list output is not newline-terminated', isRevList, () => ok(sha)],
    ['commit-message log succeeds with null stdout', isMessageLog, () => ({ code: 0, stdout: null, stderr: Buffer.alloc(0) })],
    ['commit-message log non-zero exit', isMessageLog, () => ({ code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') })],
    ['log throws', isRawLog, () => { throw new Error('spawn failed'); }],
    ['log non-zero exit', isRawLog, () => ({ code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') })],
    ['log null stdout', isRawLog, () => ({ code: 0, stdout: null, stderr: Buffer.alloc(0) })],
  ])('refuses when %s', async (_name, matches, reply) => {
    write('lane.txt', 'clean lane change\n');
    commit('lane change');
    const injected = failing(matches, reply);
    await expect(scan(injected)).rejects.toMatchObject({ code: 'bundle-credential-scan-failed' });
    expect(injected.mock.calls.some(([call]) => matches(call))).toBe(true);
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

describe('logLocalLocation', () => {
  it.each(['not-started', 'fallback'])('logs exactly one location line for a %s result', mode => {
    const log = vi.fn();
    logLocalLocation({ mode, reason: 'forge-busy' }, log);
    expect(log.mock.calls).toEqual([['location=local reason=forge-busy\n']]);
  });

  it.each([
    ['LF', 'x\nlocation=remote'], ['CR', 'x\rlocation=remote'], ['CRLF', 'x\r\nlocation=remote'],
    ['U+2028', 'x location=remote'], ['U+2029', 'x location=remote'], ['NEL', 'x\u0085location=remote'],
    ['ESC', 'x\u001b[2Jlocation=remote'], ['NUL', 'x\u0000location=remote'],
  ])('strips %s from a fallback reason so exactly one sanitised line is written', (_name, reason) => {
    const log = vi.fn();
    logLocalLocation({ mode: 'fallback', reason: `forge-rejected:${reason}` }, log);
    expect(log).toHaveBeenCalledTimes(1);
    const [[line]] = log.mock.calls;
    expect(line.endsWith('\n') && line.indexOf('\n') === line.length - 1).toBe(true);
    expect(line).toMatch(/^location=local reason=forge-rejected:x(?:\[2J)?location=remote\n$/);
  });

  it.each([
    [{ mode: 'remote', reason: 'x' }], [{ mode: 'unconfirmed', reason: 'ambiguous-result' }],
    [{ mode: 'not-started' }], [{ mode: 'fallback', reason: '' }], [undefined],
  ])('writes nothing for %j', result => {
    const log = vi.fn();
    logLocalLocation(result, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('scanBundleRange changed-lines scan of modified blobs', () => {
  const seedPublicToken = () => {
    git(lane, 'checkout', '-q', 'main');
    write('notes.md', `intro\n${token}\nouter\n`);
    originMain = commit('public notes with a legacy token line');
    git(lane, 'update-ref', 'refs/remotes/origin/main', originMain);
    git(lane, 'checkout', '-q', '-B', 'lane');
  };
  const scanWith = (extra = {}) => scanBundleRange({
    cwd: lane, head: git(lane, 'rev-parse', 'HEAD'), prerequisite: originMain, exec, ...extra,
  });

  it('does not refuse an unrelated one-line edit to a file whose existing lines trip the scan', async () => {
    seedPublicToken();
    write('notes.md', `intro changed\n${token}\nouter\n`);
    commit('unrelated edit');
    expect(await scanWith()).toBeNull();
  });

  it('still refuses a newly added secret line in a modified file', async () => {
    seedPublicToken();
    write('notes.md', `intro\n${token}\nouter\n${'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'}\n`);
    commit('adds a new secret line');
    expect(await scanWith()).toMatchObject({ path: 'notes.md', finding: 'github-token' });
  });

  it('still scans an added file whole', async () => {
    seedPublicToken();
    write('added.md', `${token}\n`);
    commit('adds a file');
    expect(await scanWith()).toMatchObject({ path: 'added.md', finding: 'github-token' });
  });

  it('keeps the whole-blob scan when the bundleScan off switch is set', async () => {
    seedPublicToken();
    write('notes.md', `intro changed\n${token}\nouter\n`);
    commit('unrelated edit');
    expect(await scanWith({ bundleScan: 'whole-blob' })).toMatchObject({ path: 'notes.md', finding: 'github-token' });
  });

  it('fails closed when the blob diff cannot be read', async () => {
    seedPublicToken();
    write('notes.md', `intro changed\n${token}\nouter\n`);
    commit('unrelated edit');
    const failing = async (call) => (call.args.includes('diff') ? { code: 128, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : exec(call));
    await expect(scanWith({ exec: failing })).rejects.toMatchObject({ code: 'bundle-credential-scan-failed' });
  });

  it('scans a binary modified blob whole', async () => {
    seedPublicToken();
    write('notes.md', Buffer.concat([Buffer.from(`${token}\n`), Buffer.from([0, 1, 2, 3])]));
    commit('binary edit');
    expect(await scanWith()).not.toBeNull();
  });
});
