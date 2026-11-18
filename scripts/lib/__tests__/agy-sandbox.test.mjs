// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildSandboxProfile, sandboxedSpawnArgv, sandboxSecretPaths } from '../agy-sandbox.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-sandbox-test-')));
  roots.push(root);
  const homeDir = join(root, 'home');
  const cloneDir = join(root, 'clone');
  const privateTempDir = join(root, 'private-temp');
  const laneDir = join(root, 'lane');
  const stateDir = join(homeDir, '.gemini/antigravity-cli');
  const workspaceOps = join(homeDir, 'workspace/.operations');
  for (const p of [cloneDir, privateTempDir, laneDir, stateDir, ...sandboxSecretPaths(homeDir), workspaceOps]) mkdirSync(p, { recursive: true });
  return { root, homeDir, cloneDir, privateTempDir, laneDir, workspaceOps };
}

describe('pure sandbox profile', () => {
  it('denies writes by default, grants clone/state/device writes, and keeps network allowed', () => {
    const f = fixture();
    const profile = buildSandboxProfile(f);
    expect(profile).toContain('(allow default)\n(deny file-write*)');
    const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
    for (const p of [f.cloneDir, f.privateTempDir, join(f.homeDir, '.gemini/antigravity-cli')]) expect(writeRule).toContain(`(subpath ${JSON.stringify(p)})`);
    for (const p of ['/dev/null', '/dev/tty', '/dev/dtracehelper']) expect(writeRule).toContain(`(literal "${p}")`);
    for (const p of [realpathSync(tmpdir()), '/private/var/folders', join(f.homeDir, '.gemini'), f.laneDir])
      expect(writeRule).not.toContain(`(subpath ${JSON.stringify(p)})`);
    expect(writeRule).toContain(`(literal ${JSON.stringify(join(f.homeDir, '.gemini/projects.json'))})`);
    expect(writeRule).toContain('(regex #');
    expect(profile).not.toContain('deny network');
  });
  it('denies reads of every secret root and workspace operations, plus extra denied paths', () => {
    const f = fixture();
    const extra = join(f.root, 'denied');
    mkdirSync(extra);
    const profile = buildSandboxProfile({ ...f, extraDeniedPaths: [extra] });
    const readRule = profile.split('\n').find(line => line.startsWith('(deny file-read*'));
    for (const p of [...sandboxSecretPaths(f.homeDir), f.workspaceOps, extra])
      expect(readRule).toContain(`(subpath ${JSON.stringify(p)})`);
  });
  it.each(['cloneDir', 'privateTempDir'])('refuses a writable %s under home/workspace', key => {
    const f = fixture();
    const p = join(f.homeDir, 'workspace/escape');
    expect(() => buildSandboxProfile({ ...f, [key]: p })).toThrow('under home/workspace');
  });
  it('refuses a writable root under the canonical workspace alias', () => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, workspaceDir: join(f.root, 'workspace-target'),
      privateTempDir: join(f.root, 'workspace-target/cache') })).toThrow('under home/workspace');
  });
  it.each(['cloneDir', 'privateTempDir', 'homeDir'])('refuses writable %s inside the lane', key => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, [key]: join(f.laneDir, 'escape') })).toThrow('lane');
  });
  it('refuses temp inside the clone or containing it', () => {
    const f = fixture();
    for (const privateTempDir of [join(f.cloneDir, 'tmp'), f.root])
      expect(() => buildSandboxProfile({ ...f, privateTempDir })).toThrow();
  });
  it.each(['"', '\\', '\n', '\r', '\0', '\x7f', '\x85'])('refuses unsafe SBPL path character %j', char => {
    const f = fixture();
    for (const key of ['cloneDir', 'homeDir', 'workspaceOps', 'privateTempDir', 'laneDir', 'extraDeniedPaths', 'deniedPaths']) {
      const p = join(f.root, `unsafe${char}path`);
      expect(() => buildSandboxProfile({ ...f, [key]: key.endsWith('Dirs') || key.endsWith('Paths') ? [p] : p }))
        .toThrow('unsafe sandbox path');
    }
  });
  it.each(['relative/path', '/absolute/../noncanonical'])('refuses noncanonical path %s', cloneDir => {
    expect(() => buildSandboxProfile({ ...fixture(), cloneDir })).toThrow('unsafe sandbox path');
  });
  it('wraps argv without shell interpolation', () => {
    expect(sandboxedSpawnArgv('/profile with spaces.sb', ['sh', '-c', 'literal $input']))
      .toEqual(['sandbox-exec', '-f', '/profile with spaces.sb', 'sh', '-c', 'literal $input']);
  });
});

it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
  'REAL sandbox permits private temp/state writes, blocks OS temp and sibling gemini writes with EPERM, and denies secret reads', () => {
    const f = fixture();
    const denied = join(f.root, 'extra-denied');
    mkdirSync(denied);
    writeFileSync(join(denied, 'secret'), 'fixture secret');
    const profileFile = join(f.root, 'profile.sb');
    writeFileSync(profileFile, buildSandboxProfile({ ...f, extraDeniedPaths: [denied] }), { mode: 0o600 });
    const run = (script, ...args) => {
      const [, ...argv] = sandboxedSpawnArgv(profileFile, ['/bin/sh', '-c', script, 'probe', ...args]);
      return spawnSync('/usr/bin/sandbox-exec', argv, { cwd: f.cloneDir, encoding: 'utf8', timeout: 10_000 });
    };
    const inside = join(f.cloneDir, 'allowed');
    expect(run('printf allowed > "$1"', inside).status).toBe(0);
    expect(existsSync(inside)).toBe(true);
    for (const allowed of [join(f.privateTempDir, 'allowed'),
      join(f.homeDir, '.gemini/antigravity-cli/state'), join(f.homeDir, '.gemini/projects.json'),
      join(f.homeDir, '.gemini/projects.json.123.tmp')]) {
      expect(run('printf allowed > "$1"', allowed).status, allowed).toBe(0);
      expect(existsSync(allowed)).toBe(true);
    }
    const osTempTarget = join(realpathSync(tmpdir()), `${basename(f.root)}-blocked`);
    roots.push(osTempTarget);
    const sibling = join(f.homeDir, '.gemini-like');
    mkdirSync(sibling);
    for (const outside of [osTempTarget, join(f.root, 'blocked'), join(f.laneDir, 'blocked'),
      join(sibling, 'blocked'), join(f.homeDir, '.gemini/other-state'),
      join(f.homeDir, '.gemini/projects.json.123.tmp.extra')]) {
      const write = run('printf blocked > "$1"', outside);
      expect(write.error).toBeUndefined();
      expect(write.status, outside).not.toBe(0);
      expect(write.stderr).toMatch(/EPERM|Operation not permitted/i);
      expect(existsSync(outside)).toBe(false);
    }
    const read = run('/bin/cat "$1"', join(denied, 'secret'));
    expect(read.error).toBeUndefined();
    expect(read.status).not.toBe(0);
    expect(read.stderr).toMatch(/EPERM|Operation not permitted/i);
    expect(read.stdout).not.toContain('fixture secret');
  },
);
