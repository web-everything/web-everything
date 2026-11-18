// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildSandboxEnv, buildSandboxProfile, preparePrivateAgyHome, sandboxedSpawnArgv, sandboxSecretPaths } from '../agy-sandbox.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-sandbox-test-')));
  roots.push(root);
  const homeDir = join(root, 'home');
  const cloneDir = join(homeDir, 'clone');
  const privateTempDir = join(root, 'private-temp');
  const laneDir = join(root, 'lane');
  const privateHomeDir = join(root, 'private-home');
  const stateDir = join(homeDir, '.gemini/antigravity-cli');
  const workspaceOps = join(homeDir, 'workspace/.operations');
  for (const p of [cloneDir, privateTempDir, laneDir, join(privateHomeDir, '.gemini/antigravity-cli'), join(stateDir, 'log'), join(stateDir, 'bin'), join(stateDir, 'builtin'), ...sandboxSecretPaths(homeDir), workspaceOps]) mkdirSync(p, { recursive: true });
  return { root, homeDir, cloneDir, privateTempDir, privateHomeDir, laneDir, workspaceOps, osTempBase: realpathSync(tmpdir()) };
}

describe('pure sandbox profile', () => {
  it('denies writes by default, grants clone/private state/device writes, and keeps network allowed', () => {
    const f = fixture();
    const profile = buildSandboxProfile(f);
    const allowIndex = profile.indexOf('(allow file-read*');
    const tempBase = realpathSync(tmpdir());
    for (const p of ['/Users', '/Volumes', '/private/tmp', '/tmp', f.homeDir,
      tempBase === '/private/var/folders' || tempBase.startsWith('/private/var/folders/') ? '/private/var/folders' : tempBase]) {
      const rule = `(deny file-read* (subpath ${JSON.stringify(p)}))`;
      expect(profile).toContain(rule);
      expect(profile.indexOf(rule)).toBeLessThan(allowIndex);
    }
    expect(profile).toContain('(deny file-write*)');
    const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
    for (const p of [f.cloneDir, f.privateTempDir, join(f.privateHomeDir, '.gemini')])
      expect(writeRule).toContain(`(subpath ${JSON.stringify(p)})`);
    for (const p of ['/dev/null', '/dev/tty', '/dev/dtracehelper']) expect(writeRule).toContain(`(literal "${p}")`);
    for (const p of [realpathSync(tmpdir()), '/private/var/folders', f.privateHomeDir, f.laneDir])
      expect(writeRule).not.toContain(`(subpath ${JSON.stringify(p)})`);
    expect(writeRule).not.toContain(join(f.homeDir, '.gemini'));
    expect(profile).not.toContain('deny network');
  });
  it('denies reads of every secret root and workspace operations, plus extra denied paths', () => {
    const f = fixture();
    const extra = join(f.root, 'denied');
    mkdirSync(extra);
    const profile = buildSandboxProfile({ ...f, extraDeniedPaths: [extra] });
    const readRule = profile.split('\n').filter(line => line.startsWith('(deny file-read*')).at(-1);
    expect(profile.indexOf(readRule)).toBeGreaterThan(profile.indexOf('(allow file-read*'));
    expect(profile.trim().endsWith(readRule)).toBe(true);
    for (const p of [...sandboxSecretPaths(f.homeDir), join(f.homeDir, 'workspace'), f.workspaceOps, extra])
      expect(readRule).toContain(`(subpath ${JSON.stringify(p)})`);
  });
  it('allows private home reads and the resolved binary directory without real state reads', () => {
    const f = fixture();
    const agyBinDir = join(f.homeDir, 'bin');
    const rule = buildSandboxProfile({ ...f, agyBinDir }).split('\n').find(s => s.startsWith('(allow file-read*'));
    for (const p of [f.cloneDir, f.privateTempDir, f.privateHomeDir, agyBinDir])
      expect(rule).toContain(`(subpath ${JSON.stringify(p)})`);
    expect(rule).not.toContain(join(f.homeDir, '.gemini'));
    expect(rule).not.toContain(`(subpath ${JSON.stringify(f.homeDir)})`);
    expect(rule).not.toContain(`(subpath ${JSON.stringify(join(f.homeDir, '.gemini'))})`);
  });
  it.each(['workspace/bin', 'workspace/.operations/bin', '.'])('refuses a binary directory overlapping workspace: %s', p => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, agyBinDir: join(f.homeDir, p) })).toThrow('binary overlaps workspace');
  });
  it.each(['/Users/another-user/agy/bin', '/Volumes/tools/agy/bin'])('allows an external binary directory %s after broad denies', agyBinDir => {
    const profile = buildSandboxProfile({ ...fixture(), agyBinDir });
    const rule = profile.split('\n').find(s => s.startsWith('(allow file-read*'));
    expect(rule).toContain(`(subpath ${JSON.stringify(agyBinDir)})`);
  });
  it('allows a resolved Homebrew prefix under temp, with secret denies still last', () => {
    const f = fixture();
    const homebrewPrefix = join(f.root, 'brew');
    const agyBinDir = join(homebrewPrefix, 'Cellar/agy/1/bin');
    const profile = buildSandboxProfile({ ...f, agyBinDir, homebrewPrefix });
    const rule = profile.split('\n').find(s => s.startsWith('(allow file-read*'));
    for (const p of [homebrewPrefix, agyBinDir]) expect(rule).toContain(`(subpath ${JSON.stringify(p)})`);
    expect(profile.trim().split('\n').at(-1)).toMatch(/^\(deny file-read\*/);
  });
  it('refuses a Homebrew prefix overlapping workspace even if the executable directory is elsewhere', () => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, agyBinDir: '/opt/agy/bin', homebrewPrefix: join(f.homeDir, 'workspace/brew') }))
      .toThrow('binary overlaps workspace');
  });
  it('scrubs all inherited variables except the allowlist and replaces every temp variable', () => {
    const allowed = { PATH: '/usr/bin', HOME: '/home', USER: 'fixture', LOGNAME: 'fixture', SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm' };
    const env = buildSandboxEnv({ ...allowed, GH_TOKEN: 'secret', API_KEY: 'secret', AWS_PROFILE: 'secret',
      SSH_AUTH_SOCK: '/agent', GIT_CONFIG_GLOBAL: '/config', NODE_OPTIONS: '--require=host',
      ANTIGRAVITY_QUOTA_DIR: '/host', ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR: '/host',
      TMPDIR: '/host', TMP: '/host', TEMP: '/host', OTHER: 'secret' }, '/private-temp', '/private-home');
    expect(env).toEqual({ ...allowed, HOME: '/private-home', TMPDIR: '/private-temp', TMP: '/private-temp', TEMP: '/private-temp' });
  });
  it.each(['cloneDir', 'privateTempDir', 'privateHomeDir'])('refuses a writable %s under home/workspace', key => {
    const f = fixture();
    const p = join(f.homeDir, 'workspace/escape');
    expect(() => buildSandboxProfile({ ...f, [key]: p })).toThrow(/workspace/);
  });
  it('refuses a writable root under the canonical workspace alias', () => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, workspaceDir: join(f.root, 'workspace-target'),
      privateTempDir: join(f.root, 'workspace-target/cache') })).toThrow('under home/workspace');
  });
  it.each(['cloneDir', 'privateTempDir', 'privateHomeDir'])('refuses writable %s inside the lane', key => {
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
    for (const key of ['cloneDir', 'homeDir', 'workspaceOps', 'privateTempDir', 'privateHomeDir', 'laneDir', 'osTempBase', 'extraDeniedPaths', 'deniedPaths']) {
      const p = join(f.root, `unsafe${char}path`);
      expect(() => buildSandboxProfile({ ...f, [key]: key.endsWith('Dirs') || key.endsWith('Paths') ? [p] : p }))
        .toThrow('unsafe sandbox path');
    }
  });
  it.each(['relative/path', '/absolute/../noncanonical'])('refuses noncanonical path %s', cloneDir => {
    expect(() => buildSandboxProfile({ ...fixture(), cloneDir })).toThrow('unsafe sandbox path');
  });
  it('refuses a missing OS temp base rather than dropping its read deny', () => {
    expect(() => buildSandboxProfile({ ...fixture(), osTempBase: undefined })).toThrow('unsafe sandbox path');
  });
  it.each(['cloneDir', 'privateTempDir', 'privateHomeDir', 'agyBinDir'])('refuses real .gemini access through %s', key => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, [key]: join(f.homeDir, '.gemini/escape') })).toThrow();
  });
  it('refuses private home overlapping the clone', () => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, privateHomeDir: join(f.cloneDir, 'home') })).toThrow();
  });
  it('wraps argv without shell interpolation', () => {
    expect(sandboxedSpawnArgv('/profile with spaces.sb', ['sh', '-c', 'literal $input']))
      .toEqual(['sandbox-exec', '-f', '/profile with spaces.sb', 'sh', '-c', 'literal $input']);
  });
});

