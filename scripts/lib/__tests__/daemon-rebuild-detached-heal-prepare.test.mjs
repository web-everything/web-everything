import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { basename, resolve, sep } from 'node:path';

const hostFixture = vi.hoisted(() => { vi.resetModules(); return { home: process.env.TMPDIR }; });
vi.mock('node:os', async original => {
  const real = await original();
  const injected = { hostname: () => 'fixture-host', homedir: () => hostFixture.home };
  return { ...real, ...injected, default: { ...real.default, ...injected } };
});

// Inject unrelated host readers; exercise the real healer, preparation, state and write lock.
vi.mock('../daemon-rebuild/wrong-branch-heal.mjs', async original => {
  const real = await original();
  return { ...real, healWrongBranch: vi.fn(args => real.healWrongBranch({
    ...args, settings: { branches: ['ops/review-requests'], pathPrefixes: ['verdict-ledger/'] },
  })) };
});
vi.mock('../lane-repair.mjs', () => ({
  repairCloneRefs: () => ({ ok: true, pruned: [], reportedNew: [] }),
  holdsCloneWriteLock: () => true,
  probeBrokenRefs: () => ({ probeFailed: false, broken: [] }),
  diagnoseLane: () => ({ ok: true, problems: [] }),
}));
vi.mock('../settings-files.mjs', async original => ({ ...await original(), readDeclaredSettings: () => ({ settings: {} }) }));
vi.mock('../daemon-rebuild/recovery.mjs', async original => {
  const real = await original();
  return { ...real, resolveRecovery: args => real.resolveRecovery({ ...args, tool: {} }) };
});
vi.mock('../daemon-rebuild/audited-tip.mjs', () => ({ makeAuditedTipGate: () => () => false }));
vi.mock('../daemon-smoke-slots.mjs', () => ({ acquireSmokeSlot: vi.fn(), behindMainPriority: () => 0 }));
// Preparation imports the feed even with stale-overlay detection explicitly disabled.
vi.mock('../../operations/needs-you-feed.mjs', () => ({}));

import { healWrongBranch } from '../daemon-rebuild/wrong-branch-heal.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { acquireSmokeSlot } from '../daemon-smoke-slots.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import { writeRebuildState, rebuildStatePath, readRebuildState } from '../daemon-rebuild/state.mjs';

