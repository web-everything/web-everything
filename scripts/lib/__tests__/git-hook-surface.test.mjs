/**
 * x55dojc — the git-hook hardening primitives `probation-heal-run.mjs`/`probation-build-run.mjs` share.
 * Real temp repositories exercise hooks and cleanup independently of the scoped version-probe doubles.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOOKS_DISABLED_ENV, hookSurfaceChanged, resetHookSurface, snapshotHookSurface, withHooksDisabled,
} from '../git-hook-surface.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execFileSync = vi.fn(actual.execFileSync);
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});

let dirs = [];
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'we-hook-surface-'));
  dirs.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'v0\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: dir });
  return dir;
}
afterEach(async () => {
  vi.mocked(execFileSync).mockReset().mockImplementation((await vi.importActual('node:child_process')).execFileSync);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('withHooksDisabled', () => {
  it.each([undefined, '', '0', '00'])('appends to an empty count (%s)', (count) => {
    const env = Object.freeze({ PATH: process.env.PATH, ...(count === undefined ? {} : { GIT_CONFIG_COUNT: count }) });
    expect(withHooksDisabled(env)).toEqual({ ...env, ...HOOKS_DISABLED_ENV });
  });

  it('supports the default environment', () => {
    expect(withHooksDisabled()).toEqual(HOOKS_DISABLED_ENV);
  });

  it('preserves caller pairs and appends exactly once on repeated application', () => {
    const env = Object.freeze({ PATH: process.env.PATH, OTHER: 'untouched', GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'probe.preserved', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/earlier',
      GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/later' });
    let out = env;
    for (let i = 3; i < 13; i++) {
      const previous = out;
      out = withHooksDisabled(previous);
      expect(out).toEqual({ ...previous, GIT_CONFIG_COUNT: String(i + 1),
        [`GIT_CONFIG_KEY_${i}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${i}`]: '/dev/null' });
      expect(out).not.toBe(previous);
    }
    expect(env.GIT_CONFIG_COUNT).toBe('3');
  });

  it.each(['-1', '1.5', 'secret-count', '1\n', ' 1', '+1', '1e2', '2147483647', '2147483648', '9007199254740993'])
  ('refuses malformed or overflowing count (%s) without leaking it', (count) => {
    expect(() => withHooksDisabled({ GIT_CONFIG_COUNT: count })).toThrow(/GIT_CONFIG_COUNT/);
    try { withHooksDisabled({ GIT_CONFIG_COUNT: count }); } catch (error) {
      expect(error.message).not.toContain(count);
    }
  });

  it.each(['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])('refuses a missing %s without leaking values', (missing) => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'probe.secret', GIT_CONFIG_VALUE_0: 'secret-value' };
    delete env[missing];
    expect(() => withHooksDisabled(env)).toThrow(missing);
    try { withHooksDisabled(env); } catch (error) {
      expect(error.message).not.toMatch(/probe.secret|secret-value/);
    }
  });

  it.each(['2.31.0', '2.50.1', '3.0.0', '2.39.5 (Apple Git-154)', '2.47.1.windows.2'])
  ('accepts stable Git %s and probes the supplied environment without a shell', (version) => {
    vi.mocked(execFileSync).mockReturnValueOnce(`git version ${version}\n`);
    const env = { PATH: '/chosen/git', OTHER: 'kept' };
    expect(withHooksDisabled(env)).toEqual({ ...env, ...HOOKS_DISABLED_ENV });
    const [command, args, options] = vi.mocked(execFileSync).mock.calls.at(-1);
    expect(command).toBe('git');
    expect(args).toEqual(['--version']);
    expect(options.env).toEqual({ ...env, ...HOOKS_DISABLED_ENV });
    expect(options.shell ?? false).toBe(false);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(5000);
  });

  it.each(['2.30.9', '2.31.0-rc1', '2.31', 'garbage', '2.50.0\n', '2.50.0\ngit version 2.30.0'])
  ('refuses unsupported or ambiguous Git %s before a protected operation', (version) => {
    vi.mocked(execFileSync).mockReturnValueOnce(`git version ${version}\n`);
    const operation = vi.fn();
    expect(() => operation(withHooksDisabled({ PATH: '/chosen/git' }))).toThrow(/Git.*2\.31/);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'ETIMEDOUT', 'command failed'])('refuses probe failure %s without leaking output', (code) => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('secret-output'), { code }); });
    const operation = vi.fn();
    expect(() => operation(withHooksDisabled())).toThrow('Hook protection initialization refused: Git version probe failed (requires Git >=2.31.0)');
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not cache success across PATH changes', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('git version 2.31.0\n').mockReturnValueOnce('git version 2.30.9\n');
    withHooksDisabled({ PATH: '/new' });
    expect(() => withHooksDisabled({ PATH: '/old' })).toThrow(/Git.*2\.31/);
    expect(vi.mocked(execFileSync).mock.calls.slice(-2).map((call) => call[2].env.PATH)).toEqual(['/new', '/old']);
  });
});

describe('a real planted pre-commit hook', () => {
  it('executes on a plain `git commit`, but is inert once the process env is withHooksDisabled', () => {
    const dir = makeRepo();
    const marker = join(dir, 'HOOK-RAN');
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(dir, 'a.txt'), 'v1\n');
    // A clean child env, built explicitly — never bare `process.env` (#4291 advisory review, correctness): this
    // suite's own test process can itself be spawned under a caller's `laneEnv` (`probation-build-run.mjs`'s
    // `runGate` hands `laneEnv` to `verify-lane.mjs`, which this suite runs under on a full-suite fallback), so
    // a bare inherited env would silently carry GIT_CONFIG_COUNT/KEY/VALUE in here too and this "plain commit"
    // RED step would never actually exercise a live hook.
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) if (key.startsWith('GIT_CONFIG_')) delete cleanEnv[key];
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, env: cleanEnv });

    // RED (the vulnerability): an ordinary commit, no hooks-disabled override, lets the planted hook run.
    execFileSync('git', ['commit', '-m', 'plain commit'], { cwd: dir, env: cleanEnv });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    // GREEN (this fix): the SAME planted hook, the SAME commit machinery, but with HOOKS_DISABLED_ENV in the
    // child's env — git finds no hook under `/dev/null` and skips it silently.
    writeFileSync(join(dir, 'a.txt'), 'v2\n');
    const protectedEnv = withHooksDisabled({ ...cleanEnv, GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'probe.preserved', GIT_CONFIG_VALUE_0: 'yes',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(dir, '.git', 'hooks') });
    const query = (key) => execFileSync('git', ['config', '--get', key], { cwd: dir, env: protectedEnv, encoding: 'utf8' }).trim();
    expect(query('probe.preserved')).toBe('yes');
    expect(query('core.hooksPath')).toBe('/dev/null');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, env: protectedEnv });
    execFileSync('git', ['commit', '-m', 'protected commit'], { cwd: dir, env: protectedEnv });
    expect(existsSync(marker)).toBe(false);
  });

  it('is inert even if the worker rewrites the lane\'s own .git/config hooksPath back', () => {
    const dir = makeRepo();
    const marker = join(dir, 'HOOK-RAN');
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    // A hostile worker re-points hooksPath back at the real hooks dir on disk.
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, env: withHooksDisabled(process.env) });
    execFileSync('git', ['commit', '-m', 'protected commit'], { cwd: dir, env: withHooksDisabled(process.env) });
    expect(() => execFileSync('cat', [marker])).toThrow(); // env override still wins over the on-disk config
  });
});

describe('snapshotHookSurface / hookSurfaceChanged', () => {
  it('reads a fresh repo as an unremarkable baseline — only *.sample templates, never a live hook name', () => {
    const dir = makeRepo();
    const snap = snapshotHookSurface(dir);
    expect(snap.configHash).toEqual(expect.any(String));
    // `git init` ships inert `*.sample` templates by default; none of them is a live hook name.
    expect(Object.keys(snap.files).every((name) => name.endsWith('.sample'))).toBe(true);
    expect(Object.keys(snap.files)).not.toContain('pre-commit');
  });

  it('flags an added hook file', () => {
    const dir = makeRepo();
    const before = snapshotHookSurface(dir);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const after = snapshotHookSurface(dir);
    const check = hookSurfaceChanged(before, after);
    expect(check.changed).toBe(true);
    expect(check.reason).toMatch(/added: pre-commit/);
  });

  it('flags a content-only edit to an existing hook file (no name change)', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, 'v0\n');
    const before = snapshotHookSurface(dir);
    writeFileSync(hook, 'v1\n');
    const after = snapshotHookSurface(dir);
    expect(hookSurfaceChanged(before, after)).toEqual(expect.objectContaining({ changed: true }));
  });

  it('flags a mode-only edit (chmod +x with unchanged content)', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, 'same content\n');
    chmodSync(hook, 0o644);
    const before = snapshotHookSurface(dir);
    chmodSync(hook, 0o755);
    const after = snapshotHookSurface(dir);
    expect(hookSurfaceChanged(before, after).changed).toBe(true);
  });

  it('flags a symlink swapped in for a hook name', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const before = snapshotHookSurface(dir);
    writeFileSync(join(dir, 'payload.sh'), '#!/bin/sh\nexit 0\n');
    symlinkSync(join(dir, 'payload.sh'), join(dir, '.git', 'hooks', 'pre-commit'));
    const after = snapshotHookSurface(dir);
    expect(hookSurfaceChanged(before, after)).toEqual(expect.objectContaining({ changed: true }));
  });

  it('flags a .git/config change (hooksPath or any other entry)', () => {
    const dir = makeRepo();
    const before = snapshotHookSurface(dir);
    execFileSync('git', ['config', 'core.hooksPath', '/tmp/evil'], { cwd: dir });
    const after = snapshotHookSurface(dir);
    expect(hookSurfaceChanged(before, after)).toEqual({ changed: true, reason: expect.stringMatching(/\.git\/config changed/) });
  });

  it('does not flag an untouched repo (no false positive)', () => {
    const dir = makeRepo();
    const before = snapshotHookSurface(dir);
    const after = snapshotHookSurface(dir);
    expect(hookSurfaceChanged(before, after)).toEqual({ changed: false, reason: 'unchanged' });
  });

  it('fails closed when a snapshot is missing entirely', () => {
    const dir = makeRepo();
    const snap = snapshotHookSurface(dir);
    expect(hookSurfaceChanged(null, snap).changed).toBe(true);
    expect(hookSurfaceChanged(snap, undefined).changed).toBe(true);
  });
});

describe('resetHookSurface', () => {
  const hooksPathOnDisk = (dir) => {
    try { return execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: dir, encoding: 'utf8' }).trim(); } catch { return null; }
  };

  it('deletes a planted hook, keeps *.sample files, and drops a repointed hooksPath (repo tracks no .githooks/)', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['config', 'core.hooksPath', '/tmp/evil'], { cwd: dir });

    const result = resetHookSurface(dir);
    expect(result.clean).toBe(true);
    expect(result.leftover).toEqual([]);
    expect(Object.keys(result.snapshot.files)).not.toContain('pre-commit'); // the planted (non-sample) hook is gone
    expect(Object.keys(result.snapshot.files)).toContain('pre-commit.sample'); // the sample template is untouched
    expect(hooksPathOnDisk(dir)).toBe(null);
  });

  it('the no-baseline call (pre-worker cleanup) leaves an existing .git/config untouched (#4393)', () => {
    const dir = makeRepo();
    const before = readFileSync(join(dir, '.git', 'config'), 'utf8');

    const result = resetHookSurface(dir); // no baseline passed at all — must never delete a real config

    expect(result.clean).toBe(true);
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('restores the repo\'s own tracked .githooks/ as hooksPath — a pooled lane\'s guard hooks stay on for its next holder', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.githooks'));
    writeFileSync(join(dir, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['add', '.githooks/pre-push'], { cwd: dir });
    execFileSync('git', ['commit', '--quiet', '-m', 'hooks'], { cwd: dir });
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir }); // what `npm prepare` sets
    expect(resetHookSurface(dir).clean).toBe(true);
    expect(hooksPathOnDisk(dir)).toBe('.githooks'); // not left pinned at /dev/null

    execFileSync('git', ['config', 'core.hooksPath', '/tmp/evil'], { cwd: dir }); // a worker repoints it
    expect(resetHookSurface(dir).clean).toBe(true);
    expect(hooksPathOnDisk(dir)).toBe('.githooks');
  });

  it('never trusts an UNTRACKED .githooks/ a worker created — hooksPath is dropped, not pointed at it', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.githooks'));
    writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
    expect(resetHookSurface(dir).clean).toBe(true);
    expect(hooksPathOnDisk(dir)).toBe(null);
    execFileSync('git', ['add', '.githooks/pre-commit'], { cwd: dir }); // staged, but never committed
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
    expect(resetHookSurface(dir).clean).toBe(true);
    expect(hooksPathOnDisk(dir)).toBe(null);
  });

  it('given the pre-worker baseline, restores the WHOLE .git/config — a worker\'s other edits (core.fsmonitor, include.path) never become the next dispatch\'s baseline', () => {
    const dir = makeRepo();
    const baseline = snapshotHookSurface(dir);
    execFileSync('git', ['config', 'core.fsmonitor', '/tmp/evil-fsmonitor'], { cwd: dir });
    execFileSync('git', ['config', 'include.path', '/tmp/evil-include'], { cwd: dir });
    const result = resetHookSurface(dir, baseline);
    expect(result.clean).toBe(true);
    expect(result.snapshot.configHash).toBe(baseline.configHash);
    expect(hookSurfaceChanged(baseline, result.snapshot).changed).toBe(false);
  });

  it('restoring the baseline config never writes through a .git/config symlink the worker planted', () => {
    const dir = makeRepo();
    const baseline = snapshotHookSurface(dir);
    const outside = join(dir, 'outside-config');
    writeFileSync(outside, 'untouched\n');
    rmSync(join(dir, '.git', 'config'));
    symlinkSync(outside, join(dir, '.git', 'config'));
    const result = resetHookSurface(dir, baseline);
    expect(result.clean).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    expect(result.snapshot.configHash).toBe(baseline.configHash);
  });

  it('deletes a worker-created .git/config when the baseline recorded none (#4393)', () => {
    const dir = makeRepo();
    rmSync(join(dir, '.git', 'config'), { force: true }); // simulate a baseline snapshot taken with no config on disk
    const baseline = snapshotHookSurface(dir);
    expect(baseline.configBytes).toBeNull(); // sanity: this IS the "baseline had none" case
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\tworker-planted = true\n'); // worker creates one from nothing

    const result = resetHookSurface(dir, baseline);

    expect(result.clean).toBe(true);
    expect(existsSync(join(dir, '.git', 'config'))).toBe(false); // never survives the reset
    expect(result.snapshot.configHash).toBeNull();
  });

  it('a baseline restore that cannot complete (the worker made .git/config a directory) reports clean:false', () => {
    const dir = makeRepo();
    const baseline = snapshotHookSurface(dir);
    rmSync(join(dir, '.git', 'config'));
    mkdirSync(join(dir, '.git', 'config'));
    writeFileSync(join(dir, '.git', 'config', 'x'), 'x');
    expect(resetHookSurface(dir, baseline).clean).toBe(false);
  });

  it('never deletes through a symlinked .git/hooks (#4291 advisory review, security/security)', () => {
    const dir = makeRepo();
    rmSync(join(dir, '.git', 'hooks'), { recursive: true, force: true });
    const outside = mkdtempSync(join(tmpdir(), 'we-hook-surface-outside-'));
    dirs.push(outside);
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-delete\n');
    symlinkSync(outside, join(dir, '.git', 'hooks'));

    const result = resetHookSurface(dir);

    expect(result.clean).toBe(false); // no safe baseline — caller must refuse, never proceed
    expect(readFileSync(sentinel, 'utf8')).toBe('do-not-delete\n'); // the link target was never touched
  });

  it('never deletes/writes through a symlinked .git (#4291 advisory review, security/security)', () => {
    const dir = makeRepo();
    const baseline = snapshotHookSurface(dir);
    const outside = mkdtempSync(join(tmpdir(), 'we-hook-surface-outside-git-'));
    dirs.push(outside);
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-delete\n');
    rmSync(join(dir, '.git'), { recursive: true, force: true }); // simulate a worker having replaced `.git`
    symlinkSync(outside, join(dir, '.git'));

    const result = resetHookSurface(dir, baseline);

    expect(result.clean).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('do-not-delete\n');
    expect(existsSync(join(outside, 'config'))).toBe(false); // the config restore never wrote through the link
  });

  it('reports uncleanable leftovers rather than silently proceeding', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.git', 'hooks', 'pre-commit'), { recursive: true }); // a DIRECTORY named pre-commit
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit', 'nested'), 'x');
    chmodSync(join(dir, '.git', 'hooks'), 0o555); // read-only dir: rmSync of the entry inside will fail
    let result;
    try {
      result = resetHookSurface(dir);
    } finally {
      chmodSync(join(dir, '.git', 'hooks'), 0o755); // restore so afterEach's rmSync can clean up
    }
    expect(result.clean).toBe(false);
    expect(result.leftover.length).toBeGreaterThan(0);
  });
});
