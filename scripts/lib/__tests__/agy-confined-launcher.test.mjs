// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSpawnAgy } from '../agy-confined-build.mjs';
import { agyRunEvidence, readAgyHold, saveAgyHold } from '../antigravity-run-evidence.mjs';

const host = vi.hoisted(() => ({ home: null }));
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal();
  return { ...original, homedir: () => host.home ?? original.homedir() };
});
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), spawn: vi.fn() }));

const roots = [];
afterEach(() => {
  host.home = null;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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

it('production launcher consults persisted quota holds and refuses before sandbox launch', async () => {
  const { options } = fixture();
  saveAgyHold(agyRunEvidence({ requestedModel: options.model, stderr: 'RESOURCE_EXHAUSTED Resets in 1h' }));
  const result = await defaultSpawnAgy(options);
  expect(result).toMatchObject({ code: 1, fallbackDecision: 'skip-quota-hold', modelEvidence: 'not-launched' });
  expect(spawn).not.toHaveBeenCalled();
});

it.each(['direct', 'homebrew-symlink', 'missing-login'])('production sandbox callback resolves %s grants, records quota and scrubs environment', async installation => {
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
    expect(profile).not.toContain('(allow file-read*');
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

it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
  'REAL launcher uses real-HOME login, allows log writes, denies other home writes and cleans only private temp', async () => {
    const { options } = fixture();
    mkdirSync(join(host.home, '.gemini/antigravity-cli/log'));
    const login = join(host.home, '.gemini/antigravity-cli/antigravity-oauth-token');
    writeFileSync(login, 'fixture-login');
    writeFileSync(options.cli, `#!/bin/sh
/bin/cat "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" || exit 2
printf logged > "$HOME/.gemini/antigravity-cli/log/probe" || exit 3
if (printf blocked > "$HOME/.gemini/other"); then exit 4; fi
printf '\nother-home-write-denied\n'
`);
    const actual = await vi.importActual('node:child_process');
    let privateTemp;
    spawn.mockImplementation((bin, args, opts) => {
      expect(opts.env.HOME).toBe(host.home);
      privateTemp = opts.env.TMPDIR;
      return actual.spawn(bin, args, opts);
    });
    const result = await defaultSpawnAgy(options);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('fixture-login');
    expect(result.stdout).toContain('other-home-write-denied');
    expect(result.stderr).toMatch(/EPERM|Operation not permitted/i);
    expect(readFileSync(join(host.home, '.gemini/antigravity-cli/log/probe'), 'utf8')).toBe('logged');
    expect(existsSync(join(host.home, '.gemini/other'))).toBe(false);
    expect(readFileSync(login, 'utf8')).toBe('fixture-login');
    expect(privateTemp).toBeTruthy();
    expect(existsSync(privateTemp)).toBe(false);
    expect(existsSync(host.home)).toBe(true);
  },
);