const NOW = Date.parse('2026-11-27T20:00:00Z');
const temps = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  syncBuiltinESMExports();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(adoption = 'valid') {
  const dir = mkdtempSync(join(tmpdir(), 'detached-prepare-'));
  hostFixture.home = dir;
  temps.push(dir);
  const root = join(dir, 'clone');
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-27T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-27T12:00:00Z',
    WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(dir, 'platform.json'), WE_FIX_READY_PATH: join(dir, 'fix-ready.jsonl'),
    WE_DAEMON_AUTO_REBASE: '0', WE_OVERLAY_STALE: '0', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0',
    WE_DAEMON_REBUILD_STRICT_EVIDENCE: '0', WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only',
  };
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
  writeFileSync(env.WE_FIX_READY_PATH, '');
  const git = args => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  const ok = args => { const r = git(args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  const origin = join(dir, 'origin.git');
  ok(['init', '--bare', '--quiet', '-b', 'main', origin]);
  ok(['init', '--quiet', '-b', 'main']);
  ok(['remote', 'add', 'origin', origin]);
  writeFileSync(join(root, 'tracked.txt'), 'adopted A\n');
  ok(['add', '.']); ok(['commit', '--quiet', '-m', 'A']);
  const adoptedHead = ok(['rev-parse', 'HEAD']);
  ok(['checkout', '--quiet', '--detach']);
  writeFileSync(join(root, 'tracked.txt'), 'remote B\n');
  ok(['add', '.']); ok(['commit', '--quiet', '-m', 'B']);
  const oldHead = ok(['rev-parse', 'HEAD']);
  ok(['update-ref', 'refs/remotes/origin/main', oldHead]);
  writeRebuildState(root, adoption === 'missing' ? {} : {
    adopted: { head: adoptedHead, mainSha: adoptedHead, inputsKey: 'fixture-adopted', applied: [], at: new Date(NOW).toISOString() },
  }, env);
  if (adoption === 'unreadable') writeFileSync(rebuildStatePath(root, env), '{invalid');
  const logs = [];
  const alerts = () => logs.filter(line => line.startsWith('daemon-rebuild: wrong-branch-')).map(line => {
    const [, kind, detail] = /^daemon-rebuild: (\S+) (.*)$/.exec(line);
    return { kind, detail: JSON.parse(detail) };
  });
  const calls = [];
  // Never execute remote calls or process/service probes. Only local Git in this fixture is allowed.
  const run = (args, opts) => {
    calls.push(args);
    expect(opts.cwd).toBe(root);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (['ls-remote', 'push'].includes(args[0])) throw new Error(`Unexpected remote call: ${args[0]}`);
    return spawnSync('git', args, { ...opts, env: { ...env, ...opts.env }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  };
  const log = { error: line => logs.push(line) };
  const args = { root, env, run, log, now: () => NOW, stateOpts: {}, mainOnly: true, skipCheck: null,
    prState: () => { throw new Error('Unexpected GitHub read'); } };
  const refs = () => ok(['for-each-ref', '--format=%(refname)', 'refs/we/wrong-branch-heal/']).split('\n').filter(Boolean);
  const prepare = async (extra = {}) => {
    const result = await withWriteLock(root, () => prepareRebuild({ ...args, ...extra }), {
      lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, now: () => NOW, waitMs: 0,
    });
    expect(result.ok).toBe(true);
    assertIsolation();
    return result.value;
  };
  // Some rebuild dependencies use native ESM. Sync builtin spies into those bindings too;
  // a Vitest module mock alone does not intercept their host/setting/process readers.
  const violations = [];
  const read = fs.readFileSync;
  const readdir = fs.readdirSync;
  const spawn = childProcess.spawnSync;
  const inside = path => {
    const resolved = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    return resolved === dir || resolved.startsWith(`${dir}${sep}`);
  };
  const forbidden = detail => { violations.push(detail); throw new Error(detail); };
  vi.spyOn(os, 'hostname').mockReturnValue('fixture-host');
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...options) => {
    if (inside(path)) return read(path, ...options);
    // The module loader reads code (including lazy CommonJS dependencies) and its temp cache.
    // These are executable test inputs, never daemon evidence or fixture data.
    const name = String(path);
    if (/[/\\]web[/\\][a-f0-9]{40}$/.test(name)
      || /[/\\]node_modules[/\\].*\.(?:c?js|mjs|json)$/.test(name)) return read(path, ...options);
    if (['daemon-rebuild-settings.json', 'dispatch-settings.json'].includes(basename(String(path)))) {
      return options[0] === 'utf8' || options[0]?.encoding === 'utf8' ? '{}' : Buffer.from('{}');
    }
    return forbidden(`Unexpected read outside fixture: ${path}`);
  });
  vi.spyOn(fs, 'readdirSync').mockImplementation((path, ...options) => {
    if (inside(path)) return readdir(path, ...options);
    if (basename(String(path)) === 'settings') return [];
    return forbidden(`Unexpected directory read outside fixture: ${path}`);
  });
  vi.spyOn(childProcess, 'spawnSync').mockImplementation((command, argv, options) => {
    if (command !== 'git' || !inside(options?.cwd ?? '') || ['fetch', 'push', 'ls-remote'].includes(argv[0])) {
      return forbidden(`Unexpected host/remote process: ${command} ${argv.join(' ')}`);
    }
    return spawn(command, argv, options);
  });
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(command => forbidden(`Unexpected exec: ${command}`));
  vi.spyOn(process, 'kill').mockImplementation(() => forbidden('Unexpected host PID probe'));
  const assertIsolation = () => expect(violations).toEqual([]);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  syncBuiltinESMExports();
  return { root, env, ok, git, args, adoptedHead, oldHead, refs, prepare, alerts, calls, assertIsolation };
}

describe('DAEMON-CLONE-DETACHED-HEAL prepare wiring', () => {
  it('passes adoptedHead, alerts with savedRef, and continues beyond the branch gate into a build lease', async () => {
    const f = fixture();
    const result = await f.prepare();
    expect(healWrongBranch).toHaveBeenCalledWith(expect.objectContaining({ adoptedHead: f.adoptedHead }));
    expect(result.terminal).toBe(false);
    expect(result.lease.token).toBeTruthy();
    expect(result.lease.host).toBe('fixture-host');
    const [alert] = f.alerts();
    expect(alert).toMatchObject({ kind: 'wrong-branch-healed', detail: { healed: true, savedRef: expect.any(String) } });
    expect(f.ok(['rev-parse', alert.detail.savedRef])).toBe(f.oldHead);
    expect(f.ok(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.adoptedHead);
    expect(f.calls.some(args => args[0] === 'fetch')).toBe(true);
    expect(readRebuildState(f.root, f.env).building.token).toBe(result.lease.token);
  });
  it.each(['missing', 'unreadable'])('refuses %s adoption evidence without moving HEAD or saving a ref', async adoption => {
    const f = fixture(adoption);
    const result = await f.prepare();
    expect(result.result).toMatchObject({ moved: false, reason: 'not-on-main' });
    expect(f.alerts()).toEqual([{ kind: 'wrong-branch-heal-refused', detail: { healed: false, reason: 'detached-not-adopted' } }]);
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.oldHead);
    expect(f.git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
    expect(f.refs()).toEqual([]);
  });
  it('readyOnly defers wrong-branch-heal without moving HEAD, saving a ref or calling the healer', async () => {
    const f = fixture();
    const before = readFileSync(rebuildStatePath(f.root, f.env));
    const result = await f.prepare({ readyOnly: true });
    expect(result.result).toMatchObject({ moved: false, reason: 'readonly-job-mutation-due', mutation: 'wrong-branch-heal' });
    expect(healWrongBranch).not.toHaveBeenCalled();
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.oldHead);
    expect(f.refs()).toEqual([]);
    expect(readFileSync(rebuildStatePath(f.root, f.env))).toEqual(before);
  });
  it('orchestrator reconstruction initiates a build after healing the live wedge', async () => {
    const f = fixture();
    let building = null;
    acquireSmokeSlot.mockImplementation(async () => {
      building = readRebuildState(f.root, f.env).building;
      return { acquired: false, reason: 'fixture-capacity-held', release: async () => {} };
    });
    const result = await rebuildClone({ ...f.args, asJob: false, versions: null, emitEvent: vi.fn(),
      spawnerOwners: () => [], readerStartTimeOf: () => null, lockOpts: { waitMs: 0 }, runSmoke: vi.fn() });
    f.assertIsolation();
    console.info('DAEMON-CLONE-DETACHED-HEAL reconstruction', JSON.stringify({ alerts: f.alerts(), reason: result.reason, building }));
    expect(f.alerts()[0]?.kind).toBe('wrong-branch-healed');
    expect(building).toMatchObject({ target: f.oldHead, token: expect.any(String), host: 'fixture-host' });
    expect(f.ok(['rev-parse', f.alerts()[0].detail.savedRef])).toBe(f.oldHead);
    expect(f.ok(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(result.reason).toBe('smoke-queue-timeout');
  });
});