describe('private agy home config', () => {
  function configFixture() {
    const f = fixture();
    f.settings = join(f.homeDir, '.gemini/antigravity-cli/settings.json');
    f.config = join(f.homeDir, '.gemini/config');
    writeFileSync(f.settings, JSON.stringify({ theme: 'dark', trustedWorkspaces: ['/previous'] }));
    writeFileSync(f.config, 'auth config');
    return f;
  }
  it('copies settings with only the clone trusted and preserves small config bytes', () => {
    const f = configFixture();
    preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir);
    expect(JSON.parse(readFileSync(join(f.privateHomeDir, '.gemini/antigravity-cli/settings.json'), 'utf8')))
      .toEqual({ theme: 'dark', trustedWorkspaces: [f.cloneDir] });
    expect(readFileSync(join(f.privateHomeDir, '.gemini/config'), 'utf8')).toBe('auth config');
    expect(JSON.parse(readFileSync(f.settings, 'utf8')).trustedWorkspaces).toEqual(['/previous']);
  });
  it.each(['config', 'settings'])('refuses oversized and redirected %s with operator fallback', key => {
    for (const invalid of ['oversized', ...(key === 'settings' ? ['directory'] : []), 'symlink', 'dangling-symlink', 'parent-symlink']) {
      const f = configFixture();
      rmSync(f[key]);
      if (invalid === 'oversized') writeFileSync(f[key], Buffer.alloc(65537));
      if (invalid === 'directory') mkdirSync(f[key]);
      if (invalid === 'symlink') {
        const target = join(f.root, 'config-target');
        writeFileSync(target, '{}');
        symlinkSync(target, f[key]);
      }
      if (invalid === 'dangling-symlink') symlinkSync(join(f.root, 'missing-target'), f[key]);
      if (invalid === 'parent-symlink') {
        const gemini = join(f.homeDir, '.gemini');
        rmSync(gemini, { recursive: true });
        symlinkSync(f.privateHomeDir, gemini);
      }
      expect(() => preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir)).toThrow('operator review');
    }
  });
  it.each(['config', 'settings', 'both', 'gemini'])('accepts absent %s as empty state', missing => {
    const f = configFixture();
    if (missing === 'gemini') rmSync(join(f.homeDir, '.gemini'), { recursive: true });
    else for (const key of missing === 'both' ? ['config', 'settings'] : [missing]) rmSync(f[key]);
    preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir);
    expect(JSON.parse(readFileSync(join(f.privateHomeDir, '.gemini/antigravity-cli/settings.json'), 'utf8')))
      .toEqual({ ...(missing === 'config' ? { theme: 'dark' } : {}), trustedWorkspaces: [f.cloneDir] });
    const config = join(f.privateHomeDir, '.gemini/config');
    if (missing === 'settings') expect(readFileSync(config, 'utf8')).toBe('auth config');
    else expect(existsSync(config)).toBe(false);
  });
  function directoryConfigFixture() {
    const f = configFixture();
    rmSync(f.config);
    mkdirSync(join(f.config, 'projects'), { recursive: true });
    writeFileSync(join(f.config, 'projects/private-data'), 'must not be copied');
    f.files = { '.migrated': '', 'config.json': JSON.stringify({ auth: 'fixture' }), 'mcp_config.json': '' };
    for (const [name, content] of Object.entries(f.files)) writeFileSync(join(f.config, name), content);
    return f;
  }
  it('copies the three immediate config files at 0600 and recreates projects empty at 0700', () => {
    const f = directoryConfigFixture();
    preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir);
    const target = join(f.privateHomeDir, '.gemini/config');
    expect(readdirSync(target).sort()).toEqual(['.migrated', 'config.json', 'mcp_config.json', 'projects']);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    for (const [name, content] of Object.entries(f.files)) {
      expect(readFileSync(join(target, name), 'utf8')).toBe(content);
      expect(statSync(join(target, name)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(target, 'projects'))).toEqual([]);
    expect(statSync(join(target, 'projects')).mode & 0o777).toBe(0o700);
  });
  it.each(['symlink', 'directory-symlink', 'oversize', 'fifo'])('refuses a %s directory-config entry with operator fallback', invalid => {
    const f = directoryConfigFixture();
    const entry = join(f.config, 'unsafe');
    if (invalid === 'oversize') writeFileSync(entry, Buffer.alloc(65537));
    else if (invalid === 'fifo') expect(spawnSync('mkfifo', [entry]).status).toBe(0);
    else symlinkSync(invalid === 'directory-symlink' ? join(f.config, 'projects') : f.settings, entry);
    expect(() => preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir)).toThrow('operator review');
  });
  it('refuses ENOTDIR from settings lookup instead of treating it as absent', () => {
    const f = configFixture();
    const parent = join(f.homeDir, '.gemini/antigravity-cli');
    rmSync(parent, { recursive: true });
    writeFileSync(parent, 'not a directory');
    expect(() => preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir)).toThrow('operator review');
  });
  it.each([16, 17])('bounds directory config to 16 immediate entries: %s', count => {
    const f = directoryConfigFixture();
    for (let i = 4; i < count; i++) writeFileSync(join(f.config, `extra-${i}`), Buffer.alloc(65536));
    if (count > 16) expect(() => preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir)).toThrow('operator review');
    else {
      preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir);
      expect(readdirSync(join(f.privateHomeDir, '.gemini/config'))).toHaveLength(16);
      expect(readFileSync(join(f.privateHomeDir, '.gemini/config/extra-4'))).toHaveLength(65536);
    }
  });
  it('accepts a config exactly at the 64KB limit', () => {
    const f = configFixture();
    writeFileSync(f.config, Buffer.alloc(65536, 'x'));
    preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir);
    expect(readFileSync(join(f.privateHomeDir, '.gemini/config'))).toEqual(Buffer.alloc(65536, 'x'));
  });
  it.each(['null', '[]', '{'])('refuses malformed settings %s', content => {
    const f = configFixture();
    writeFileSync(f.settings, content);
    expect(() => preparePrivateAgyHome(f.homeDir, f.privateHomeDir, f.cloneDir)).toThrow('operator review');
  });
});

