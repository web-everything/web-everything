// @vitest-environment node
/** @file Contract and execution tests for the Forge remote runner. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  isAllowedCommand, filterEnv, validateRunId,
  runRemote, runWithRemoteFallback, parseArgs, defaultExec,
} from '../remote-exec.mjs';
import { createRunner } from '../forge-exec-run.mjs';
import { runWithRemoteDecision, resolveAdmissionPolicy } from '../heavy-admission.mjs';

const argv = ['npm', 'run', 'test:unit', '--', 'a.test.mjs'];
const runId = 'abcdef-1';
const allowedEnv = {
  CI: 'true', NODE_ENV: 'test', TZ: 'UTC', LANG: 'C', LC_ALL: 'C', FORCE_COLOR: '0', NO_COLOR: '1',
};
const forbiddenEnv = {
  GITHUB_TOKEN: 'secret-token-marker', ANTHROPIC_API_KEY: 'secret-key-marker',
  SECRET: 'secret-secret-marker', PASSWORD: 'secret-password-marker',
  LOGIN: 'secret-login-marker', AUTH: 'secret-auth-marker',
  CREDENTIAL: 'secret-credential-marker', mixedCaseToken: 'secret-mixed-marker',
  HOME: 'private-home-marker', PATH: 'private-path-marker', OTHER: 'private-other-marker',
};
let cwd;
beforeEach(() => {
  // Task scratch must stay under the launcher-provided TMPDIR.
  cwd = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'remote-exec-test-')));
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const sshText = (call) => call.args.join(' ');
const isCleanup = (call) => call.file === 'ssh' && sshText(call).endsWith(' finish');
const isReceipt = isCleanup;
const isPrepare = (call) => call.file === 'ssh' && sshText(call).endsWith(' prepare');
const isRun = (call) => call.file === 'ssh' && sshText(call).endsWith(' run');
const callsOf = (exec) => exec.mock.calls.map(([call]) => call);
const nonceOf = (input) => JSON.parse(input).nonce;

function fixture({ probeCode = 0, copyCode = 0, prepareCode = 0, runCode = 0, receipt, receiptCode = 0 } = {}) {
  let state;
  const exec = vi.fn(async (call) => {
    if (call.file === 'git') return { code: 0, stdout: 'package-lock.json\na.test.mjs\n' };
    if (call.file === 'rsync') return { code: copyCode, stdout: '' };
    if (isPrepare(call)) {
      state = JSON.parse(call.input);
      state.run = 'r-' + state.nonce;
      return { code: prepareCode, stdout: JSON.stringify({run: state.run}) };
    }
    if (isRun(call)) { state = {...state, ...JSON.parse(call.input)}; return {code: runCode, stdout: ''}; }
    if (isReceipt(call)) {
      const value = {v:1, nonce:state.nonce, run:state.run, inputDigest:state.inputDigest,
        argvDigest:state.argvDigest, lock:state.lock, phase:'test', code:runCode};
      return {code:receiptCode, stdout: typeof receipt === 'function' ? receipt(state.nonce, value) : receipt ?? JSON.stringify(value)};
    }
    if (call.file === 'ssh' && call.args.at(-1) === 'true') return {code:probeCode, stdout:''};
    throw new Error(`Unexpected exec call: ${JSON.stringify(call)}`);
  });
  const local = vi.fn(async () => 7);
  const listFiles = vi.fn(async () => ['package-lock.json', 'a.test.mjs']);
  writeFileSync(join(cwd, 'a.test.mjs'), 'fixture');
  return {exec, local, listFiles, argv:[...argv], cwd, env:{...allowedEnv,...forbiddenEnv}, runId};
}
function expectNoSecrets(exec) {
  const transport = JSON.stringify(callsOf(exec).map(({args,input}) => ({args,input})));
  for (const value of Object.values(forbiddenEnv)) expect(transport).not.toContain(value);
}
function realRemoteFixture(files) {
  const f = fixture();
  f.listFiles.mockResolvedValue(files);
  const root = join(cwd, 'server');
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const npmCli = realpathSync(spawnSync('which', ['npm'], {encoding:'utf8'}).stdout.trim());
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const name of ['user.npmrc','global.npmrc']) writeFileSync(join(cwd,name),'');
  symlinkSync(process.execPath, join(bin,'node'));
  writeFileSync(join(bin,'npm'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(npmCli)} --offline --cache=${quote(join(cwd,'npm-cache'))} --userconfig=${quote(join(cwd,'user.npmrc'))} --globalconfig=${quote(join(cwd,'global.npmrc'))} "$@"\n`, {mode:0o755});
  const runner = createRunner({testRoot:root, testPath:`${bin}:/usr/bin:/bin`});
  const runs = [];
  let serverRun;
  const fake = f.exec;
  f.exec = vi.fn(async call => {
    if (isPrepare(call)) {
      const result = await runner.prepare(JSON.parse(call.input));
      serverRun = result.run;
      return {code:0, stdout:JSON.stringify(result)};
    }
    if (call.file === 'rsync') {
      const args = call.args.filter((arg,i,all) => !arg.startsWith('--rsync-path=') && arg !== '-e' && all[i-1] !== '-e');
      args[args.length-1] = join(root,'runs',serverRun,'work') + '/';
      const result = spawnSync('rsync',args,{cwd,input:call.input,encoding:'utf8',timeout:10000});
      return {code:result.status,stdout:result.stdout};
    }
    if (isRun(call)) {
      const result = await runner.run(JSON.parse(call.input));
      runs.push({status:result.code,stdout:result.stdout,stderr:result.stderr});
      return {code:result.code,stdout:result.stdout};
    }
    if (isReceipt(call)) return {code:0,stdout:JSON.stringify(await runner.finish(JSON.parse(call.input)))};
    return fake(call);
  });
  return {...f,root,bin,runs, get serverRun(){return serverRun;}};
}

describe('remote snapshot regressions', () => {
  it.each(['snapshot', 'stale remote'])('falls back when a %s receipt says 97 and npm ci fails before the command', async (source) => {
    writeFileSync(join(cwd, '.exit-code'), '97\n');
    const f = realRemoteFixture(['package-lock.json', '.exit-code']);
    if (source === 'stale remote') {
      mkdirSync(join(f.root, runId), {recursive:true});
      writeFileSync(join(f.root, runId, '.exit-code'), '97\n');
    }
    const transport = f.exec;
    const receiptPresence = [];
    f.exec = vi.fn(async (call) => {
      if (call.file === 'rsync') receiptPresence.push(existsSync(join(f.root, 'runs', f.serverRun, 'work', '.exit-code')));
      const result = await transport(call);
      // Observe the snapshot and failed runner before cleanup can hide a receipt.
      if (call.file === 'rsync' || isRun(call)) receiptPresence.push(existsSync(join(f.root, 'runs', f.serverRun, 'work', '.exit-code')));
      return result;
    });
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nif [ "$1" = ci ]; then echo INJECTED_INSTALL_FAILURE >&2; exit 1; fi\necho COMMAND_RAN\n', { mode: 0o755 });
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0].status).toBe(97);
    expect(f.runs[0].stderr).toContain('INJECTED_INSTALL_FAILURE');
    expect(f.runs[0].stdout).not.toContain('COMMAND_RAN');
    expect(receiptPresence).toEqual([false, false, false]);
    if(source === 'stale remote') expect(readFileSync(join(f.root,runId,'.exit-code'),'utf8')).toBe('97\n');
    expect(f.local).toHaveBeenCalledTimes(1);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('install-failed'));
    expect(callsOf(f.exec).find((call) => call.file === 'rsync').input).not.toContain('.exit-code');
    expect(existsSync(join(f.root, 'runs', f.serverRun))).toBe(false);
    expect(await runWithRemoteDecision({ argv: f.argv, cwd,
      policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
      remoteExec: options => runRemote({ ...f, ...options }), log: vi.fn(),
    })).toEqual({ handled: false });
  });

  it('confirms command exit 97 with a fresh receipt on cold and warm caches', async () => {
    const f = realRemoteFixture(['package-lock.json']);
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nif [ "$1" = ci ]; then exit 0; fi\necho COMMAND_RAN\nexit 97\n', { mode: 0o755 });
    for (const state of ['cold', 'warm']) {
      expect(await runRemote(f), state).toEqual({ mode: 'remote', code: 97 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
      expect(f.local).not.toHaveBeenCalled();
    }
  });

  it('preserves nested workspace dependencies across cold and warm runs', async () => {
    const workspace = "packages/deep/worker's space";
    const files = ['package.json', 'package-lock.json', `${workspace}/package.json`, 'probe.cjs'];
    // Local tarballs force real npm to install conflicting versions without a registry.
    for (const version of [1, 2]) {
      const source = join(cwd, `source-${version}`);
      mkdirSync(join(source, 'package'), { recursive: true });
      writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name: 'cache-dependency', version: `${version}.0.0` }));
      const archive = `dependency-${version}.tgz`;
      const packed = spawnSync('tar', ['-czf', join(cwd, archive), '-C', source, 'package'], { encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      files.push(archive);
    }
    mkdirSync(join(cwd, workspace), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', workspaces: [workspace],
      dependencies: { 'cache-dependency': 'file:dependency-1.tgz' },
      scripts: { 'test:unit': 'node probe.cjs' },
    }));
    writeFileSync(join(cwd, workspace, 'package.json'), JSON.stringify({
      name: 'worker', version: '1.0.0', dependencies: { 'cache-dependency': 'file:../../../dependency-2.tgz' },
    }));
    writeFileSync(join(cwd, 'probe.cjs'), `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const worker = createRequire(require('node:path').resolve(${JSON.stringify(workspace)}, 'package.json'));
const versions = [require('cache-dependency/package.json').version, worker('cache-dependency/package.json').version];
assert.deepEqual(versions, ['1.0.0', '2.0.0']);
assert.equal(require('worker/package.json').name, 'worker');
console.log('RESOLVED ' + versions.join(','));
`);
    const f = realRemoteFixture(files);
    const locked = spawnSync(join(f.bin, 'npm'), ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 20000 });
    expect(locked.status, locked.stderr).toBe(0);
    const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
    expect(lock.packages[`${workspace}/node_modules/cache-dependency`].version).toBe('2.0.0');
    for (const state of ['cold', 'warm']) {
      const result = await runRemote(f);
      expect(result, `${state}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('RESOLVED 1.0.0,2.0.0');
      expect(existsSync(join(f.root, 'runs', f.serverRun))).toBe(false);
    }
  }, 120000);

  it('reuses an empty dependency snapshot and falls back if the archive is corrupt', async () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', scripts: { 'test:unit': 'node -e "console.log(\'COMMAND_RAN\')"' },
    }));
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }));
    const f = realRemoteFixture(['package.json', 'package-lock.json']);
    for (const state of ['cold', 'warm']) {
      expect(await runRemote(f), `${state}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
    }
    const hash = createHash('sha256').update(readFileSync(join(cwd, 'package-lock.json'))).digest('hex');
    writeFileSync(join(f.root, 'cache', hash, 'dev-v3/dependencies.tar'), 'corrupt archive');
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(f.runs.at(-1).stdout).not.toContain('COMMAND_RAN');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('install-failed'));
    expect(existsSync(join(f.root, 'runs', f.serverRun))).toBe(false);
  }, 120000);

  it('copies rsync comment-like and shell-special filenames literally through the real transport', async () => {
    const files = ['#required-fixture.json', ';required-fixture.json', 'two words', "quote'`$()", '--option', 'é\u2028fixture', '＃invisible\u200b', 'tab\tfile', 'trailing '];
    const f = realRemoteFixture(['package-lock.json', ...files]);
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nexit 0\n', {mode:0o755});
    for (const file of files) writeFileSync(join(cwd, file), `contents: ${file}`);
    // Inspect the real rsync result before allowing the mocked remote command.
    const transport = f.exec;
    const transferred = new Map();
    let nonce;
    f.exec = vi.fn(async (call) => {
      if (isRun(call)) {
        nonce = nonceOf(call.input);
        for (const file of files) {
          const path = join(f.root, 'runs', f.serverRun, 'work', file);
          transferred.set(file, existsSync(path) ? readFileSync(path, 'utf8') : null);
        }
      }
      return transport(call);
    });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code: 0 });
    for (const file of files) expect(transferred.get(file), file).toBe(`contents: ${file}`);
  });

  it.each(['root', 'workspace'])('rejects a changed %s manifest against an unchanged lock on both warm and cold caches', async (kind) => {
    const manifest = { name: 'fixture', version: '1.0.0', workspaces: ['packages/*'], scripts: { 'test:unit': 'node -e "console.log(\'COMMAND_RAN\')"' } };
    const worker = { name: 'worker', version: '1.0.0' };
    const packages = {
      '': { name: 'fixture', version: '1.0.0', workspaces: manifest.workspaces },
      'packages/worker': worker,
      'node_modules/worker': { resolved: 'packages/worker', link: true },
    };
    const files = ['package.json', 'package-lock.json', 'packages/worker/package.json', 'vendor/missing-lock-dependency/package.json'];
    mkdirSync(join(cwd, 'vendor/missing-lock-dependency'), { recursive: true });
    writeFileSync(join(cwd, 'vendor/missing-lock-dependency/package.json'), JSON.stringify({ name: 'missing-lock-dependency', version: '1.0.0' }));
    mkdirSync(join(cwd, 'packages/worker'), { recursive: true });
    writeFileSync(join(cwd, 'packages/worker/package.json'), JSON.stringify(worker));
    let changedManifest = manifest;
    let changedPath = join(cwd, 'package.json');
    if (kind === 'workspace') {
      changedManifest = worker;
      changedPath = join(cwd, 'packages/worker/package.json');
    }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }));
    const f = realRemoteFixture(files);
    // Populate, then prove a valid cache hit can still execute.
    for (const attempt of [1, 2]) {
      expect(await runRemote(f), `valid attempt ${attempt}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
    }
    changedManifest.dependencies = { 'missing-lock-dependency': kind === 'root' ? 'file:vendor/missing-lock-dependency' : 'file:../../vendor/missing-lock-dependency' };
    writeFileSync(changedPath, JSON.stringify(changedManifest));
    const validation = spawnSync(join(f.bin, 'npm'), ['ci', '--dry-run', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 20000 });
    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain('Missing: missing-lock-dependency@1.0.0 from lock file');
    for (const state of ['warm', 'cold']) {
      if (state === 'cold') rmSync(join(f.root, 'cache'), { recursive: true, force: true });
      const log = vi.fn();
      expect(await runWithRemoteFallback({ ...f, log }), state).toBe(7);
      expect(f.runs.at(-1).status, f.runs.at(-1).stderr).toBe(97);
      expect(f.runs.at(-1).stderr).toContain('npm ci');
      expect(f.runs.at(-1).stdout).not.toContain('COMMAND_RAN');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('install-failed'));
    }
  }, 120000);
});

describe('isAllowedCommand', () => {
  it.each(['test:unit', 'check:standards'])('rejects npm options before the argument separator for %s', (script) => {
    for (const args of [
      ['--script-shell=/usr/bin/true'], ['--script-shell', '/usr/bin/true'],
      ['--ignore-scripts'], ['--if-present'], ['--help'], ['--workspace=other'],
      ['a.test.mjs', '--script-shell=/usr/bin/true'],
      ['--script-shell=/usr/bin/true', '--', 'a.test.mjs'],
      ['—', '--script-shell=/usr/bin/true'], ['--\u200b', '--help'],
    ]) {
      expect(isAllowedCommand(['npm', 'run', script, ...args]), JSON.stringify(args)).toBe(false);
      expect(isAllowedCommand(['npm', 'run', script, ...args])).toBe(false);
    }
    expect(isAllowedCommand(['npm', 'run', script, '--', '--script-shell=/usr/bin/true'])).toBe(true);
  });
  it.each(['test:unit', 'check:standards'])('allows exactly the npm run %s prefix, including extra args', (script) => {
    expect(isAllowedCommand(['npm', 'run', script])).toBe(true);
    expect(isAllowedCommand(['npm', 'run', script, '--', 'a.test.mjs'])).toBe(true);
  });
  it.each([
    [], null, undefined, {}, 'npm run test:unit', ['npm'], ['npm', 'run'],
    ['npm', 'run', 'build'], ['sh', '-c', 'npm run test:unit'], ['npx', 'vitest'],
    ['npm', 'run', 'test:unit-extra'], ['npm', 'run', 'check:standards-extra'],
    ['env', 'npm', 'run', 'test:unit'], ['npm', 'test'],
  ].map((value) => [value]))('fails closed for disallowed or incomplete argv: %j', (value) => {
    expect(isAllowedCommand(value)).toBe(false);
  });
});

describe('filterEnv', () => {
  it('keeps exactly the allowlist and drops secret names, HOME, PATH, and unknown names', () => {
    const env = { ...allowedEnv, ...forbiddenEnv };
    expect(filterEnv(env)).toEqual(allowedEnv);
    expect(env).toEqual({ ...allowedEnv, ...forbiddenEnv });
  });
  it('does not promote inherited or differently cased names into the allowlist', () => {
    expect(filterEnv(Object.assign(Object.create({ CI: 'inherited' }), { ci: 'lowercase', TZ: 'UTC' })))
      .toEqual({ TZ: 'UTC' });
    expect(filterEnv({})).toEqual({});
  });
});

describe('validateRunId', () => {
  it.each(['abcdef', 'abcdef-1', '0abcde', `a${'-'.repeat(63)}`])('accepts valid boundary/id %s', (id) => {
    expect(validateRunId(id)).toBe(true);
  });
  it.each([
    '', 'abcde', `a${'b'.repeat(64)}`, '-abcde', 'ABCDEF', 'abc_def', '../abcdef',
    'abcdef/x', 'abcdef\n', 'abcdef;id', '$(id)', null, undefined, 123456,
  ])('rejects malformed, oversized, or non-string id %j', (id) => {
    expect(validateRunId(id)).toBe(false);
  });
});

describe('runRemote', () => {
  it('the production process adapter confirms a real child is dead after abort', async () => {
    const controller = new AbortController();
    const pidFile = join(cwd, 'transport.pid');
    const pending = defaultExec({ file: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
      cwd, signal: controller.signal,
    });
    try {
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).not.toThrow();
      controller.abort();
      expect(await pending).toEqual({ mode: 'cancelled', terminated: true });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { controller.abort(); await pending; }
  });

  it('admission permits local fallback only after the real executor finishes its aborted probe', async () => {
    const f = fixture();
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const exec = vi.fn(async call => {
      if (call.args.at(-1) === 'true') {
        entered();
        await new Promise(resolve => { release = resolve; });
      }
      return f.exec(call);
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = runWithRemoteDecision({ argv, cwd,
        policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
        timeoutMs: 20, log: vi.fn(), remoteExec: options => runRemote({ ...f, ...options, exec }),
      }).then(value => { settled = true; return value; });
      await reached;
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(false);
      release();
      expect(await pending).toEqual({ handled: false });
      expect(callsOf(exec).some(isRun)).toBe(false);
    } finally { release?.(); vi.useRealTimers(); }
  });
  it.each(['injected', 'git'])('excludes conventional credential and private-key paths from the %s transport inventory', async (inventory) => {
    const f = fixture();
    const safe = [
      'package-lock.json', 'src/a file.mjs', 'src/identity.mjs', 'docs/key-handling.md',
      ...['js', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].map((ext) => `src/identity.${ext}`),
    ];
    const secrets = [
      '.git', '.git/config', '.git-credentials', '.git-credentials.backup', 'nested/.GIT-CREDENTIALS',
      '.git-credentials~', '.git-credentials-old',
      'id_custom', 'nested/id_backup', '.envrc', '.environment', 'id_rsa', 'keys/ID_RSA', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'id_xmss',
      'keys/id_rsa.backup', 'keys/id_rsa~', 'keys/id_ed25519.pub', 'identity', 'keys/identity.pub',
      'keys/IDENTITY', 'keys/IDENTITY.PUB', 'keys/identity.backup', 'keys/identity~',
      'keys/identity-old', 'keys/identity_old', 'keys/identity.pub.backup', 'keys/identity.mjs.backup',
      'keys/identity.pem', 'keys/identity.key', '.ssh/identity.mjs', 'credentials/identity.ts',
      '.env', 'nested/.env.local', '.npmrc', '.netrc', 'credentials', 'credentials.json',
      'credentials/token', '.ssh/config', '.aws/config', 'keys/server.pem', 'keys/server.KEY',
    ];
    for (const file of safe) {
      mkdirSync(join(cwd, file, '..'), { recursive: true });
      writeFileSync(join(cwd, file), 'fixture');
    }
    f.listFiles.mockResolvedValue([...safe, ...secrets]);
    const exec = vi.fn(async (call) => call.file === 'git'
      ? { code: 0, stdout: [...safe, ...secrets].join('\0') + '\0' } : f.exec(call));
    const options = { ...f, exec };
    if (inventory === 'git') delete options.listFiles;
    expect(await runRemote(options)).toEqual({ mode: 'remote', code: 0 });
    expect(callsOf(exec).find((call) => call.file === 'rsync').input).toBe(safe.map(file => `./${file}\0`).join(''));
  });
  it.each(['probe', 'inventory', 'prepare', 'copy', 'dispatch boundary'])(
    'cancels the real executor during %s without ever dispatching the command', async (stage) => {
      const f = fixture();
      const controller = new AbortController();
      let release;
      let entered;
      const reached = new Promise((resolve) => { entered = resolve; });
      const slow = async () => {
        entered();
        await new Promise((resolve) => { release = resolve; });
      };
      const exec = vi.fn(async (call) => {
        if ((stage === 'probe' && call.args.at(-1) === 'true') || (stage === 'prepare' && isPrepare(call)) || (stage === 'copy' && call.file === 'rsync')) await slow();
        return f.exec(call);
      });
      const listFiles = async () => {
        if (stage === 'inventory') await slow();
        return f.listFiles();
      };
      const env = stage === 'dispatch boundary' ? { get CI() { controller.abort(); return 'true'; } } : f.env;
      const pending = runRemote({ ...f, exec, listFiles, env, signal: controller.signal });
      if (stage !== 'dispatch boundary') {
        await reached;
        controller.abort();
        release(); // The injected exec deliberately does NOT implement cancellation.
      }
      expect(await pending).toEqual({ mode: 'cancelled', terminated: true });
      expect(callsOf(exec).some(isRun)).toBe(false);
      if (stage === 'probe' || stage === 'inventory') expect(callsOf(exec).some(call => call.file === 'rsync')).toBe(false);
      if (stage === 'prepare' || stage === 'copy' || stage === 'dispatch boundary') expect(callsOf(exec).some(isCleanup)).toBe(true);
    },
  );
  it('does no IO when already aborted', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await runRemote({ ...f, signal: controller.signal })).toEqual({ mode: 'cancelled', terminated: true });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(['probe', 'git inventory', 'prepare', 'copy'].flatMap(stage =>
    ['false acknowledgement', 'missing acknowledgement', 'empty result', 'rejection'].map(outcome => [stage, outcome])))(
    'refuses timeout fallback when %s returns %s without confirming child termination', async (stage, outcome) => {
      const f = fixture();
      const options = { ...f };
      if (stage === 'git inventory') delete options.listFiles;
      let entered;
      const reached = new Promise(resolve => { entered = resolve; });
      const exec = vi.fn(async call => {
        if ((stage === 'probe' && call.args.at(-1) === 'true')
          || (stage === 'git inventory' && call.file === 'git')
          || (stage === 'prepare' && isPrepare(call))
          || (stage === 'copy' && call.file === 'rsync')) {
          entered();
          await new Promise(resolve => call.signal.addEventListener('abort', resolve, { once: true }));
          if (outcome === 'rejection') throw new Error('transport termination unknown');
          if (outcome === 'empty result') return undefined;
          return { mode: 'cancelled', ...(outcome === 'false acknowledgement' ? { terminated: false } : {}) };
        }
        return f.exec(call);
      });
      vi.useFakeTimers();
      try {
        let remote;
        const pending = runWithRemoteDecision({ argv, cwd,
          policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
          timeoutMs: 20, log: vi.fn(),
          remoteExec: request => (remote = runRemote({ ...options, ...request, exec })),
        });
        await reached;
        await vi.advanceTimersByTimeAsync(20);
        expect(await remote).toEqual({ mode: 'cancelled', terminated: false });
        expect(await pending).toEqual({ handled: true, exitCode: 124 });
        expect(callsOf(exec).some(isRun)).toBe(false);
      } finally { vi.useRealTimers(); }
    },
  );

  it.each(['probe', 'copy', 'run'])('cannot dispatch after admission returns 124 for an unresponsive %s', async (stage) => {
    const f = fixture();
    let entered, release, remote;
    const reached = new Promise(resolve => { entered = resolve; });
    const exec = vi.fn(async call => {
      if ((stage === 'probe' && call.args.at(-1) === 'true') || (stage === 'copy' && call.file === 'rsync') || (stage === 'run' && isRun(call))) {
        entered();
        await new Promise(resolve => { release = resolve; });
      }
      return f.exec(call);
    });
    vi.useFakeTimers();
    try {
      const pending = runWithRemoteDecision({ argv, cwd,
        policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
        timeoutMs: 20, log: vi.fn(),
        remoteExec: options => (remote = runRemote({ ...f, ...options, exec })),
      });
      await reached;
      await vi.advanceTimersByTimeAsync(1020);
      expect(await pending).toEqual({ handled: true, exitCode: 124 });
      release();
      expect(await remote).toMatchObject(stage === 'run' ? { mode: 'uncertain', terminated: false } : { mode: 'cancelled', terminated: true });
      expect(callsOf(exec).filter(isRun)).toHaveLength(stage === 'run' ? 1 : 0);
      if (stage === 'run') expect(callsOf(exec).some(isCleanup)).toBe(false);
    } finally { release?.(); vi.useRealTimers(); }
  });

  it.each([['vitest', 'run'], ['npx', 'vitest', 'run']])('normalizes the expanded entry point %j for the wrapper', async (...prefix) => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: [...prefix, 'a.test.mjs'] })).toEqual({ mode: 'remote', code: 0 });
    expect(JSON.parse(callsOf(f.exec).find(isRun).input).argv).toEqual(argv);
  });

  it.each(['throw', 'SSH 255', 'missing receipt', 'supervisor failure'])('refuses both callers after dispatch with %s', async outcome => {
    const f = fixture({ runCode: outcome === 'SSH 255' ? 255 : 0,
      ...(outcome === 'missing receipt' ? { receipt: '' } : {}),
      ...(outcome === 'supervisor failure' ? { receipt: (_n, value) => JSON.stringify({ ...value, phase: 'supervisor' }) } : {}),
    });
    const exec = vi.fn(async call => {
      if (isRun(call) && outcome === 'throw') throw new Error('connection lost');
      return f.exec(call);
    });
    expect(await runWithRemoteFallback({ ...f, exec, log: vi.fn() })).toBe(124);
    expect(f.local).not.toHaveBeenCalled();
    expect(await runWithRemoteDecision({ argv, cwd,
      policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
      remoteExec: options => runRemote({ ...f, ...options, exec }), log: vi.fn(),
    })).toEqual({ handled: true, exitCode: 124 });
  });
  it.each([[], ['--','--files=scripts/readiness/remote-exec.mjs']].map(args => [args]))('runs Git-dependent standards locally without preparing a snapshot: %j', async (args) => {
    const f = fixture();
    f.argv = ['npm','run','check:standards',...args];
    // No vitest.shared.ts: the Git requirement alone must trigger fallback.
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'requires-git-worktree'});
    const log = vi.fn();
    expect(await runWithRemoteFallback({...f,log})).toBe(7);
    expect(f.local).toHaveBeenCalledTimes(1);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(f.exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('requires-git-worktree'));
  });
  it.each(['0\n', '97\n', `${'f'.repeat(32)}:0\n`])('refuses local rerun for an unbound receipt %j', async (receipt) => {
    const f = fixture({ runCode: receipt === '97\n' ? 97 : 0, receipt });
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(124);
    expect(f.local).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
  });

  it('rejects a prior valid receipt when the caller reuses the run id', async () => {
    let priorReceipt;
    const f = fixture({ receipt: (_nonce, value) => priorReceipt ??= JSON.stringify(value) });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code: 0 });
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(124);
    const nonces = callsOf(f.exec).filter(isRun).map((call) => nonceOf(call.input));
    expect(nonces[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(nonces[1]).not.toBe(nonces[0]);
    expect(f.local).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
  });

  it('falls back before transfer or execution when stale receipt removal fails', async () => {
    const f = fixture({ prepareCode: 1 });
    expect(await runWithRemoteFallback({ ...f, log: vi.fn() })).toBe(7);
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
    expect(callsOf(f.exec).some(isRun)).toBe(false);
  });

  it('falls back before copying when literal inventory framing exceeds the byte limit', async () => {
    const f = fixture();
    // Prefix and NUL are part of the 4 MiB transport budget.
    f.listFiles.mockResolvedValue(['a'.repeat(4 * 1024 * 1024 - 2)]);
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('copy-failed'));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });

  it.each(['test:unit', 'check:standards'])('falls back before transport for %s when the snapshot requires the unsynchronized sibling', async (command) => {
    const f = fixture();
    f.argv = ['npm', 'run', command, '--', 'blocks/__tests__/unit/resource-loader/ResourceLoader.test.ts'];
    f.listFiles.mockResolvedValue(['package-lock.json', 'vitest.shared.ts']);
    writeFileSync(join(cwd, 'vitest.shared.ts'), "export const fuiPlugsRoot = resolve(repoRoot, '../frontierui/plugs');\n");
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(command === 'check:standards' ? 'requires-git-worktree' : 'unsupported-sibling-dependency'));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it('falls back without exec for a command outside the allowlist', async () => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: ['npm', 'run', 'build'] }))
      .toEqual({ mode: 'fallback', reason: 'command-not-allowed' });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.local).not.toHaveBeenCalled();
  });
  it('falls back when the forge probe fails, without copying or running', async () => {
    const f = fixture({ probeCode: 255 });
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'forge-unreachable' });
    expect(callsOf(f.exec)).toContainEqual(expect.objectContaining({ file: 'ssh', args: ['forge', 'true'] }));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it('reports copy-failed and attempts cleanup after an unsuccessful rsync', async () => {
    const f = fixture({ copyCode: 23 });
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'copy-failed' });
    expect(callsOf(f.exec).some(isRun)).toBe(false);
    expect(callsOf(f.exec).filter(isCleanup)).toHaveLength(1);
    expect(JSON.parse(callsOf(f.exec).find(isCleanup).input).run).toMatch(/^r-/);
    expectNoSecrets(f.exec);
  });
  it.each([0, 3, 97, 254])('returns confirmed remote exit code %s and cleans up after reading the receipt', async (code) => {
    const f = fixture({ runCode: code });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code });
    const calls = callsOf(f.exec);
    const run = calls.find(isRun);
    expect(run).toMatchObject({ file: 'ssh', inherit: true, input: expect.any(String) });
    expect(calls.filter(isReceipt)).toHaveLength(1);
    expect(calls.findIndex(isReceipt)).toBeGreaterThan(calls.findIndex(isRun));
    expect(calls.filter(isCleanup)).toHaveLength(1);
    expect(JSON.parse(calls.find(isCleanup).input).run).toMatch(/^r-/);
    expect(f.local).not.toHaveBeenCalled();
    expectNoSecrets(f.exec);
  });
  it.each([
    { runCode: 0, receipt: '' }, { runCode: 0, receipt: 'not-a-number\n' },
    { runCode: 0, receipt: '0oops\n' }, { runCode: 0, receipt: '0\n3\n' },
    { runCode: 0, receipt: (nonce) => `${nonce}:3\n` }, { runCode: 3, receipt: (nonce) => `${nonce}:0\n` },
    { runCode: 0, receiptCode: 1 },
    { runCode: 255 }, { runCode: 255, receipt: (nonce) => `${nonce}:0\n` },
    ...['0\n\n', '0\r\n', '0\u2028', '00\n', '-1\n', '256\n', '0\ntrailing', '0'.repeat(100)].map((suffix) => ({
      runCode: 0, receipt: (nonce) => `${nonce}:${suffix}`,
    })),
  ])('fails closed with ambiguous-result for %j', async (scenario) => {
    const f = fixture(scenario);
    expect(await runRemote(f)).toEqual({ mode: 'uncertain', reason: 'ambiguous-result', terminated: false });
    expect(callsOf(f.exec).some(isCleanup)).toBe(scenario.runCode !== 255);
    expectNoSecrets(f.exec);
  });
  it('uses the injected file list as rsync stdin, excludes node_modules, and selects the restricted rsync user', async () => {
    const f = fixture();
    f.listFiles.mockResolvedValue(['package-lock.json', 'src/a file.mjs', 'node_modules/secret.js', 'src/node_modules/nested.js', '.exit-code', 'src/.exit-code', '.exit-code/forged']);
    await runRemote({ ...f, host: 'custom-forge' });
    expect(f.listFiles).toHaveBeenCalledWith(cwd);
    const calls = callsOf(f.exec);
    expect(calls).toContainEqual(expect.objectContaining({ file: 'ssh', args: ['custom-forge', 'true'] }));
    const copy = calls.find((call) => call.file === 'rsync');
    expect(copy.args.join(' ')).toMatch(/--files-from(?:=|\s)-/);
    expect(copy.args).toContain('--from0');
    expect(copy.args).toContain('--exclude=.exit-code');
    expect(calls.findIndex(isPrepare)).toBeLessThan(calls.indexOf(copy));
    expect(sshText(calls.find(isPrepare))).toBe('custom-forge sudo -n -u ops /usr/local/libexec/forge-exec-run prepare');
    expect(copy.input.split('\0')).toEqual(['./package-lock.json', './src/a file.mjs', '']);
    expect(copy.args.join(' ')).toMatch(/--rsync-path(?:=|\s)sudo -u forge-exec rsync/);
    expect(copy.args.join(' ')).toMatch(/custom-forge:\/srv\/forge-exec\/r-[a-f0-9]+\/work\//);
    expect(copy.input).toContain('package-lock.json');
    expect(copy.input).toContain('src/a file.mjs');
    expect(copy.input).not.toContain('node_modules');
    expectNoSecrets(f.exec);
  });
  it('defaults to git ls-files -co --exclude-standard when listFiles is omitted', async () => {
    const { listFiles, ...f } = fixture();
    await runRemote(f);
    expect(callsOf(f.exec)).toContainEqual(expect.objectContaining({
      file: 'git', args: expect.arrayContaining(['ls-files', '-co', '--exclude-standard']),
    }));
    expect(callsOf(f.exec).find((call) => call.file === 'rsync').input).toContain('a.test.mjs');
  });
});

describe('runWithRemoteFallback', () => {
  it.each([
    ['npm', 'run', 'build'],
    ['npm', 'run', 'test:unit', '--script-shell=/usr/bin/true'],
    ['npm', 'run', 'check:standards', '--ignore-scripts'],
  ])('refuses disallowed argv without remote or local execution: %j', async (...command) => {
    const f = { ...fixture(), argv: command };
    await expect(runWithRemoteFallback(f)).rejects.toThrow('command-not-allowed');
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.local).not.toHaveBeenCalled();
  });
  it.each([
    ['forge-unreachable', {}, { probeCode: 255 }],
    ['copy-failed', {}, { copyCode: 23 }],
  ])('logs %s and returns the local code on fallback', async (reason, overrides, scenario) => {
    const f = { ...fixture(scenario), ...overrides };
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(f.local).toHaveBeenCalledTimes(1);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(log.mock.calls.some((args) => args.some((message) => typeof message === 'string' && message.includes(reason)))).toBe(true);
    expectNoSecrets(f.exec);
  });
  it.each([0, 3])('returns remote code %s without running locally', async (code) => {
    const f = fixture({ runCode: code });
    expect(await runWithRemoteFallback({ ...f, log: vi.fn() })).toBe(code);
    expect(f.local).not.toHaveBeenCalled();
  });
});

describe('parseArgs', () => {
  it('parses host/run-id options and preserves command args after the separator', () => {
    expect(parseArgs(['--host=x', '--run-id=abcdef-1', '--', ...argv]))
      .toEqual({ host: 'x', runId: 'abcdef-1', argv });
  });
});

describe('forge-setup.sh', () => {
  function directorySetup() {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/);
    expect(body, 'setup must use descriptor-anchored directory operations').not.toBeNull();
    return body[1];
  }

  it.each(['forge-exec', 'forge-exec/.cache'])('rejects a symlink at %s without changing its target', (path) => {
    const srv = join(cwd, 'srv');
    const target = join(cwd, 'target');
    mkdirSync(srv);
    mkdirSync(target, { mode: 0o755 });
    if (path.includes('/')) mkdirSync(join(srv, 'forge-exec'));
    symlinkSync(target, join(srv, path));
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/);
    // The legacy branch lets the real symlink regression discriminate the old
    // shell setup too, rather than failing only because its implementation differs.
    const script = body
      ? `python3 - <<'DIRECTORIES'\n${directoryHarness(body[1], srv)}\nDIRECTORIES`
      : `set -euo pipefail\nchown() { :; }\n${setup.slice(setup.indexOf('\nfi\n') + 4, setup.indexOf('# ops')).replaceAll('/srv/forge-exec', join(srv, 'forge-exec'))}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    expect(existsSync(join(target, '.cache'))).toBe(false);
  });

  // Exercise the real no-follow opens and modes without requiring root or a system account.
  function directoryHarness(body, srv) {
    return `import os, grp, pwd, types
original_fstat = os.fstat
owners = {}
os.fstat = lambda fd: types.SimpleNamespace(st_uid=0, st_mode=original_fstat(fd).st_mode)
os.fchown = lambda fd, uid, gid: owners.__setitem__(original_fstat(fd).st_ino, (uid, gid))
grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=os.getgid())
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=0, pw_gid=os.getgid())
${body.replaceAll('"/srv"', JSON.stringify(srv))}
assert owners[os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_ino] == (0, os.getgid())
assert owners[os.stat(${JSON.stringify(join(srv, 'forge-exec/.cache'))}).st_ino] == (0, os.getgid())`;
  }

  it('keeps parent entries protected on rerun and freezes the parent before opening the cache', () => {
    const body = directorySetup();
    const srv = join(cwd, 'srv');
    mkdirSync(srv);
    const harness = directoryHarness(body, srv).replace('original_fstat = os.fstat', `original_open = os.open
def checked_open(path, flags, *args, **kwargs):
    if path == '.cache':
        assert flags & os.O_NOFOLLOW
        assert os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_mode & 0o7777 == 0o700
        assert owners.get(os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_ino) == (0, os.getgid())
    return original_open(path, flags, *args, **kwargs)
os.open = checked_open
original_fstat = os.fstat`);
    for (const attempt of [1, 2]) {
      const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
      expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(0);
      expect(statSync(join(srv, 'forge-exec')).mode & 0o7777).toBe(0o755);
      expect(statSync(join(srv, 'forge-exec/.cache')).mode & 0o7777).toBe(0o700);
    }
  });

  it('rejects a cache swapped to a symlink immediately before opening it', () => {
    const srv = join(cwd, 'srv');
    const target = join(cwd, 'target');
    mkdirSync(srv);
    mkdirSync(target, { mode: 0o755 });
    const harness = directoryHarness(directorySetup(), srv).replace('original_fstat = os.fstat', `original_open = os.open
def swapping_open(path, flags, *args, **kwargs):
    if path == '.cache':
        os.rename('.cache', '.cache.saved', src_dir_fd=kwargs['dir_fd'], dst_dir_fd=kwargs['dir_fd'])
        os.symlink(${JSON.stringify(target)}, '.cache', dir_fd=kwargs['dir_fd'])
    return original_open(path, flags, *args, **kwargs)
os.open = swapping_open
original_fstat = os.fstat`);
    const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    // A failed migration leaves the root closed, so an operator can repair it.
    expect(statSync(join(srv, 'forge-exec')).mode & 0o7777).toBe(0o700);
  });

  it.each([0o775, 0o757])('refuses a writable trusted parent (mode %s)', (mode) => {
    const srv = join(cwd, 'srv');
    mkdirSync(srv, { mode });
    // mkdir respects umask, so explicitly expose the untrusted write bits.
    // The harness changes only its scratch parent before executing setup.
    const forced = directoryHarness(directorySetup(), srv).replace('original_fstat = os.fstat', `os.chmod(${JSON.stringify(srv)}, ${mode})\noriginal_fstat = os.fstat`);
    const unsafe = spawnSync('python3', ['-c', forced], { encoding: 'utf8' });
    expect(unsafe.status, unsafe.stderr).not.toBe(0);
    expect(unsafe.stderr).toContain('/srv must be root-owned');
    expect(existsSync(join(srv, 'forge-exec'))).toBe(false);
  });

  it('creates the restricted user, run root and cache with strict bash and idempotency guards', () => {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    expect(setup).toContain('set -euo pipefail');
    expect(setup).toMatch(/\buseradd\b[^\n]*\bforge-exec\b/);
    expect(setup).toContain('/srv/forge-exec');
    expect(setup).toContain('.cache');
    expect(setup).toMatch(/\bid\s+(?:-[a-zA-Z]+\s+)*forge-exec\b/);
    expect(setup).toContain('os.mkdir("forge-exec", 0o700, dir_fd=with_parent)');
    expect(setup).toContain('os.mkdir(".cache", 0o700, dir_fd=root)');
  });
});

describe('receipt field binding', () => {
  it.each(['v','nonce','run','inputDigest','argvDigest','lock','phase','code'])('rejects mismatched %s', async field => {
    const f = fixture({receipt: (_nonce,value) => JSON.stringify({...value,[field]:field === 'v' ? 2 : field === 'code' ? 1 : 'wrong'})});
    expect(await runRemote(f)).toEqual({mode:'uncertain',reason:'ambiguous-result',terminated:false});
  });
  it('reports confirmed install failure as not-started after cleanup', async () => {
    expect(await runRemote(fixture({runCode:97,receipt:(_n,v)=>JSON.stringify({...v,phase:'install'})})))
      .toEqual({mode:'not-started',reason:'install-failed',code:97,terminated:true});
  });
});
