// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSandboxProfile } from '../agy-sandbox.mjs';
import { defaultSpawnAgy } from '../agy-confined-build.mjs';
import { agyRunEvidence, readAgyHold, saveAgyHold } from '../antigravity-run-evidence.mjs';

const host = vi.hoisted(() => ({ home: null }));
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal();
  return { ...original, homedir: () => host.home ?? original.homedir() };
});
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), spawn: vi.fn() }));
vi.mock('../agy-sandbox.mjs', async importOriginal => {
  const original = await importOriginal();
  return { ...original, assertAgyBuildConfinement: () => {}, buildSandboxProfile: vi.fn(original.buildSandboxProfile) };
});

const { buildSandboxProfile: actualProfile } = await vi.importActual('../agy-sandbox.mjs');
const roots = [];
afterEach(() => {
  host.home = null;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  buildSandboxProfile.mockReset();
  buildSandboxProfile.mockImplementation(actualProfile);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-launcher-test-')));
  roots.push(root);
  host.home = join(root, 'home');
  const cli = join(host.home, 'bin/agy');
  const dir = join(root, 'clone');
  const laneDir = join(root, 'lane');
  for (const p of [dirname(cli), dir, laneDir]) mkdirSync(p, { recursive: true });
  mkdirSync(join(host.home, '.gemini/antigravity-cli'), { recursive: true });
  mkdirSync(join(host.home, '.gemini/config/projects'), { recursive: true });
  writeFileSync(join(host.home, '.gemini/antigravity-cli/settings.json'), '{}', { mode: 0o600 });
  writeFileSync(join(host.home, '.gemini/antigravity-cli/antigravity-oauth-token'), '{}', { mode: 0o600 });
  writeFileSync(join(host.home, '.gemini/config/config.json'), 'unused config secret');
  writeFileSync(join(host.home, '.gemini/config/mcp_config.json'), 'host MCP secret');
  writeFileSync(join(host.home, '.gemini/antigravity-cli/mcp_config.json'), 'host MCP secret');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o700);
  vi.stubEnv('ANTIGRAVITY_QUOTA_DIR', join(root, 'quota'));
  const transcriptDir = join(root, 'transcript');
  mkdirSync(transcriptDir, { mode: 0o700 });
  const options = { cli, dir, laneDir, task: 'repair', model: 'gemini-test', stream: false, logFile: join(transcriptDir, 'events.jsonl') };
  return { root, options };
}

it('prototype launcher consults persisted quota holds and refuses before sandbox launch', async () => {
  const { options } = fixture();
  saveAgyHold(agyRunEvidence({ requestedModel: options.model, stderr: 'RESOURCE_EXHAUSTED Resets in 1h' }));
  const result = await defaultSpawnAgy(options);
  expect(result).toMatchObject({ code: 1, fallbackDecision: 'skip-quota-hold', modelEvidence: 'not-launched' });
  expect(spawn).not.toHaveBeenCalled();
});

