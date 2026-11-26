// @vitest-environment node
// HOST-GATE-STALE-CHECKOUT.S1.1: executable contract for the S1.2 implementation.
// The reader seam follows adoption-matrix: injected external IO, real main guard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as guard from '../../lib/daemon-host-guard.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { ghThrottleLockRoot, ghThrottleLogPath, runGhSync } from '../../lib/gh-throttle.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';

// Import at the action boundary so the tier-1 test itself is red when S1.2 is absent,
// rather than failing collection before Vitest can name the acceptance test.
let dryrun;
async function loadDryrun() {
  dryrun ??= await import('../daemon-host-gate-dryrun.mjs');
  return dryrun;
}

vi.mock('../../lib/daemon-host-guard.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, getThisHost: vi.fn(actual.getThisHost), resolveHostRole: vi.fn(actual.resolveHostRole) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(() => { throw new Error('unconfigured native command'); }) };
});

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-26T21:00:00Z');
const NONCE = '33333333-3333-4333-8333-333333333333';
const CALLER = `daemon-host-gate-dryrun:${NONCE}`;
const START = 'Thu Nov 26 15:00:00 2026';
const dirs = [];
const b64 = text => Buffer.from(text).toString('base64');
const failure = (status, stderr = '', extra = {}) => Object.assign(new Error(stderr || 'fixture failure'), {
  status, stdout: '', stderr, ...extra,
});
const gate = (state, extra = {}) => ({ label: `com.we.${state}`, file: `${state}.plist`, state, ...extra });
const finish = report => dryrun.finishDaemonHostGateDryrun({ run: { verdict: report }, code: 0,
  lines: [JSON.stringify(report)], json: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Snapshot only the throwaway fixture, including dotfiles, modes and symlinks.
// This is not a scan of repository source files.
function snapshot(root) {
  const rows = [];
  const walk = path => {
    const stat = fs.lstatSync(path);
    const name = relative(root, path);
    const content = stat.isSymbolicLink() ? fs.readlinkSync(path) : stat.isFile()
      ? createHash('sha256').update(fs.readFileSync(path)).digest('hex') : null;
    rows.push([name, stat.mode, content]);
    if (stat.isDirectory()) for (const child of fs.readdirSync(path).sort()) walk(join(path, child));
  };
  walk(root);
  return rows;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'host-gate-dryrun-'));
  dirs.push(root);
  const home = join(root, 'home'), cwd = join(root, 'repo'), bin = join(root, 'bin');
  const agents = join(home, 'Library', 'LaunchAgents');
  for (const path of [agents, join(home, '.claude'), join(cwd, '.git'), bin]) fs.mkdirSync(path, { recursive: true });
  const hostPath = join(home, '.claude', 'host-id');
  if (options.identity !== 'absent') fs.writeFileSync(hostPath, `${options.identity ?? SELF}\n`, { mode: 0o600 });
  // The real main guard does its candidate-aware lookup, but its OS boundary is
  // injected too. No reader fixture starts a process or falls back to host PATH.
  execFileSync.mockImplementation((command, argv) => {
    if (command !== 'scutil' || JSON.stringify(argv) !== JSON.stringify(['--get', 'HostName'])) {
      throw new Error(`unconfigured native command: ${command}`);
    }
    if (options.scutilExit) throw failure(options.scutilExit);
    return options.hostName ?? 'studio';
  });
  const env = { HOME: home, PATH: bin, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'gh') };
  const ledger = ghThrottleLogPath(ghThrottleLockRoot(undefined, env));
  fs.mkdirSync(env.WE_GH_THROTTLE_LOCK_ROOT, { recursive: true });
  fs.writeFileSync(ledger, '');
  const gates = options.gates ?? [gate('has-children'), gate('no-children')];
  const plists = new Map(gates.map((row, i) => {
    const value = { ...row, pid: row.pid ?? 4100 + i,
      args: row.args ?? ['/usr/bin/node', '/fixture/daemon-host-gate.mjs', '--', 'daemon'] };
    fs.writeFileSync(join(agents, row.file), 'fixture plist; read only through injected plutil');
    return [row.file, value];
  }));
  const psCalls = new Map();
  let clock = NOW;
  const body = { type: 'file', encoding: 'base64', content: b64(options.record ?? 'studio\n'), sha: SHA,
    ...options.body };
  const exec = vi.fn((command, argv, settings) => {
    expect(settings.timeout).toBeGreaterThan(0);
    expect(settings.maxBuffer).toBeGreaterThan(0);
    if (options.command) {
      const override = options.command(command, argv, settings);
      if (override !== undefined) return override;
    }
    if (command === 'git') {
      expect(argv).toContain('--no-optional-locks');
      if (argv.includes('rev-parse')) return `${SHA}\n`;
      if (argv.includes('status')) return options.dirty ? ' M example.mjs\n' : '';
      throw new Error(`unexpected git command ${JSON.stringify(argv)}`);
    }
    if (command === 'gh') {
      expect(argv).toEqual(['api', '--hostname', 'github.com',
        `repos/${CONSTELLATION_REPOS.we.slug}/contents/host?ref=daemon-host-owner`]);
      if (options.ghError) throw options.ghError;
      options.duringGh?.({ ledger, env, advance: ms => { clock += ms; } });
      return options.ghOutput ?? JSON.stringify(body);
    }
    if (command === 'plutil') {
      const row = plists.get(basename(argv.at(-1)));
      if (!row) throw new Error('unexpected plist');
      const key = argv[argv.indexOf('-extract') + 1];
      if (key === 'ProgramArguments') return JSON.stringify(row.args);
      if (key === 'Label') return row.label;
      throw new Error('unexpected plist key');
    }
    if (command === 'launchctl') {
      const row = [...plists.values()].find(value => argv.at(-1).endsWith(`/${value.label}`));
      if (!row) throw new Error('unexpected label');
      if (row.state === 'not-loaded') throw failure(113);
      return row.state === 'loaded-idle' ? 'state = waiting\n' : `state = running\n\tpid = ${row.pid}\n`;
    }
    if (command === 'ps') {
      expect(argv.slice(0, 3)).toEqual(['-o', 'pid=,ppid=,lstart=', '-p']);
      const row = [...plists.values()].find(value => String(value.pid) === String(argv.at(-1)));
      if (!row) throw new Error('unexpected pid');
      const n = (psCalls.get(row.pid) ?? 0) + 1;
      psCalls.set(row.pid, n);
      if (n === 2) clock += options.childDelay ?? 0;
      if (options.ps) return options.ps(n, row);
      return `${row.pid} 1 ${START}\n`;
    }
    if (command === 'pgrep') {
      expect(argv[0]).toBe('-P');
      const row = [...plists.values()].find(value => String(value.pid) === String(argv[1]));
      if (!row) throw new Error('unexpected parent');
      if (row.state === 'no-children') throw failure(1);
      return options.children ?? '5100\n';
    }
    throw new Error(`unexpected external command: ${command}`);
  });
  // Only the pinned side is a fixture oracle; main predictions run the actual guard.
  const pinned = {
    getThisHost: vi.fn(() => options.pinnedHost ?? 'studio'),
    readOwnerRemote: vi.fn(async ({ ghApi }) => {
      const ref = await ghApi(`repos/${CONSTELLATION_REPOS.we.slug}/git/ref/heads/daemon-host-owner`);
      const file = await ghApi(`repos/${CONSTELLATION_REPOS.we.slug}/contents/host?ref=daemon-host-owner`);
      expect(ref.body.object.sha).toBe(SHA);
      const owner = Buffer.from(file.body.content, 'base64').toString('utf8').trim();
      return !owner ? { status: 'unset' } : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)
        ? { status: 'ok', owner } : { status: 'error', error: 'invalid owner host' };
    }),
    decideHostRole: vi.fn(({ thisHost, owner, ownerReadAt, now, atStart, cache }) => {
      expect(atStart).toBe(true);
      expect(cache).toBeUndefined();
      expect(ownerReadAt).toBe(now);
      return owner === thisHost ? { role: 'active', reason: 'fresh-owner-is-this-host' }
        : { role: 'standby', reason: owner === '' ? 'owner-unset'
          : owner == null ? 'start-requires-fresh-read' : 'owner-is-other-host' };
    }),
  };
  const loadPinned = vi.fn(async () => {
    if (options.pinnedError) throw options.pinnedError;
    return pinned;
  });
  const filesystem = { ...fs, ...options.filesystem };
  const deps = { home, cwd, env, filesystem, exec, loadPinned, now: () => clock, nonce: () => NONCE };
  return { root, home, cwd, agents, hostPath, ledger, exec, pinned, loadPinned, deps,
    read: async (input = {}) => (await loadDryrun()).createDaemonHostGateDryrunReader(deps)(input) };
}

