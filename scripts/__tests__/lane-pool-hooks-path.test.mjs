/**
 * @file lane-pool-hooks-path.test.mjs — every lane points `core.hooksPath` at the tracked `.githooks`, so the
 *   pre-commit guards (incl. the placeholder-author guard) run even when npm `prepare` never did. Audit finding:
 *   `provision --no-install` skips npm, and a `--reference` clone does not inherit `core.hooksPath`.
 *   Real throwaway origin + reference, private LANE_POOL_ROOT (same fixture shape as lane-pool-provision-dry-run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLaneHooksPath, LANE_HOOKS_PATH } from '../lib/git-identity.mjs';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('ensureLaneHooksPath (injected IO)', () => {
  const has = () => true;
  it('sets it when unset, and logs', () => {
    const calls = [];
    const logs = [];
    const run = (args) => { calls.push(args); if (args[2] === '--get') throw new Error('exit 1'); return ''; };
    expect(ensureLaneHooksPath('/l', { exists: has, run, log: (l) => logs.push(l) })).toEqual({ status: 'set', was: null });
    expect(calls.at(-1)).toEqual(['config', '--local', 'core.hooksPath', LANE_HOOKS_PATH]);
    expect(logs[0]).toMatch(/core\.hooksPath \(unset\) → \.githooks/);
  });
  it('is idempotent: already .githooks → no write', () => {
    const calls = [];
    const run = (args) => { calls.push(args); return '.githooks\n'; };
    expect(ensureLaneHooksPath('/l', { exists: has, run }).status).toBe('ok');
    expect(calls).toHaveLength(1);
  });
  it('repoints a foreign value', () => {
    const run = (args) => (args[2] === '--get' ? '/dev/null\n' : '');
    expect(ensureLaneHooksPath('/l', { exists: has, run })).toEqual({ status: 'set', was: '/dev/null' });
  });
  it('write:false only reports', () => {
    const calls = [];
    const run = (args) => { calls.push(args); throw new Error('exit 1'); };
    expect(ensureLaneHooksPath('/l', { exists: has, run, write: false }).status).toBe('unset');
    expect(calls).toHaveLength(1);
  });
  it('a checkout with no .githooks/pre-commit is skipped', () => {
    expect(ensureLaneHooksPath('/l', { exists: () => false, run: () => { throw new Error('no'); } }).status).toBe('skipped');
  });
});

describe('provision --no-install sets core.hooksPath in the lane (real git)', () => {
  let base, originDir, referenceDir, env;
  const runPool = (args) => {
    const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env, timeout: 60_000, killSignal: 'SIGKILL' });
    return { code: r.status ?? 1, err: String(r.stderr || '') };
  };
  const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=hookspath', '--branch=main', '--no-install'];

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'lane-pool-hooks-path-'));
    originDir = join(base, 'origin.git');
    referenceDir = join(base, 'reference');
    git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
    git(['clone', '--quiet', originDir, referenceDir]);
    git(['config', 'user.name', 'Fixture Author'], referenceDir);
    git(['config', 'user.email', 'fixture@realcorp.io'], referenceDir);
    mkdirSync(join(referenceDir, '.githooks'));
    writeFileSync(join(referenceDir, '.githooks/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(referenceDir, '.githooks/pre-commit'), 0o755);
    git(['add', '.githooks/pre-commit'], referenceDir);
    git(['commit', '--quiet', '-m', 'v1'], referenceDir);
    git(['push', '--quiet', 'origin', 'main'], referenceDir);
    env = { ...process.env, LANE_POOL_ROOT: join(base, 'pool'), HOME: base };
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('a fresh --reference clone gets .githooks, and a re-provision leaves it (idempotent)', () => {
    const r = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(r.code).toBe(0);
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    expect(git(['config', '--local', '--get', 'core.hooksPath'], lane)).toBe('.githooks');
    expect(r.err).toMatch(/core\.hooksPath \(unset\) → \.githooks/);
    const again = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(again.code).toBe(0);
    expect(again.err).not.toMatch(/core\.hooksPath .* → /);
    expect(git(['config', '--local', '--get', 'core.hooksPath'], lane)).toBe('.githooks');
  });

  it('status reports a lane whose hooksPath was unset, without writing', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    git(['config', '--local', '--unset', 'core.hooksPath'], lane);
    const r = runPool(['status', ...poolArgs()]);
    expect(r.err).toMatch(/core\.hooksPath is not \.githooks in 1 lane\(s\) \(lane-1\)/);
    expect(() => git(['config', '--local', '--get', 'core.hooksPath'], lane)).toThrow();
  });
});