it.each(['direct', 'homebrew-symlink', 'missing-login'])('prototype sandbox callback resolves %s grants, records quota and scrubs environment', async installation => {
  const { options } = fixture();
  const homebrewPrefix = join(host.home, 'brew');
  if (installation === 'homebrew-symlink') {
    const target = join(homebrewPrefix, 'Cellar/agy/1/bin/agy');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const link = join(host.home, 'bin/linked-agy');
    symlinkSync(target, link);
    options.cli = link;
  }
  if (installation === 'missing-login') rmSync(join(host.home, '.gemini/antigravity-cli/antigravity-oauth-token'));
  vi.stubEnv('GH_TOKEN', 'must-not-reach-child');
  vi.stubEnv('SSH_AUTH_SOCK', '/host-agent');
  let privateTemp;
  let profileDir;
  spawn.mockImplementation((bin, args, opts) => {
    expect(opts.env.HOME).toBe(host.home);
    privateTemp = opts.env.TMPDIR;
    profileDir = dirname(args[1]);
    expect(readdirSync(profileDir).sort()).toEqual(['profile.sb', privateTemp.slice(profileDir.length + 1)].sort());
    expect(readFileSync(join(host.home, '.gemini/antigravity-cli/settings.json'), 'utf8')).toBe('{}');
    expect(bin).toBe('/usr/bin/sandbox-exec');
    expect(args).toContain(realpathSync(options.cli));
    const profile = readFileSync(args[1], 'utf8');
    const transcriptDir = realpathSync(dirname(options.logFile));
    const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
    for (const [, root] of writeRule.matchAll(/\(subpath "([^"]+)"\)/g))
      expect(transcriptDir === root || transcriptDir.startsWith(`${root}/`)).toBe(false);
    expect(transcriptDir.startsWith(`${opts.env.HOME}/`)).toBe(false);
    expect(transcriptDir.startsWith(`${host.home}/workspace/`)).toBe(false);
    expect([...writeRule.matchAll(/\(subpath "([^"]+)"\)/g)].map(m => m[1]))
      .toEqual([realpathSync(options.dir), privateTemp, join(host.home, '.gemini/antigravity-cli/log')]);
    const readAllow = profile.split('\n').find(line => line.startsWith('(allow file-read*'));
    const installDir = dirname(realpathSync(options.cli));
    expect(readAllow).toContain(`(subpath ${JSON.stringify(installDir)})`);
    if (installation === 'homebrew-symlink') expect(readAllow).toContain(`(subpath ${JSON.stringify(homebrewPrefix)})`);
    expect(profile.indexOf(`(deny file-read* (subpath ${JSON.stringify(host.home)}))`)).toBeLessThan(profile.indexOf(readAllow));
    expect(profile.indexOf(`(subpath ${JSON.stringify(join(host.home, 'Library/Keychains'))})`)).toBeGreaterThan(profile.indexOf(readAllow));
    expect(opts.env).not.toHaveProperty('GH_TOKEN');
    expect(opts.env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(opts.env).not.toHaveProperty('ANTIGRAVITY_QUOTA_DIR');
    for (const root of [options.dir, options.laneDir, join(host.home, 'workspace')])
      expect(privateTemp === root || privateTemp.startsWith(`${root}/`)).toBe(false);
    expect(opts.env.TMPDIR).toBe(opts.env.TMP);
    expect(opts.env.TMPDIR).toBe(opts.env.TEMP);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => {
      child.stderr.write('RESOURCE_EXHAUSTED Resets in 1h');
      child.emit('close', 1);
    });
    return child;
  });
  expect(readAgyHold(options.model)).toBeNull();
  expect(await defaultSpawnAgy(options)).toMatchObject({ code: 1, quotaState: 'exhausted' });
  expect(existsSync(host.home)).toBe(true);
  expect(existsSync(privateTemp)).toBe(false);
  expect(existsSync(profileDir)).toBe(false);
  expect(readAgyHold(options.model)).toMatchObject({ fallbackDecision: 'skip-quota-hold', heldBackend: 'google' });
  expect(spawn).toHaveBeenCalledOnce();
  expect(await defaultSpawnAgy({ ...options, logFile: join(dirname(options.logFile), 'held.jsonl') })).toMatchObject({ fallbackDecision: 'skip-quota-hold' });
  expect(spawn).toHaveBeenCalledOnce();
});

it('resolves the binary symlink and refuses a target under home/workspace', async () => {
  const { options } = fixture();
  const target = join(host.home, 'workspace/bin/agy');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  chmodSync(target, 0o700);
  const link = join(host.home, 'bin/redirected-agy');
  symlinkSync(target, link);
  await expect(defaultSpawnAgy({ ...options, cli: link })).rejects.toThrow('binary overlaps workspace');
  expect(spawn).not.toHaveBeenCalled();
});

it('keeps a symlinked secret target denied even inside the readable clone', async () => {
  const { options } = fixture();
  const target = join(options.dir, 'secret-target');
  mkdirSync(target);
  symlinkSync(target, join(host.home, '.secrets'));
  spawn.mockImplementation((bin, args) => {
    const profile = readFileSync(args[1], 'utf8');
    const readAllow = profile.split('\n').find(line => line.startsWith('(allow file-read*'));
    expect(profile.indexOf(`(subpath ${JSON.stringify(target)})`)).toBeGreaterThan(profile.indexOf(readAllow));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  expect(await defaultSpawnAgy(options)).toMatchObject({ code: 0 });
  expect(spawn).toHaveBeenCalledOnce();
});

it('fails closed on an unresolved executable with an operator fallback', async () => {
  const { options } = fixture();
  await expect(defaultSpawnAgy({ ...options, cli: join(host.home, 'missing-agy') }))
    .rejects.toThrow('use another provider or request operator review');
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses a pre-planted transcript symlink without writing its target or spawning agy', async () => {
  const { root, options } = fixture();
  const target = join(root, 'valuable.txt');
  writeFileSync(target, 'unchanged');
  symlinkSync(target, options.logFile);
  expect(await defaultSpawnAgy(options)).toMatchObject({ code: null, stdout: '' });
  expect(readFileSync(target, 'utf8')).toBe('unchanged');
  expect(spawn).not.toHaveBeenCalled();
});
it('writes confined transcript through the original fd even if the pathname is replaced', async () => {
  const { root, options } = fixture();
  const target = join(root, 'valuable.txt');
  const original = join(root, 'original.jsonl');
  writeFileSync(target, 'unchanged');
  spawn.mockImplementation(() => {
    renameSync(options.logFile, original);
    symlinkSync(target, options.logFile);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => { child.stdout.write('recorded\n'); child.emit('close', 0); });
    return child;
  });
  expect(await defaultSpawnAgy(options)).toMatchObject({ code: 0, stdout: 'recorded\n' });
  expect(readFileSync(original, 'utf8')).toBe('recorded\n');
  expect(readFileSync(target, 'utf8')).toBe('unchanged');
});

it('refuses a redirected log directory with operator fallback and cleans launcher temp', async () => {
  const { root, options } = fixture();
  vi.stubEnv('TMPDIR', root);
  const redirected = join(root, 'redirected-log');
  mkdirSync(redirected);
  symlinkSync(redirected, join(host.home, '.gemini/antigravity-cli/log'));
  await expect(defaultSpawnAgy(options)).rejects.toThrow('agy log directory is redirected; use another provider or request operator review');
  expect(spawn).not.toHaveBeenCalled();
  expect(readdirSync(root).filter(name => name.startsWith('we-agy-sandbox-'))).toEqual([]);
  expect(existsSync(host.home)).toBe(true);
});

it.each([undefined, '(version 1)\n(allow default)\n', '(version 1)\n(deny default) garbage'])('refuses unknown/invalid builder output %j before spawning', async profile => {
  const { options } = fixture();
  buildSandboxProfile.mockReturnValueOnce(profile);
  await expect(defaultSpawnAgy(options)).rejects.toThrow(/deny-default|invalid sandbox profile/);
  expect(spawn).not.toHaveBeenCalled();
});
it.each(['throw', 'error', 'exit'])('sandbox-exec failure (%s) throws with no unconfined retry', async failure => {
  const { options } = fixture();
  spawn.mockImplementation(() => {
    if (failure === 'throw') throw new Error('sandbox-exec unavailable');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    queueMicrotask(() => {
      if (failure === 'error') child.emit('error', new Error('sandbox-exec failed'));
      else { child.stderr.write('sandbox-exec: invalid profile'); child.emit('close', 65); }
    });
    return child;
  });
  await expect(defaultSpawnAgy(options)).rejects.toThrow(/sandbox.*failed.*use another provider/i);
  expect(spawn).toHaveBeenCalledOnce();
  expect(spawn.mock.calls[0][0]).toBe('/usr/bin/sandbox-exec');
});

// macOS-only real launcher probe; uses fake HOME credentials and the real sandbox-exec.
it.skipIf(process.platform !== 'darwin')('REAL launcher executes node agy fixture within deny-default profile', async () => {
  const { options } = fixture();
  mkdirSync(join(host.home, '.gemini/antigravity-cli/log'));
  const node = realpathSync(process.execPath);
  writeFileSync(options.cli, `#!${node}\nconst fs = require('node:fs');
    fs.writeFileSync('allowed', 'clone');
    fs.writeFileSync(process.env.HOME + '/.gemini/antigravity-cli/log/probe', 'logged');
    console.log('confined-fixture');`);
  const actual = await vi.importActual('node:child_process');
  // `env -i` re-applies the launcher's scrubbed env: the test-cache tracer injects NODE_OPTIONS into every spawn.
  spawn.mockImplementation((cmd, args, opts) => actual.spawn('/usr/bin/env',
    ['-i', ...Object.entries(opts.env).map(([k, v]) => `${k}=${v}`), cmd, ...args], opts));
  const result = await defaultSpawnAgy(options);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('confined-fixture');
  expect(readFileSync(join(options.dir, 'allowed'), 'utf8')).toBe('clone');
});