function expectIncomplete(report, kind, label = null) {
  expect(report.complete).toBe(false);
  expect(report.errors).toContainEqual({ kind, label, detail: expect.any(String) });
  expect(report.errors.find(error => error.kind === kind).detail.length).toBeGreaterThan(0);
  expect(finish(report).code).toBe(2);
}

// Exercise the real runner with preloaded IO, including the named builtin imports
// used by its guards. Only the native timeout probe starts a fixture child.
// Observations live outside the byte-for-byte snapshot; unexpected IO is fatal.
function productionFixture(options = {}) {
  const h = fixture();
  const observer = fs.mkdtempSync(join(tmpdir(), 'host-gate-dryrun-observer-'));
  dirs.push(observer);
  const callsPath = join(observer, 'calls.jsonl');
  fs.writeFileSync(callsPath, '');
  const configPath = join(h.root, 'tools.json');
  fs.writeFileSync(configPath, JSON.stringify({ root: h.root, home: h.home, cwd: h.cwd, callsPath,
    sourceRoot: fileURLToPath(new URL('../../../', import.meta.url)), now: NOW,
    sha: SHA, body: { type: 'file', encoding: 'base64', content: b64('studio\n'), sha: SHA }, ...options }));
  const preload = join(h.root, 'io.cjs');
  const blockedGh = join(h.root, 'blocked-gh.cjs');
  fs.writeFileSync(blockedGh, keepAliveScript({ maxLifetimeMs: 30000 }));
  fs.writeFileSync(preload, `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
const native = { ...fs }, nativeExec = cp.execFileSync;
const observerFd = native.openSync(config.callsPath, 'a');
const record = row => native.writeSync(observerFd, JSON.stringify(row) + '\\n');
process.on('exit', () => native.closeSync(observerFd));
const inside = (root, target) => target === path.resolve(root) || target.startsWith(path.resolve(root) + path.sep);
os.homedir = () => config.home;
os.userInfo = () => ({ homedir: config.home, username: 'fixture', shell: '/fixture/shell',
  uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20 });
os.hostname = () => 'fixture-host';
// Permit the fixture and versioned module/config reads. Live checkout metadata,
// sibling checkouts, host HOME and every write outside the fixture are refused.
const wrapFs = (name, implementation) => (...args) => {
    const writing = /^(write|append|mkdir|rm|unlink|chmod|rename|link|symlink)/.test(name)
      || name === 'openSync' && (typeof args[1] === 'string' ? /[wa+]/.test(args[1])
        : Boolean(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)));
    const targets = /^(rename|link|symlink)/.test(name) ? args.slice(0, 2) : args.slice(0, 1);
    for (const value of targets) {
      if (typeof value === 'number') continue;
      const target = path.resolve(value instanceof URL ? require('node:url').fileURLToPath(value) : String(value));
      // judge-spawn discovers an optional Node-sibling CLI during runner import.
      // Model its absence explicitly; never inspect the installed host toolchain.
      if (name === 'existsSync' && target === path.join(path.dirname(process.execPath), 'claude')) return false;
      if (inside(config.root, target)) continue;
      // TypeScript flips the case of its own module path during import. Model a
      // case-sensitive filesystem consistently on macOS and Linux.
      if (!writing && !inside(config.sourceRoot, target)
        && inside(config.sourceRoot.toLowerCase(), target.toLowerCase())) {
        throw Object.assign(new Error('fixture-case-sensitive: ' + target), {code: 'ENOENT'});
      }
      const relative = path.relative(config.sourceRoot, target);
      if (!writing && inside(config.sourceRoot, target)
        && !relative.split(path.sep).some(part => ['.git', '.operations', '.claude'].includes(part))) continue;
      record({ command: 'fixture-fs-refused', name, target });
      throw new Error('fixture-fs-refused: ' + name + ' ' + target);
    }
    return implementation(...args);
};
for (const name of ['accessSync', 'existsSync', 'lstatSync', 'statSync', 'realpathSync',
  'readFileSync', 'readdirSync', 'readlinkSync', 'openSync', 'writeFileSync', 'appendFileSync',
  'mkdirSync', 'rmSync', 'unlinkSync', 'chmodSync', 'renameSync', 'linkSync', 'symlinkSync']) {
  fs[name] = wrapFs(name, native[name]);
}
fs.realpathSync.native = wrapFs('realpathSync.native', native.realpathSync.native);
Date.now = () => config.now;
cp.execFileSync = (command, argv, settings = {}) => {
const callEnv = settings.env ?? process.env;
record({command, argv, timeout: settings.timeout, env: {
  GH_CALLER: callEnv.GH_CALLER, GH_HOST: callEnv.GH_HOST,
  WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: callEnv.WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS,
  WE_GH_JSON_RETRIES: callEnv.WE_GH_JSON_RETRIES,
}});
let output = '';
function out(text) { output = String(text); }
function refuse(reason, status = 2) { throw Object.assign(new Error(reason), {status, stdout: '', stderr: reason}); }
if (command === 'git') {
  if (config.gitFailure) refuse('fixture git read failed', 128);
  if (argv.includes('fetch')) refuse('unexpected fetch: diagnostic must be zeroWrites');
  if (argv.includes('--show-toplevel')) out(config.cwd);
  else if (argv.includes('--absolute-git-dir')) out(path.join(config.cwd, '.git'));
  else if (argv.includes('rev-parse')) out(config.sha);
  else if (argv.includes('remote') && argv.includes('get-url')) out('fixture-origin');
  else if (argv.includes('rev-list')) out(config.behind ?? '0');
  else if (argv.includes('status')) out('');
  else refuse('unexpected git argv: ' + JSON.stringify(argv));
} else if (command === 'gh') {
  const expected = ['api', '--hostname', 'github.com', ${JSON.stringify(`repos/${CONSTELLATION_REPOS.we.slug}/contents/host?ref=daemon-host-owner`)}];
  if (JSON.stringify(argv) !== JSON.stringify(expected)) refuse('unexpected gh argv');
  if (config.ghStatus) refuse('HTTP ' + config.ghStatus, 1);
  if (config.ghExecFailure) refuse('fixture gh execution failed', 127);
  if (config.ghTimeout) {
    return nativeExec(process.execPath, [${JSON.stringify(blockedGh)}], settings);
  }
  out(config.ghOutput ?? JSON.stringify(config.body));
} else if (command === 'scutil') out('studio');
else if (command === 'plutil') {
  const key = argv[argv.indexOf('-extract') + 1];
  const plist = JSON.parse(fs.readFileSync(argv.at(-1), 'utf8'));
  if (key === 'Label') out(plist.Label);
  else if (key === 'ProgramArguments') out(JSON.stringify(plist.ProgramArguments));
  else refuse('unexpected plist key');
} else if (command === 'launchctl') out('state = running\\npid = 4100\\n');
else if (command === 'ps') out('4100 1 ${START}\\n');
else if (command === 'pgrep') out('5100\\n');
else refuse('unexpected external tool: ' + command);
return output;
};
for (const name of ['execSync', 'exec', 'execFile', 'spawn', 'spawnSync', 'fork']) {
  cp[name] = () => { record({command: 'fixture-process-refused', name}); throw new Error('unexpected process API: ' + name); };
}
syncBuiltinESMExports();
`);
  for (const file of fs.readdirSync(h.agents)) fs.unlinkSync(join(h.agents, file));
  fs.writeFileSync(join(h.agents, 'different-name.plist'), JSON.stringify({ Label: 'com.we.fixture',
    ProgramArguments: ['node', '/fixture/daemon-host-gate.mjs', '--', 'daemon'] }));
  const pinnedDir = join(h.home, 'workspace', '.daemon-host-gate', 'scripts', 'lib');
  fs.mkdirSync(pinnedDir, { recursive: true });
  fs.writeFileSync(join(pinnedDir, 'daemon-host-guard.mjs'), `
import { execFileSync } from 'node:child_process';
export function getThisHost() { return execFileSync('scutil', ['--get', 'HostName'], {
  encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 }).trim(); }
export async function readOwnerRemote({ ghApi }) {
  const result = await ghApi(${JSON.stringify(`repos/${CONSTELLATION_REPOS.we.slug}/contents/host?ref=daemon-host-owner`)});
  const owner = Buffer.from(result.body.content, 'base64').toString('utf8').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) ? {status: 'ok', owner} : {status: 'error'};
}
export function decideHostRole({ thisHost, owner, atStart }) {
  if (!atStart) throw new Error('comparison must be atStart');
  return { role: thisHost === owner ? 'active' : 'standby', reason: thisHost === owner
    ? 'fresh-owner-is-this-host' : owner == null ? 'start-requires-fresh-read' : 'owner-is-other-host' };
}
`);
  for (const folder of ['runs', 'calls', 'coordination']) fs.mkdirSync(join(h.root, folder));
  const env = { ...h.deps.env, TMPDIR: tmpdir(), WE_TELEMETRY: '0',
    DEVELOPER_DIR: join(h.root, 'developer-tools'),
    WE_PLATFORM_PREFERENCES_FILE: join(h.root, 'absent-preferences.json'),
    OPERATION_RUNS_DIR: join(h.root, 'runs'),
    WE_SHARED_RUNS_DIR: join(h.root, 'runs'), OPERATION_CALLS_DIR: join(h.root, 'calls'),
    WE_COORDINATION_ROOT: join(h.root, 'coordination'), WE_DAEMON_MANAGED_CLONE: '',
    WE_OPERATION_ALLOW_STALE: '', LANE_POOL_ROOT: join(h.root, 'unused-pool') };
  const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const execute = argv => {
    const before = snapshot(h.root);
    const result = spawnSync(process.execPath, ['--require', preload, ...argv], {
      cwd: h.cwd, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1048576 });
    expect(result.error).toBeUndefined();
    expect(snapshot(h.root)).toEqual(before);
    expect(calls().filter(row => row.command.startsWith('fixture-'))).toEqual([]);
    return { ...result, calls: calls() };
  };
  const run = (argv = ['--json']) => execute([fileURLToPath(new URL('../run.mjs', import.meta.url)),
    'daemon-host-gate-dryrun', ...argv]);
  const probe = (command, argv) => execute(['-e', `process.stdout.write(require('node:child_process').execFileSync(${JSON.stringify(command)}, ${JSON.stringify(argv)}, {encoding: 'utf8'}))`]);
  const evaluate = source => execute(['-e', source]);
  return { ...h, env, run, probe, evaluate };
}

