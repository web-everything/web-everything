// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { AGY_STATE_WRITE_DIRS, buildSandboxEnv, buildSandboxProfile, sandboxedSpawnArgv, sandboxSecretPaths } from '../agy-sandbox.mjs';
import { defaultSpawnAgy, runConfinedAgyBuild } from '../agy-confined-build.mjs';
import { AGY_FIX_PROVIDER } from '../../operations/agy-fix-provider.mjs';
import { fixLauncherAvailable } from '../../operations/dispatch-providers/fix.mjs';

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
  it('grants exactly clone, private temp, measured log directory and devices; network is denied', () => {
    const f = fixture();
    const profile = buildSandboxProfile(f);
    expect(AGY_STATE_WRITE_DIRS).toEqual(['.gemini/antigravity-cli/log']);
    expect(profile).toContain('(deny file-write*)');
    const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
    expect(writeRule).toBe(`(allow file-write* ${[f.cloneDir, f.privateTempDir, join(f.homeDir, '.gemini/antigravity-cli/log')]
      .map(p => `(subpath ${JSON.stringify(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`);
    expect(profile).toContain('(deny network*)');
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
    expect(allow).toBe(`(allow file-read* ${[f.cloneDir, f.privateTempDir, join(f.homeDir, '.gemini'), agyBinDir, homebrewPrefix, dirname(realpathSync(process.execPath)), '/usr/bin', ...(realpathSync(process.execPath).match(/^(.*)\/(?:Cellar|Caskroom)\//)?.[1] ? [realpathSync(process.execPath).match(/^(.*)\/(?:Cellar|Caskroom)\//)[1]] : []), '/usr', '/bin', '/System', '/Library', '/private/var/db', '/private/preboot/Cryptexes/OS', '/dev/null', '/dev/urandom', '/dev/random', '/dev/dtracehelper']
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

describe('agy sandbox is deny-default', () => {
  it('starts with version and deny default, never allow default, and denies network', () => {
    const profile = buildSandboxProfile(fixture());
    expect(profile.startsWith('(version 1)\n(deny default)\n')).toBe(true);
    expect(profile).not.toContain('(allow default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toMatch(/\(allow (?:network|mach-lookup)/);
  });
  it('restricts process-exec to literal resolved node/npm/git/agy binaries', () => {
    const f = fixture();
    const executables = { node: realpathSync(process.execPath), npm: '/opt/toolchain/npm', git: '/usr/bin/git', agy: '/opt/agy/bin/agy' };
    const profile = buildSandboxProfile({ ...f, executables });
    expect(profile.split('\n').filter(line => line.startsWith('(allow process-exec')))
      .toEqual(Object.values(executables).map(p => `(allow process-exec (literal ${JSON.stringify(p)}))`));
    expect(profile).not.toMatch(/\(allow process-exec\s*\)/);
  });
  it.each([{ shell: '/bin/sh' }, { node: '/' }, { node: 'relative' }, null])('rejects invalid executable policy %j', executables => {
    expect(() => buildSandboxProfile({ ...fixture(), executables })).toThrow(/executable|unsafe sandbox path/);
  });
  it('keeps production unavailable until the real sandbox is proven', () => {
    expect(AGY_FIX_PROVIDER.confinement.mode).toBe('unavailable');
    expect(fixLauncherAvailable('antigravity', { taskKind: 'doc-fix', size: 1, scope: ['docs'], exists: () => true })).toBe(false);
  });
});

it('production launcher refuses before accessing launch options while real proof is blocked', async () => {
  const readCli = vi.fn();
  await expect(defaultSpawnAgy({ get cli() { return readCli(); } })).rejects.toThrow(/confinement unavailable.*operator review/);
  expect(readCli).not.toHaveBeenCalled();
});

it('production provider refuses explicit selection before resolving a lane or executing a task', async () => {
  const resolveLane = vi.fn(); const runTask = vi.fn();
  await expect(AGY_FIX_PROVIDER.spawn({ prompt: 'repair', kind: 'doc-fix', size: 1, scope: ['docs'] }, { resolveLane, runTask }))
    .rejects.toThrow(/confinement unavailable.*operator review/);
  expect(resolveLane).not.toHaveBeenCalled(); expect(runTask).not.toHaveBeenCalled();
});
it('production build refuses Darwin before git or scratch work until live proof', async () => {
  const exec = vi.fn(); const mkTempDir = vi.fn();
  const result = await runConfinedAgyBuild({ task: 'repair', laneDir: '/unused-lane', kind: 'doc-fix', size: 1, scope: ['docs'],
    deps: { platform: 'darwin', sandboxExists: () => true, exec, mkTempDir, readFile: () => '{}', env: {}, log: () => {} } });
  expect(result).toMatchObject({ status: 'refused', applied: [], reasons: [expect.stringMatching(/confinement unavailable.*operator review/)] });
  expect(exec).not.toHaveBeenCalled(); expect(mkTempDir).not.toHaveBeenCalled();
});

// Seatbelt and sandbox-exec are macOS-only; never substitute a mocked security probe.
const realProbe = it.skipIf(process.platform !== 'darwin');
function probeFixture() {
  const f = fixture();
  const node = realpathSync(process.execPath);
  const profileFile = join(f.root, 'profile.sb');
  writeFileSync(profileFile, buildSandboxProfile({ ...f, agyBinDir: dirname(node), executables: { node } }));
  // `env -i` re-applies the scrubbed environment: the test-cache tracer injects NODE_OPTIONS into every spawn.
  const env = buildSandboxEnv(process.env, f.privateTempDir, f.homeDir);
  return { ...f, run: code => spawnSync('/usr/bin/env', ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    '/usr/bin/sandbox-exec', '-f', profileFile, node, '-e', code], {
    cwd: f.cloneDir, encoding: 'utf8', timeout: 10_000,
  }) };
}
function expectProbe(result) {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}
realProbe('REAL deny-default node can execute and write clone/private temp/log files', () => {
  const f = probeFixture();
  for (const dir of [f.cloneDir, f.privateTempDir, join(f.homeDir, '.gemini/antigravity-cli/log')]) {
    const target = join(dir, 'allowed');
    expectProbe(f.run(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'allowed'); console.log('ran-node')`));
    expect(readFileSync(target, 'utf8')).toBe('allowed');
  }
});
realProbe('REAL deny-default node cannot read planted fake-HOME ssh/secrets or clone .env', () => {
  const f = probeFixture();
  for (const path of [join(f.homeDir, '.ssh/secret'), join(f.homeDir, '.secrets/secret'), join(f.cloneDir, '.env')]) {
    writeFileSync(path, 'planted secret');
    expectProbe(f.run(`try { require('node:fs').readFileSync(${JSON.stringify(path)}); process.exit(9); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; }`));
  }
});
realProbe('REAL deny-default node cannot write outside clone/temp/log grants', () => {
  const f = probeFixture();
  for (const dir of [f.root, f.laneDir, f.homeDir]) {
    const path = join(dir, 'blocked');
    expectProbe(f.run(`try { require('node:fs').writeFileSync(${JSON.stringify(path)}, 'blocked'); process.exit(9); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; }`));
    expect(existsSync(path)).toBe(false);
  }
});
realProbe('REAL deny-default node cannot connect TCP to a listening loopback server', async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const f = probeFixture();
    expectProbe(f.run(`const s = require('node:net').connect(${server.address().port}, '127.0.0.1');
      s.on('connect', () => { s.destroy(); process.exit(9); });
      s.on('error', e => { if (!['EPERM', 'EACCES'].includes(e.code)) { console.error(e); process.exit(8); } });`));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
realProbe('REAL deny-default node cannot execute an unlisted shell', () => {
  const f = probeFixture();
  expectProbe(f.run(`const r = require('node:child_process').spawnSync('/bin/sh', ['-c', 'exit 0']);
    if (!r.error || !['EPERM', 'EACCES'].includes(r.error.code)) { console.error(r); process.exit(9); }`));
});
