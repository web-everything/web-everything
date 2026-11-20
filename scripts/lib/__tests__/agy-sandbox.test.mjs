// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AGY_STATE_WRITE_DIRS, buildSandboxEnv, buildSandboxProfile, sandboxedSpawnArgv, sandboxSecretPaths } from '../agy-sandbox.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-sandbox-test-')));
  roots.push(root);
  const homeDir = join(root, 'home');
  const cloneDir = join(homeDir, 'clone');
  const privateTempDir = join(root, 'private-temp');
  const laneDir = join(root, 'lane');
  const stateDir = join(homeDir, '.gemini/antigravity-cli');
  const workspaceOps = join(homeDir, 'workspace/.operations');
  for (const p of [cloneDir, privateTempDir, laneDir, join(stateDir, 'log'), join(stateDir, 'bin'), join(stateDir, 'builtin'), ...sandboxSecretPaths(homeDir), workspaceOps]) mkdirSync(p, { recursive: true });
  writeFileSync(join(homeDir, '.gemini/antigravity-cli/antigravity-oauth-token'), Buffer.from([0, 255, 10, 123, 125]));
  return { transcriptDir: join(root, 'transcript'), root, homeDir, cloneDir, privateTempDir, laneDir, workspaceOps };
}

describe('pure sandbox profile', () => {
  it.each(['cloneDir', 'privateTempDir', 'workspaceOps'])
  ('refuses a transcript directory in %s with operator fallback', key => {
    const f = fixture();
    for (const transcriptDir of [f[key], join(f[key], 'transcript')])
      expect(() => buildSandboxProfile({ ...f, transcriptDir })).toThrow(/transcript directory.*operator review/);
  });
  it('refuses missing transcript containment evidence', () => {
    expect(() => buildSandboxProfile({ ...fixture(), transcriptDir: undefined })).toThrow('unsafe sandbox path');
  });
  it('grants exactly clone, private temp, measured log directory and devices; network remains allowed', () => {
    const f = fixture();
    const profile = buildSandboxProfile(f);
    expect(AGY_STATE_WRITE_DIRS).toEqual(['.gemini/antigravity-cli/log']);
    expect(profile).toContain('(deny file-write*)');
    const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
    expect(writeRule).toBe(`(allow file-write* ${[f.cloneDir, f.privateTempDir, join(f.homeDir, '.gemini/antigravity-cli/log')]
      .map(p => `(subpath ${JSON.stringify(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`);
    expect(profile).not.toContain('deny network');
  });
  it('denies reads of every secret root and workspace operations, plus extra denied paths', () => {
    const f = fixture();
    const extra = join(f.root, 'denied');
    mkdirSync(extra);
    const profile = buildSandboxProfile({ ...f, extraDeniedPaths: [extra] });
    const readRule = profile.split('\n').filter(line => line.startsWith('(deny file-read*')).at(-2);
    expect(profile.trim().endsWith('(deny file-read* (regex #"/\\.env[^/]*$"))')).toBe(true);
    for (const p of [...sandboxSecretPaths(f.homeDir), join(f.homeDir, 'workspace'), f.workspaceOps, extra])
      expect(readRule).toContain(`(subpath ${JSON.stringify(p)})`);
  });
  it('denies home reads before allowing only clone, private temp, agy state and install roots', () => {
    const f = fixture();
    const agyBinDir = join(f.homeDir, 'bin');
    const homebrewPrefix = join(f.homeDir, 'brew');
    const profile = buildSandboxProfile({ ...f, agyBinDir, homebrewPrefix });
    const rules = profile.split('\n');
    const homeDeny = `(deny file-read* (subpath ${JSON.stringify(f.homeDir)}))`;
    const allow = rules.find(line => line.startsWith('(allow file-read*'));
    expect(allow).toBe(`(allow file-read* ${[f.cloneDir, f.privateTempDir, join(f.homeDir, '.gemini'), agyBinDir, homebrewPrefix]
      .map(p => `(subpath ${JSON.stringify(p)})`).join(' ')})`);
    expect(rules.indexOf(homeDeny)).toBeGreaterThan(-1);
    expect(rules.indexOf(allow)).toBeGreaterThan(rules.indexOf(homeDeny));
    const secretDeny = rules.at(-3);
    expect(rules.indexOf(secretDeny)).toBeGreaterThan(rules.indexOf(allow));
    expect(sandboxSecretPaths(f.homeDir)).toEqual(['.ssh', '.aws', '.gnupg', '.netrc', '.secrets', '.config/gh',
      'Library/Keychains', '.plateau'].map(p => join(f.homeDir, p)));
    for (const path of sandboxSecretPaths(f.homeDir)) expect(secretDeny).toContain(`(subpath ${JSON.stringify(path)})`);
    expect(rules.at(-2)).toBe('(deny file-read* (regex #"/\\.env[^/]*$"))');
  });
  it.each(['agyBinDir', 'homebrewPrefix'])('refuses a binary root overlapping workspace: %s', key => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, [key]: join(f.homeDir, 'workspace/bin') }))
      .toThrow('binary overlaps workspace');
  });
  it('scrubs all inherited variables except the allowlist and replaces every temp variable', () => {
    const allowed = { PATH: '/usr/bin', HOME: '/home', USER: 'fixture', LOGNAME: 'fixture', SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm' };
    const env = buildSandboxEnv({ ...allowed, GH_TOKEN: 'secret', API_KEY: 'secret', AWS_PROFILE: 'secret',
      SSH_AUTH_SOCK: '/agent', GIT_CONFIG_GLOBAL: '/config', NODE_OPTIONS: '--require=host',
      ANTIGRAVITY_QUOTA_DIR: '/host', ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR: '/host',
      TMPDIR: '/host', TMP: '/host', TEMP: '/host', OTHER: 'secret' }, '/private-temp', '/real-home');
    expect(env).toEqual({ ...allowed, HOME: '/real-home', TMPDIR: '/private-temp', TMP: '/private-temp', TEMP: '/private-temp' });
  });
  it.each(['cloneDir', 'privateTempDir'])('refuses a writable %s under home/workspace', key => {
    const f = fixture();
    const p = join(f.homeDir, 'workspace/escape');
    expect(() => buildSandboxProfile({ ...f, [key]: p })).toThrow(/workspace/);
  });
  it('refuses a writable root under the canonical workspace alias', () => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, workspaceDir: join(f.root, 'workspace-target'),
      privateTempDir: join(f.root, 'workspace-target/cache') })).toThrow('under home/workspace');
  });
  it.each(['cloneDir', 'privateTempDir'])('refuses writable %s inside the lane', key => {
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
    for (const key of ['cloneDir', 'homeDir', 'workspaceOps', 'privateTempDir', 'laneDir', 'transcriptDir', 'extraDeniedPaths', 'deniedPaths']) {
      const p = join(f.root, `unsafe${char}path`);
      expect(() => buildSandboxProfile({ ...f, [key]: key.endsWith('Dirs') || key.endsWith('Paths') ? [p] : p }))
        .toThrow('unsafe sandbox path');
    }
  });
  it.each(['relative/path', '/absolute/../noncanonical'])('refuses noncanonical path %s', cloneDir => {
    expect(() => buildSandboxProfile({ ...fixture(), cloneDir })).toThrow('unsafe sandbox path');
  });
  it.each(['cloneDir', 'privateTempDir'])('refuses broader real .gemini writes through %s', key => {
    const f = fixture();
    expect(() => buildSandboxProfile({ ...f, [key]: join(f.homeDir, '.gemini/escape') })).toThrow();
  });
  it('refuses transcripts inside or containing the real-HOME log grant', () => {
    const f = fixture();
    for (const transcriptDir of [f.homeDir, join(f.homeDir, '.gemini/antigravity-cli/log/transcript')])
      expect(() => buildSandboxProfile({ ...f, transcriptDir })).toThrow(/transcript directory.*operator review/);
  });
  it('wraps argv without shell interpolation', () => {
    expect(sandboxedSpawnArgv('/profile with spaces.sb', ['sh', '-c', 'literal $input']))
      .toEqual(['sandbox-exec', '-f', '/profile with spaces.sb', 'sh', '-c', 'literal $input']);
  });
});

it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
  'REAL sandbox allows clone/temp/log writes and real-HOME login reads, denies outside writes and secret reads with EPERM', () => {
    const f = fixture();
    const denied = join(f.cloneDir, 'extra-denied');
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
    const cloneWrite = run('printf allowed > "$1"', inside);
    expect(cloneWrite.status, cloneWrite.stderr).toBe(0);
    expect(existsSync(inside)).toBe(true);
    const cloneRead = run('/bin/cat "$1"', inside);
    expect(cloneRead.status).toBe(0);
    expect(cloneRead.stdout).toBe('allowed');
    expect(run('/bin/ls "$1"', f.cloneDir).status).toBe(0);
    const siblingTemp = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-sibling-test-')));
    roots.push(siblingTemp);
    const siblingFile = join(siblingTemp, 'other-worker-data');
    for (const allowed of [join(f.privateTempDir, 'allowed'),
      join(f.homeDir, '.gemini/antigravity-cli/log/session')]) {
      expect(run('printf allowed > "$1"', allowed).status, allowed).toBe(0);
      expect(existsSync(allowed)).toBe(true);
      const read = run('/bin/cat "$1"', allowed);
      expect(read.status, allowed).toBe(0);
      expect(read.stdout).toBe('allowed');
    }
    const osTempTarget = join(realpathSync(tmpdir()), `${basename(f.root)}-blocked`);
    roots.push(osTempTarget);
    mkdirSync(join(f.homeDir, '.gemini/config'));
    const sibling = join(f.homeDir, '.gemini-like');
    mkdirSync(sibling);
    for (const outside of [osTempTarget, siblingFile, join(f.root, 'blocked'), join(f.laneDir, 'blocked'),
      ...['settings.json', 'bin/x', 'builtin/x', 'installation_id', 'sibling', 'settings.json.123.tmp', 'log-sibling', 'conversations/x', 'brain/x', 'conversation_summaries.db', 'conversation_summaries.db-wal', 'conversation_summaries.db-shm', 'conversation_summaries.db-journal', 'jetbox_summaries_proto.pb', 'jetski_state.pbtxt', 'history.jsonl', 'cli.log'].map(p => join(f.homeDir, '.gemini/antigravity-cli', p)),
      join(sibling, 'blocked'), join(f.homeDir, '.gemini/other-state'),
      join(f.homeDir, 'blocked'), join(f.homeDir, '.gemini/config/blocked'),
      ...['projects.json', 'projects.json.123.tmp', 'projects.json.123.tmp.extra'].map(p => join(f.homeDir, '.gemini', p))]) {
      const write = run('printf blocked > "$1"', outside);
      expect(write.error).toBeUndefined();
      expect(write.status, outside).not.toBe(0);
      expect(write.stderr).toMatch(/EPERM|Operation not permitted/i);
      expect(existsSync(outside)).toBe(false);
    }
    // These files exist: a missing-file error would not prove read confinement.
    for (const path of [join(f.homeDir, 'personal-notes'), join(f.cloneDir, '.env'),
      join(f.privateTempDir, '.env.local'), join(f.homeDir, '.gemini/.env.credentials')]) {
      writeFileSync(path, 'fixture secret');
      const read = run('/bin/cat "$1"', path);
      expect(read.error).toBeUndefined();
      expect(read.status, path).not.toBe(0);
      expect(read.stderr).toMatch(/EPERM|Operation not permitted/i);
      expect(read.stdout).toBe('');
    }
    const realLogin = run('/bin/cat "$1"', join(f.homeDir, '.gemini/antigravity-cli/antigravity-oauth-token'));
    expect(realLogin.status).toBe(0);
    for (const root of [...sandboxSecretPaths(f.homeDir), f.workspaceOps, denied]) {
      writeFileSync(join(root, 'secret'), 'fixture secret');
      const read = run('/bin/cat "$1"', join(root, 'secret'));
      expect(read.error).toBeUndefined();
      expect(read.status, root).not.toBe(0);
      expect(read.stderr).toMatch(/EPERM|Operation not permitted/i);
      expect(read.stdout).not.toContain('fixture secret');
    }
  },
);

it('documents that direct write and home-read confinement excludes service-mediated writes and secret reads', () => {
  for (const path of ['../agy-sandbox.mjs', '../../../docs/agent/testing.md']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(text).toContain("process's own file writes and home reads");
    expect(text).toContain('Mach/XPC/LaunchServices-mediated writes');
    expect(text).toContain('Service-mediated secret reads');
    for (const channel of ['securityd', 'gh auth token', 'ssh-agent']) expect(text).toContain(channel);
    for (const command of ['defaults', 'open', 'osascript', 'launchctl']) expect(text).toContain(command);
    expect(text).toContain('out of scope');
  }
});