describe('hermetic fixture boundaries', () => {
  it('production fixture pins every OS home lookup to its throwaway HOME', () => {
    const h = productionFixture();
    const result = h.evaluate(`const os = require('node:os'); process.stdout.write(JSON.stringify([os.homedir(), os.userInfo().homedir]));`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([h.home, h.home]);
  });

  it('production fixture models the TypeScript casing probe as a missing file without inspecting the host filesystem', () => {
    const h = productionFixture();
    const source = fileURLToPath(new URL('../../../node_modules/typescript/lib/typescript.js', import.meta.url));
    const swapped = source.replace(/[a-zA-Z]/g, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    const result = h.evaluate(`try { require('node:fs').statSync(${JSON.stringify(swapped)}); process.exit(2); }
      catch (error) { if (error.code !== 'ENOENT') throw error; process.stdout.write('fixture-case-sensitive'); }`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('fixture-case-sensitive');
  });

  it('reader fixtures inject scutil and reject every unconfigured native command', () => {
    const h = fixture({ hostName: 'fixture-host' });
    expect(execFileSync('scutil', ['--get', 'HostName'], {})).toBe('fixture-host');
    expect(() => execFileSync('pgrep', ['-P', '4100'], {})).toThrow('unconfigured native command');
    expect(h.deps.env.PATH.split(delimiter)).toEqual([join(h.root, 'bin')]);
  });

  it.each([
    ['gh', ['api', '--hostname', 'github.com', `repos/${CONSTELLATION_REPOS.we.slug}/contents/host?ref=daemon-host-owner`], JSON.stringify({ type: 'file', encoding: 'base64', content: b64('studio\n'), sha: SHA })],
    ['pgrep', ['-P', '4100'], '5100\n'],
    ['launchctl', ['print', 'gui/501/com.we.fixture'], 'state = running\npid = 4100\n'],
    ['ps', ['-o', 'pid=,ppid=,lstart=', '-p', '4100'], `4100 1 ${START}\n`],
  ])('production fixture injects %s without host PATH, HOME, cwd or clock dependencies', (command, argv, output) => {
    const h = productionFixture();
    expect(h.env.PATH.split(delimiter)).toEqual([join(h.root, 'bin')]);
    const before = snapshot(h.root);
    const result = h.probe(command, argv);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(output);
    expect(snapshot(h.root)).toEqual(before);
  });
});

describe('HGD-1 main predictions and conservative pinned comparison', () => {
  it('with the live bare studio record and a valid host-id, main code reports revoke-possible for a gate with children and standby for a gate without, and names the fix', async () => {
    const h = fixture();
    const report = await h.read();
    expect(report.complete).toBe(true);
    expect(report.gates.map(row => row.live)).toEqual([
      { main: { decision: 'revoke-possible', reason: 'owner-alias-ambiguous' },
        pinned: { decision: 'owner', reason: 'fresh-owner-is-this-host' } },
      { main: { decision: 'standby', reason: 'owner-alias-ambiguous' },
        pinned: { decision: 'owner', reason: 'fresh-owner-is-this-host' } },
    ]);
    expect(report.fix).toEqual([{ form: 'bindings', bytesB64: b64(`studio\nstudio=${SELF}`),
      requiresProvisioning: false, note: expect.any(String) }]);
    expect(report.gates[0].candidates).toEqual([{ form: 'bindings',
      main: { decision: 'owner', reason: 'fresh-owner-is-this-host' },
      pinned: { decision: 'revoke-possible-conditional-600s', reason: 'start-requires-fresh-read' } }]);
    expect(guard.getThisHost).toHaveBeenCalledWith(expect.objectContaining({ home: h.home, create: false }));
    expect(guard.resolveHostRole).toHaveBeenCalled();
    for (const [input] of guard.resolveHostRole.mock.calls) expect(input).not.toHaveProperty('legacyHost');
    expect(h.exec.mock.calls.filter(([bin]) => bin === 'gh')).toHaveLength(1);
  });

  const states = ['has-children', 'no-children', 'loaded-idle', 'not-loaded'];
  it.each(states)('full state matrix: %s × active/non-active × live, bindings and bare candidates, in both the main and pinned columns', async state => {
    for (const active of [true, false]) {
      const report = await fixture({ gates: [gate(state)], record: active ? SELF : OTHER, pinnedHost: SELF })
        .read({ candidates: 'bindings,uuid' });
      const row = report.gates[0];
      const decision = state === 'not-loaded' ? 'no-gate' : active ? 'owner'
        : state === 'has-children' ? 'revoke-possible' : 'standby';
      expect(row.live.main.decision).toBe(decision);
      expect(row.live.pinned.decision).toBe(state === 'has-children' && !active
        ? 'revoke-possible-next-poll' : decision);
      expect(row.candidates.map(candidate => candidate.form)).toEqual(['bindings', 'uuid']);
      for (const candidate of row.candidates) {
        expect(candidate.main.decision).toBe(state === 'not-loaded' ? 'no-gate' : 'owner');
        expect(candidate.pinned.decision).toBe(state === 'not-loaded' ? 'no-gate' : candidate.form === 'uuid'
          ? 'owner' : state === 'has-children' ? 'revoke-possible-conditional-600s' : 'standby');
      }
    }
  });

  it('precedence intersections: not-loaded is no-gate under unprovisioned host-id, a gh-* error and pinned-import', async () => {
    const report = await fixture({ identity: 'absent', gates: [gate('not-loaded')],
      ghError: failure(1, 'HTTP 403'), pinnedError: new Error('cannot import pinned guard') }).read();
    expect(report.gates[0]).toMatchObject({ state: 'not-loaded', gatePid: null, childCount: null,
      live: { main: { decision: 'no-gate' }, pinned: { decision: 'no-gate' } }, candidates: [] });
    expectIncomplete(report, 'gh-status');
    expectIncomplete(report, 'pinned-import');
  });

  it('vanished/unknown is unknown under an active result', async () => {
    for (const ps of [() => { throw failure(1); }, () => 'malformed']) {
      const report = await fixture({ record: SELF, ps, gates: [gate('has-children')] }).read();
      expect(report.gates[0].live).toMatchObject({ main: { decision: 'unknown' }, pinned: { decision: 'unknown' } });
      for (const candidate of report.gates[0].candidates) {
        expect(candidate.main.decision).toBe('unknown');
        expect(candidate.pinned.decision).toBe('unknown');
      }
    }
  });

  it('pinned comparison uses legacy identity independently of main host-id', async () => {
    const h = fixture({ pinnedHost: 'other-machine' });
    const report = await h.read();
    expect(report.pinnedHost).toBe('other-machine');
    expect(report.gates[0].live.pinned.decision).toBe('revoke-possible-next-poll');
    expect(h.pinned.getThisHost).toHaveBeenCalledTimes(1);
    expect(h.pinned.readOwnerRemote).toHaveBeenCalled();
    expect(h.pinned.decideHostRole).toHaveBeenCalledWith(expect.objectContaining({ thisHost: 'other-machine', atStart: true }));
  });

  it('coincident identity: a pinnedHost equal to host-id makes the bare UUID owner on both', async () => {
    const report = await fixture({ pinnedHost: SELF }).read({ candidates: 'bindings,uuid' });
    expect(report.gates[0].candidates.find(row => row.form === 'uuid')).toMatchObject({
      main: { decision: 'owner' }, pinned: { decision: 'owner' } });
    expect(report.fix.find(row => row.form === 'uuid').bytesB64).toBe(b64(SELF));
  });
});

describe('identity and main record semantics', () => {
  it('unprovisioned host-id: complete:true, no candidates, null fix bytes; a has-children gate is main unknown and pinned per matrix', async () => {
    const h = fixture({ identity: 'absent' });
    const before = snapshot(h.home);
    const report = await h.read();
    expect(report).toMatchObject({ complete: true, errors: [], hostId: { state: 'unprovisioned' } });
    expect(report.gates[0]).toMatchObject({ live: { main: { decision: 'unknown' }, pinned: { decision: 'owner' } }, candidates: [] });
    expect(report.fix[0]).toMatchObject({ bytesB64: null, requiresProvisioning: true });
    expect(snapshot(h.home)).toEqual(before);
    expect(finish(report).code).toBe(0);
  });

  it.each(['symlink', 'directory', 'mode 0644', 'wrong owner', 'invalid UUID'])('%s host-id gives invalid-or-unreadable with no write under HOME', async kind => {
    const h = fixture();
    if (kind === 'symlink') {
      fs.renameSync(h.hostPath, `${h.hostPath}.target`);
      fs.symlinkSync(`${h.hostPath}.target`, h.hostPath);
    } else if (kind === 'directory') {
      fs.unlinkSync(h.hostPath); fs.mkdirSync(h.hostPath);
    } else if (kind === 'mode 0644') fs.chmodSync(h.hostPath, 0o644);
    else if (kind === 'invalid UUID') fs.writeFileSync(h.hostPath, 'invalid');
    else {
      const actual = await vi.importActual('node:fs');
      fs.fstatSync.mockImplementationOnce(fd => Object.assign(actual.fstatSync(fd), { uid: process.getuid() + 1 }));
    }
    const before = snapshot(h.home);
    const report = await h.read();
    expect(report).toMatchObject({ complete: true, hostId: { state: 'invalid-or-unreadable' } });
    expect(report.gates.every(row => row.live.main.decision === 'unknown' && row.candidates.length === 0)).toBe(true);
    expect(report.fix.every(row => row.bytesB64 === null)).toBe(true);
    expect(snapshot(h.home)).toEqual(before);
  });

  it('a non-ENOENT lstat error is host-id-lookup and complete:false', async () => {
    const h = fixture({ filesystem: { lstatSync: path => {
      if (String(path).endsWith('/host-id')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.lstatSync(path);
    } } });
    const report = await h.read();
    expectIncomplete(report, 'host-id-lookup');
    expect(report.hostId.state).toBe('host-id-lookup');
    expect(report.gates[0].live.main.decision).toBe('unknown');
  });

  it.each([
    ['an empty record is owner-unset', '', 'owner-unset'],
    ['malformed record bytes are owner-unreadable', 'bad host!', 'owner-unreadable'],
    ['a foreign UUID is owner-is-other-host', OTHER, 'owner-is-other-host'],
    ['an alias bound to another UUID is owner-is-other-host', `studio\nstudio=${OTHER}`, 'owner-is-other-host'],
  ])('%s', async (_name, record, reason) => {
    const report = await fixture({ record }).read();
    expect(report.gates[0].live.main).toEqual({ decision: 'revoke-possible', reason });
    expect(report.gates[1].live.main).toEqual({ decision: 'standby', reason });
  });

  it.each([
    ['studio', 0, 'owner', 'fresh-owner-is-this-host'],
    ['other-machine', 0, 'revoke-possible', 'owner-is-other-host'],
    ['', 1, 'revoke-possible', 'host-identity-unknown'],
  ])('bindings with HostName %s / scutil exit %s follow main candidate-aware lookup', async (hostName, scutilExit, decision, reason) => {
    const report = await fixture({ hostName, scutilExit, record: `studio\nstudio=${SELF}` }).read();
    expect(report.gates[0].live.main).toEqual({ decision, reason });
  });
});

describe('read-only LaunchAgents inventory', () => {
  it.each([
    [113, '', 'not-loaded', null], [1, '', 'unknown', 'launchctl-failed'],
    [0, 'pid = nope\n', 'unknown', 'launchctl-failed'],
    [0, 'pid = 0\n', 'unknown', 'launchctl-failed'],
    [0, 'pid = 4100\npid = 4200\n', 'unknown', 'launchctl-failed'],
  ])('launchctl exit %s and output %j gives %s', async (status, output, state, kind) => {
    const h = fixture({ gates: [gate('has-children')], command: command => {
      if (command !== 'launchctl') return undefined;
      if (status) throw failure(status);
      return output;
    } });
    const report = await h.read();
    expect(report.gates[0].state).toBe(state);
    if (kind) expectIncomplete(report, kind, 'com.we.has-children');
    expect(h.exec.mock.calls.some(([command]) => command === 'ps')).toBe(false);
  });

  it.each([
    ['P1 vanished', () => { throw failure(1); }, 0, 'vanished', 'gate-vanished'],
    ['P1 error', () => { throw failure(2, 'denied'); }, 0, 'unknown', 'ps-failed'],
    ['P1 malformed', () => 'bad ps output', 0, 'unknown', 'ps-failed'],
    ['P2 vanished', n => { if (n === 2) throw failure(1); return `4100 1 ${START}\n`; }, 0, 'vanished', 'gate-vanished'],
    ['P2 reused PID', n => `4100 1 ${n === 1 ? START : 'Thu Nov 26 15:01:00 2026'}\n`, 0, 'vanished', 'gate-vanished'],
    ['P2 failure', n => { if (n === 2) throw failure(2, 'denied'); return `4100 1 ${START}\n`; }, 0, 'unknown', 'ps-failed'],
    ['late P2 overrides vanished', n => { if (n === 2) throw failure(1); return `4100 1 ${START}\n`; }, 2001, 'unknown', 'ps-failed'],
    ['late P2', () => `4100 1 ${START}\n`, 2001, 'unknown', 'ps-failed'],
  ])('P1/P2 outcomes: %s; ps-failed takes precedence over vanished', async (_name, ps, childDelay, state, kind) => {
    const report = await fixture({ gates: [gate('has-children')], ps, childDelay }).read();
    expect(report.gates[0].state).toBe(state);
    expectIncomplete(report, kind, 'com.we.has-children');
  });

  it.each([['helper-only', '5100\n', 1], ['daemon-plus-helper', '5100\n5200\n', 2], ['daemon-only', '5200\n', 1]])
    ('%s children map to has-children without claiming which child is the daemon', async (_name, children, childCount) => {
      const report = await fixture({ gates: [gate('has-children')], children }).read();
      expect(report.gates[0]).toMatchObject({ state: 'has-children', childCount, gatePid: 4100 });
      expect(report.notPredicted.join(' ')).toMatch(/child.*daemon/);
    });

  it('pgrep exit 2 refuses child evidence and records pgrep-failed', async () => {
    const report = await fixture({ gates: [gate('has-children')], command: command => {
      if (command === 'pgrep') throw failure(2, 'denied');
    } }).read();
    expectIncomplete(report, 'pgrep-failed', 'com.we.has-children');
    expect(report.gates[0]).toMatchObject({ state: 'unknown', childCount: null });
  });

  it('an unreadable LaunchAgents directory is launchagents-unreadable', async () => {
    const report = await fixture({ filesystem: { readdirSync: () => { throw new Error('denied'); } } }).read();
    expectIncomplete(report, 'launchagents-unreadable');
  });

  it.each([
    ['corrupt plist', () => { throw failure(1, 'Property List error'); }, 'plist-unreadable'],
    ['unreadable plist', () => { throw failure(1, 'Permission denied'); }, 'plist-unreadable'],
    ['non-array args', () => '{}', 'plist-unparsable'],
    ['non-string args', () => '[1]', 'plist-unparsable'],
    ['invalid JSON', () => '{', 'plist-unparsable'],
  ])('%s is incomplete, never silently omitted', async (_name, args, kind) => {
    const report = await fixture({ gates: [gate('has-children')], command: (command, argv) => {
      if (command === 'plutil' && argv.includes('ProgramArguments')) return args();
    } }).read();
    expect(report.complete).toBe(false);
    expect(report.errors.map(error => error.kind)).toContain(kind);
    expect(finish(report).code).toBe(2);
  });

  it('a gate plist with no Label is plist-unparsable', async () => {
    const report = await fixture({ gates: [gate('has-children')], command: (command, argv) => {
      if (command === 'plutil' && argv.includes('Label')) throw failure(1,
        'No value at that key path or invalid key path: Label\n');
    } }).read();
    expect(report.errors.map(error => error.kind)).toContain('plist-unparsable');
    expect(finish(report).code).toBe(2);
  });

  it('discovery matches the basename exactly: daemon-host-gateXmjs and daemon-host-gate.mjs.bak are not gates', async () => {
    const report = await fixture({ gates: [gate('no-children', { args: ['daemon-host-gateXmjs'] }),
      gate('loaded-idle', { args: ['/fixture/daemon-host-gate.mjs.bak'] })] }).read();
    expect(report).toMatchObject({ complete: true, gates: [] });
  });

  it.each([true, false])('only the confirmed missing-key diagnostic means not-a-gate (exact=%s)', async exact => {
    const report = await fixture({ gates: [gate('has-children')], command: (command, argv) => {
      if (command === 'plutil' && argv.includes('ProgramArguments')) throw failure(1, exact
        ? 'No value at that key path or invalid key path: ProgramArguments\n' : 'No such key: ProgramArguments\n');
    } }).read();
    expect(report.complete).toBe(exact);
    if (exact) expect(report.gates).toEqual([]);
    else expect(report.errors.map(error => error.kind)).toContain('plist-unreadable');
  });

  it('a binary plist is read, filename/Label mismatch reports labelFile, and an excluded prefix is omitted', async () => {
    const h = fixture({ gates: [gate('loaded-idle', { label: 'com.plateau.real', file: 'different.plist' }),
      gate('no-children', { label: 'org.other.gate' })] });
    fs.writeFileSync(join(h.agents, 'different.plist'), Buffer.from('bplist00\0\xff', 'binary'));
    const report = await h.read();
    expect(report.gates).toEqual([expect.objectContaining({ label: 'com.plateau.real',
      labelFile: 'different.plist', state: 'loaded-idle', gatePid: null, childCount: null })]);
    expect(h.exec.mock.calls.filter(([command]) => command === 'plutil')).toHaveLength(4);
  });

  it('a duplicate Label makes inventory incomplete', async () => {
    const report = await fixture({ gates: [gate('loaded-idle', { label: 'com.we.same', file: 'a.plist' }),
      gate('loaded-idle', { label: 'com.we.same', file: 'b.plist' })] }).read();
    expectIncomplete(report, 'duplicate-label', 'com.we.same');
  });
});

describe('raw gh evidence and completeness', () => {
  it.each([
    ['gh-status', { ghError: failure(1, 'HTTP 403 denied') }, 'threw'],
    ['gh-body', { ghOutput: 'not JSON' }, 'returned'],
    ['gh-timeout', { ghError: failure(null, '', { code: 'ETIMEDOUT' }) }, 'threw'],
    ['gh-timeout', { ghError: failure(null, '', { signal: 'SIGKILL' }) }, 'threw'],
    ['gh-exec', { ghError: failure(null, 'not executable', { code: 'ENOENT' }) }, 'threw'],
  ])('recorder preserves raw execution evidence for %s (%j)', async (kind, options, rawKind) => {
    const report = await fixture(options).read();
    expectIncomplete(report, kind);
    expect(report.gh.raw.kind).toBe(rawKind);
    expect(report.record).toMatchObject({ blobSha: null, bytesB64: null, version: null });
    for (const row of report.gates) {
      expect(row.live.main.decision).toBe('unknown');
      expect(row.live.pinned.decision).toBe('unknown');
      for (const candidate of row.candidates) {
        expect(candidate.main.decision).toBe('unknown');
        expect(candidate.pinned.decision).toBe('unknown');
      }
    }
  });

  it.each([
    ['gh-body', { type: 'dir' }], ['gh-body', { encoding: 'utf8' }], ['gh-body', { content: null }],
    ['gh-content', { content: 'c3R1ZGlv=!' }], ['gh-content', { content: 'Zh==' }],
    ['gh-sha', { sha: null }], ['gh-sha', { sha: 'b'.repeat(39) }], ['gh-sha', { sha: 'g'.repeat(40) }],
  ])('wrong body, non-canonical base64 and missing or non-40-hex sha give %s: %j', async (kind, body) => {
    expectIncomplete(await fixture({ body }).read(), kind);
  });

  it('raw stderrHead is bounded to the first 512 bytes and preserves status, signal and code', async () => {
    const report = await fixture({ ghError: failure(1, `HTTP 503 ${'x'.repeat(1000)}`, { code: 'EIO', signal: 'SIGTERM' }) }).read();
    expect(report.gh.raw).toMatchObject({ kind: 'threw', code: 'EIO', signal: 'SIGTERM', status: 1,
      stderrHead: `HTTP 503 ${'x'.repeat(503)}` });
    expect(Buffer.byteLength(report.gh.raw.stderrHead)).toBe(512);
    expectIncomplete(report, 'gh-status');
  });

  it('pinned import failure is pinned-import while main predictions remain available', async () => {
    const report = await fixture({ pinnedError: new Error('missing pinned guard') }).read();
    expectIncomplete(report, 'pinned-import');
    expect(report.gates[0].live).toMatchObject({ main: { decision: 'revoke-possible' }, pinned: { decision: 'unknown' } });
    expect(report.gates[0].candidates[0]).toMatchObject({ main: { decision: 'owner' }, pinned: { decision: 'unknown' } });
  });

  it('gh is invoked with the nonce caller, disabled shim retries, canonical host and timeoutMs 15000 by default', async () => {
    const h = fixture();
    await h.read();
    const calls = h.exec.mock.calls.filter(([command]) => command === 'gh');
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ timeout: 15000, killSignal: 'SIGKILL', env: {
      GH_HOST: 'github.com', GH_CALLER: CALLER, WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1', WE_GH_JSON_RETRIES: '0',
    } });
  });

  it('gh child timeout: function API timeoutMs 200 lets the existing guard kill its child and reports gh-timeout', async () => {
    const { createDaemonHostGateDryrunReader } = await loadDryrun();
    const h = fixture();
    const child = join(h.root, 'blocked-gh.mjs');
    fs.writeFileSync(child, keepAliveScript({ maxLifetimeMs: 10000 }));
    const native = await vi.importActual('node:child_process');
    const exec = (command, argv, settings) => command === 'gh'
      ? native.execFileSync(process.execPath, [child], settings) : h.exec(command, argv, settings);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('op must initiate no signal'); });
    const report = await createDaemonHostGateDryrunReader({ ...h.deps, exec, timeoutMs: 200 })({});
    expectIncomplete(report, 'gh-timeout');
    expect(kill).not.toHaveBeenCalled();
  });

  it('main scutil timeout yields host-identity-unknown; the op initiates no signal', async () => {
    const h = fixture({ gates: [gate('has-children')], record: `studio\nstudio=${SELF}` });
    execFileSync.mockImplementationOnce(() => { throw failure(null, 'scutil timed out', { code: 'ETIMEDOUT', signal: 'SIGKILL' }); });
    const kill = vi.spyOn(process, 'kill');
    const report = await h.read();
    expect(report.gates[0].live.main).toEqual({ decision: 'revoke-possible', reason: 'host-identity-unknown' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('shim hold timeout: maxHoldSeconds 1 SIGTERMs its descendant and reports gh-exec or gh-timeout without an op signal', async () => {
    const { createDaemonHostGateDryrunReader } = await loadDryrun();
    const h = fixture();
    const native = await vi.importActual('node:child_process');
    let nativeError;
    const exec = (command, argv, settings) => {
      if (command !== 'gh') return h.exec(command, argv, settings);
      try {
        return runGhSync(['-e', keepAliveScript({ maxLifetimeMs: 10000 })], {
          encoding: 'utf8', maxBuffer: 1048576, throttle: { bin: process.execPath,
            lockRoot: h.deps.env.WE_GH_THROTTLE_LOCK_ROOT, logPath: h.ledger,
            env: { WE_GH_THROTTLE_MAX_HOLD_SECONDS: '1', WE_GH_THROTTLE_COST_HEADERS: '0',
              WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' }, budgetPerMin: 100,
            exec: native.execFileSync,
          },
        });
      } catch (error) { nativeError = error; throw error; }
    };
    const kill = vi.spyOn(process, 'kill');
    const report = await createDaemonHostGateDryrunReader({ ...h.deps, exec })({});
    expect(nativeError).toMatchObject({ code: 'ETIMEDOUT', signal: 'SIGTERM' });
    expect(report.complete).toBe(false);
    expect(report.errors.some(error => ['gh-exec', 'gh-timeout'].includes(error.kind))).toBe(true);
    expect(finish(report).code).toBe(2);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });
});

describe('ledger observation is explicitly incomplete', () => {
  const line = (outcome, extra = {}) => JSON.stringify({ caller: CALLER, ts: NOW, outcome, ...extra }) + '\n';
  it('exception E1: ledger-unreadable leaves the report complete with observed:null', async () => {
    const h = fixture({ filesystem: { readFileSync: (path, ...args) => {
      if (String(path).includes('gh-call')) throw new Error('ledger denied');
      return fs.readFileSync(path, ...args);
    } } });
    // A directory at the exact resolver path also exercises real filesystem refusal.
    fs.unlinkSync(h.ledger); fs.mkdirSync(h.ledger);
    const report = await h.read();
    expect(report.complete).toBe(true);
    expect(report.errors).toContainEqual({ kind: 'ledger-unreadable', label: null, detail: expect.any(String) });
    expect(report.observed).toBeNull();
    expect(finish(report).code).toBe(0);
  });

  it('ledger path honours ghThrottleLockRoot overrides; malformed lines count and concurrent nonces do not match', async () => {
    const h = fixture();
    fs.writeFileSync(h.ledger, line('ok') + line('blocked') + line('ok', { caller: 'another-run' }) + 'broken JSON\n');
    const report = await h.read();
    expect(report.observed).toMatchObject({ matchingLedgerLines: 2, byOutcome: { ok: 1, blocked: 1 }, malformedLines: 1,
      ledgerFilesRead: [h.ledger], cutoff: report.finishedAt });
  });

  it('rotation inside the window reads .1 and the current file, and lines after finishedAt are not counted', async () => {
    const h = fixture({ duringGh: ({ ledger }) => {
      fs.renameSync(ledger, `${ledger}.1`);
      fs.writeFileSync(ledger, line('blocked') + line('late', { ts: NOW + 1 }));
    } });
    fs.writeFileSync(h.ledger, line('ok'));
    const report = await h.read();
    expect(report.observed).toMatchObject({ matchingLedgerLines: 2, byOutcome: { ok: 1, blocked: 1 }, cutoff: report.finishedAt });
    expect([...report.observed.ledgerFilesRead].sort()).toEqual([h.ledger, `${h.ledger}.1`].sort());
  });

  it('a double rotation loses lines and the observation never claims to count network attempts', async () => {
    const h = fixture({ duringGh: ({ ledger }) => {
      fs.renameSync(ledger, `${ledger}.1`);
      fs.writeFileSync(ledger, line('middle'));
      fs.renameSync(ledger, `${ledger}.1`);
      fs.writeFileSync(ledger, line('last'));
    } });
    fs.writeFileSync(h.ledger, line('lost'));
    const report = await h.read();
    expect(report.observed.matchingLedgerLines).toBe(2);
    expect(report.observed.byOutcome).toEqual({ middle: 1, last: 1 });
    expect(report.observed).not.toHaveProperty('complete');
    expect(report.notPredicted.join(' ')).toMatch(/network attempts/);
  });
});

describe('declared operation and output', () => {
  it('every step is compute with no sinks; the default candidate is bindings while H1 is open', async () => {
    const { daemonHostGateDryrunOperation, finishDaemonHostGateDryrun } = await loadDryrun();
    const collect = vi.fn(fixture().read);
    const declaration = daemonHostGateDryrunOperation({ collect });
    expect(isReadOnlyOperation(declaration)).toBe(true);
    expect(declaration.steps.length).toBeGreaterThan(0);
    expect(declaration.steps.every(({ step }) => step.kind === 'compute')).toBe(true);
    const registry = createRegistry(); registry.register(declaration);
    const outcome = await runOperationCli({ declaration, registry, sinks: {}, store: createMemoryRunStore(), argv: ['--json'] });
    expect(outcome.code).toBe(0);
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ candidates: 'bindings' }));
    expect(finishDaemonHostGateDryrun({ ...outcome, json: true }).code).toBe(0);
  });

  it('exact JSON has schema, gate live.main/pinned, raw gh evidence, errors and warnings; no deploy authorization', async () => {
    const h = fixture({ dirty: true });
    const report = await h.read();
    expect(Object.keys(report).sort()).toEqual(['schema', 'nonce', 'startedAt', 'finishedAt', 'elapsedMs', 'complete',
      'errors', 'warnings', 'mainSha', 'mainDirty', 'hostId', 'pinnedHost', 'record', 'gh', 'gates', 'fix', 'observed', 'notPredicted'].sort());
    expect(report).toMatchObject({ schema: 1, nonce: NONCE, elapsedMs: 0, mainSha: SHA, mainDirty: true,
      hostId: { state: 'ok' }, record: { blobSha: SHA, bytesB64: b64('studio\n'), version: SHA,
        versionSource: 'synthesized-from-blob-sha' }, errors: [], warnings: [], gh: { raw: { kind: 'returned' } } });
    expect(report.hostId).not.toHaveProperty('value');
    expect(report.notPredicted.join(' ')).toMatch(/startup refusals/);
    const rendered = finish(report);
    expect(JSON.parse(rendered.lines.join('\n'))).toEqual(report);
    expect(rendered.code).toBe(0);
  });

  it('the reader leaves its HOME and repo tree byte-identical, including .git metadata; the snapshot catches an unmarked write', async () => {
    const h = fixture();
    fs.writeFileSync(join(h.cwd, '.git', 'FETCH_HEAD'), 'fixture fetch head\n');
    fs.writeFileSync(join(h.cwd, '.git', 'runner-freshness.json'), 'expired fixture\n');
    const before = snapshot(h.root);
    await h.read();
    expect(snapshot(h.root)).toEqual(before);
    fs.writeFileSync(join(h.cwd, '.git', 'unexpected'), 'unmarked write');
    expect(snapshot(h.root)).not.toEqual(before);
  });

  it('the production entrypoint recognises the op and exposes only the candidate selector, without executing tools for --help', () => {
    const h = productionFixture();
    const result = h.run(['--help']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('--candidates');
    expect(result.stdout).not.toContain('--timeout');
    expect(result.calls).toEqual([]);
  });

  it('production entrypoint with an expired freshness cache does no fetch, writes no cache/runs/calls/host-id, and prints the exact report with exit 0', () => {
    const h = productionFixture();
    const result = h.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schema: 1, complete: true, hostId: { state: 'ok' },
      gates: [{ label: 'com.we.fixture', labelFile: 'different-name.plist', state: 'has-children',
        live: { main: { decision: 'revoke-possible', reason: 'owner-alias-ambiguous' }, pinned: { decision: 'owner' } } }],
      errors: [], gh: { raw: { kind: 'returned' } } });
    expect(report.warnings).toContain('Warning: fetch cache unavailable or expired; read-only inspection did not fetch; run from a lane.');
    expect(result.calls.some(call => call.command === 'git' && call.argv.includes('fetch'))).toBe(false);
    const gh = result.calls.filter(call => call.command === 'gh');
    expect(gh).toHaveLength(1);
    expect(gh[0].env).toMatchObject({ GH_CALLER: `daemon-host-gate-dryrun:${report.nonce}`,
      GH_HOST: 'github.com', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1', WE_GH_JSON_RETRIES: '0' });
    // The same observer catches a write with no identifying marker.
    const before = snapshot(h.root);
    fs.writeFileSync(join(h.cwd, '.git', 'unintended'), 'unmarked write');
    expect(snapshot(h.root)).not.toEqual(before);
  });

  it.each([
    ['gh-status', { ghStatus: 403 }, 'threw'],
    ['gh-body', { ghOutput: 'not JSON' }, 'returned'],
    ['gh-exec', { ghExecFailure: true }, 'threw'],
  ])('production entrypoint classifies %s through the recorder, exits 2 and leaves no own failure artifacts', (kind, options, rawKind) => {
    const result = productionFixture(options).run();
    expect(result.status, result.stdout + result.stderr).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.complete).toBe(false);
    expect(report.errors).toContainEqual({ kind, label: null, detail: expect.any(String) });
    expect(report.gh.raw.kind).toBe(rawKind);
    expect(report.gates[0].live).toMatchObject({ main: { decision: 'unknown' }, pinned: { decision: 'unknown' } });
    expect(report.warnings).toContain('Warning: fetch cache unavailable or expired; read-only inspection did not fetch; run from a lane.');
  });

  it('production entrypoint keeps the 15000ms gh timeout and classifies the native kill as gh-timeout with exit 2', () => {
    const result = productionFixture({ ghTimeout: true }).run();
    expect(result.status, result.stdout + result.stderr).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.complete).toBe(false);
    expect(report.errors).toContainEqual({ kind: 'gh-timeout', label: null, detail: expect.any(String) });
    expect(report.gh.raw).toMatchObject({ kind: 'threw', code: 'ETIMEDOUT' });
    expect(result.calls.filter(call => call.command === 'gh')).toHaveLength(1);
  }, 25000);

  it('a freshness exception exits 1 before ownership reads and leaves no own artifacts', () => {
    const result = productionFixture({ gitFailure: true }).run();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.calls.some(call => call.command === 'gh')).toBe(false);
  });
});