it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
  'REAL sandbox allows clone/private reads and system tools but denies sibling temp and real state reads with EPERM', () => {
    const f = fixture();
    const denied = join(f.root, 'extra-denied');
    mkdirSync(denied);
    writeFileSync(join(denied, 'secret'), 'fixture secret');
    mkdirSync(join(f.homeDir, '.gemini/antigravity-cli/conversations'));
    mkdirSync(join(f.homeDir, '.gemini/antigravity-cli/brain'));
    writeFileSync(join(f.homeDir, '.gemini/antigravity-cli/conversations/secret'), 'real conversation');
    const profileFile = join(f.root, 'profile.sb');
    writeFileSync(profileFile, buildSandboxProfile({ ...f, extraDeniedPaths: [denied] }), { mode: 0o600 });
    const run = (script, ...args) => {
      const [, ...argv] = sandboxedSpawnArgv(profileFile, ['/bin/sh', '-c', script, 'probe', ...args]);
      return spawnSync('/usr/bin/sandbox-exec', argv, { cwd: f.cloneDir, encoding: 'utf8', timeout: 10_000 });
    };
    const inside = join(f.cloneDir, 'allowed');
    expect(run('printf allowed > "$1"', inside).status).toBe(0);
    expect(existsSync(inside)).toBe(true);
    const cloneRead = run('/bin/cat "$1"', inside);
    expect(cloneRead.status).toBe(0);
    expect(cloneRead.stdout).toBe('allowed');
    expect(run('/bin/ls "$1"', f.cloneDir).status).toBe(0);
    const siblingTemp = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-sibling-test-')));
    roots.push(siblingTemp);
    const siblingFile = join(siblingTemp, 'other-worker-data');
    writeFileSync(siblingFile, 'sibling secret');
    const siblingRead = run('/bin/cat "$1"', siblingFile);
    expect(siblingRead.error).toBeUndefined();
    expect(siblingRead.status).not.toBe(0);
    expect(siblingRead.stderr).toMatch(/EPERM|Operation not permitted/i);
    expect(siblingRead.stdout).not.toContain('sibling secret');
    const arbitraryHomeFile = join(f.homeDir, 'unlisted-personal-data');
    writeFileSync(arbitraryHomeFile, 'private home data');
    const homeRead = run('/bin/cat "$1"', arbitraryHomeFile);
    expect(homeRead.error).toBeUndefined();
    expect(homeRead.status).not.toBe(0);
    expect(homeRead.stderr).toMatch(/EPERM|Operation not permitted/i);
    expect(homeRead.stdout).not.toContain('private home data');
    for (const allowed of [join(f.privateTempDir, 'allowed'),
      join(f.privateHomeDir, '.gemini/antigravity-cli/session'), join(f.privateHomeDir, '.gemini/projects.json')]) {
      expect(run('printf allowed > "$1"', allowed).status, allowed).toBe(0);
      expect(existsSync(allowed)).toBe(true);
      const read = run('/bin/cat "$1"', allowed);
      expect(read.status, allowed).toBe(0);
      expect(read.stdout).toBe('allowed');
    }
    const osTempTarget = join(realpathSync(tmpdir()), `${basename(f.root)}-blocked`);
    roots.push(osTempTarget);
    const sibling = join(f.homeDir, '.gemini-like');
    mkdirSync(sibling);
    for (const outside of [osTempTarget, join(f.root, 'blocked'), join(f.laneDir, 'blocked'),
      ...['settings.json', 'bin/x', 'builtin/x', 'installation_id', 'sibling', 'settings.json.123.tmp', 'log-sibling', 'log/x', 'conversations/x', 'brain/x', 'conversation_summaries.db', 'conversation_summaries.db-wal', 'conversation_summaries.db-shm', 'conversation_summaries.db-journal', 'jetbox_summaries_proto.pb', 'jetski_state.pbtxt', 'history.jsonl', 'cli.log'].map(p => join(f.homeDir, '.gemini/antigravity-cli', p)),
      join(sibling, 'blocked'), join(f.homeDir, '.gemini/other-state'),
      join(f.privateHomeDir, 'blocked'), join(f.homeDir, '.gemini/config'),
      ...['projects.json', 'projects.json.123.tmp', 'projects.json.123.tmp.extra'].map(p => join(f.homeDir, '.gemini', p))]) {
      const write = run('printf blocked > "$1"', outside);
      expect(write.error).toBeUndefined();
      expect(write.status, outside).not.toBe(0);
      expect(write.stderr).toMatch(/EPERM|Operation not permitted/i);
      expect(existsSync(outside)).toBe(false);
    }
    const privateRead = run('/bin/cat "$1"', join(f.privateHomeDir, '.gemini/projects.json'));
    expect(privateRead.status).toBe(0);
    expect(privateRead.stdout).toBe('allowed');
    const conversationRead = run('/bin/cat "$1"', join(f.homeDir, '.gemini/antigravity-cli/conversations/secret'));
    expect(conversationRead.status).not.toBe(0);
    expect(conversationRead.stderr).toMatch(/EPERM|Operation not permitted/i);
    expect(conversationRead.stdout).not.toContain('real conversation');
    const read = run('/bin/cat "$1"', join(denied, 'secret'));
    expect(read.error).toBeUndefined();
    expect(read.status).not.toBe(0);
    expect(read.stderr).toMatch(/EPERM|Operation not permitted/i);
    expect(read.stdout).not.toContain('fixture secret');
  },
);
