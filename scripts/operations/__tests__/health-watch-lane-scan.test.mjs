import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedLaneScan, resolveLaneScanPolicy, freshLaneSafety, guardLaneAction } from '../../lib/health-watch-lane-scan.mjs';
import { createStaleStateReader } from '../stale-state-io.mjs';
import { OPERATIONS } from '../run.mjs';
import { laneGitEnv, worktreeGitEnv } from '../../lib/git-transport-branch.mjs';

vi.mock('../stale-state-io.mjs', async original => {
  const real = await original();
  return { ...real, createStaleStateReader: vi.fn(real.createStaleStateReader) };
});

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'health-lane-scan-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const policy = { interval: 300, source: 'standard', invalid: [] };
const rows = [{ lane: { path: '/fixture/lane-1', clean: false, lease: { agentPid: 123 } }, ahead: 2 }];

describe('health-watch persistent lane scan', () => {
  it('skips within the interval across readers, retains lane data and logs interval/source once', () => {
    const dir = temp();
    const scan = vi.fn(() => rows);
    const log = vi.fn();
    expect(cachedLaneScan(scan, { dir, root: '/fixture', now: 1000, policy, log })).toEqual(rows);
    const nextScan = vi.fn();
    expect(cachedLaneScan(nextScan, { dir, root: '/fixture', now: 42000, policy, log })).toEqual(rows.map(row => ({ ...row, cachedAt: 1000 })));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(nextScan).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ['health-watch: lane scan running (due, interval=300s, source=standard)'],
      ['health-watch: lane scan skipped (age 41s < 300s, source=standard)'],
    ]);
    expect(readdirSync(dir)).toEqual(['lane-scan.json']);
    expect(JSON.parse(readFileSync(join(dir, 'lane-scan.json'), 'utf8')).lanes).toEqual(rows);
  });

  it('runs the full scan when due at the boundary', () => {
    const dir = temp();
    const scan = vi.fn(() => rows);
    const opts = { dir, root: '/fixture', policy, log: vi.fn() };
    cachedLaneScan(scan, { ...opts, now: 1000 });
    cachedLaneScan(scan, { ...opts, now: 301000 });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, '{broken', '{}', '{"version":1,"root":"/fixture","at":1000,"lanes":[null]}'])(
    'runs when cache is missing or corrupt (%s)', content => {
      const dir = temp();
      if (content !== undefined) writeFileSync(join(dir, 'lane-scan.json'), content);
      const scan = vi.fn(() => rows);
      expect(cachedLaneScan(scan, { dir, root: '/fixture', now: 2000, policy, log: vi.fn() })).toEqual(rows);
      expect(scan).toHaveBeenCalledTimes(1);
    });

  it('does not write with caching disabled for a bare dry run/fixture', () => {
    const dir = temp();
    cachedLaneScan(() => rows, { dir, root: '/fixture', now: 1000, write: false, policy, log: vi.fn() });
    expect(readdirSync(dir)).toEqual([]);
    cachedLaneScan(() => rows, { dir: null, root: '/fixture', now: 1000, policy, log: vi.fn() });
  });

  it('retains expired leases, read errors and unsafe-work decisions while rechecking claims and owner liveness', () => {
    const dir = temp();
    let now = 1000;
    let alive = true;
    const lane = { path: '/fixture/lane-1', leased: false, clean: true,
      lease: { pid: 12, agentPid: 123, workerSession: 'worker', acquiredAt: '1970-01-01T00:00:00Z' } };
    const run = vi.fn((bin) => bin === 'git' ? '2' : JSON.stringify({ lanes: [lane, { path: '/fixture/lane-2', readError: 'bad lease' }] }));
    const readClaim = vi.fn(() => ({ found: true, status: 'active', rel: 'backlog/123-active.md',
      content: '---\nstatus: active\npid: 123\n---\n' }));
    const options = { root: '/fixture', run, now: () => now, probe: () => alive,
      listFiles: () => ['123-active.md'], readText: () => '---\nstatus: active\n---\n', readClaim,
      runStore: { list: () => [] }, laneScan: { dir, policy, log: vi.fn() } };
    const first = createStaleStateReader(options)();
    now = 42000;
    alive = false;
    const second = createStaleStateReader(options)();
    expect(run).toHaveBeenCalledTimes(2); // one full status and one leased-lane ahead probe
    expect(readClaim).toHaveBeenCalledTimes(2);
    expect(second.records.map(r => r.kind)).toEqual(['lane-lease', 'lane-lease', 'claim']);
    expect(first.records[0]).toMatchObject({ ownerPidAlive: true, hasUnsafeWork: true, lane: { ahead: 2 } });
    expect(second.records[0]).toMatchObject({ ownerPidAlive: false, hasUnsafeWork: true, lane: { ahead: 2 } });
    expect(second.records[1]).toMatchObject({ readError: 'bad lease' });
    expect(second.records[2]).toMatchObject({ ownerPidAlive: false });
    expect(Object.keys(second.records[0])).toEqual(Object.keys(first.records[0]));
  });
});

describe('cached lane safety is reporting only (operator ruling 2026-10-20)', () => {
  const lease = { pid: 12, agentPid: 123, workerSession: 'worker', acquiredAt: '1970-01-01T00:00:00Z' };
  const reader = (dir, lanes, aheadOut) => {
    let now = 1000;
    const run = vi.fn((bin) => bin === 'git' ? aheadOut : JSON.stringify({ lanes }));
    const options = { root: '/fixture', run, now: () => now, probe: () => false, listFiles: () => [], readText: () => '',
      readClaim: vi.fn(), runStore: { list: () => [] }, laneScan: { dir, policy, log: vi.fn() } };
    return { read: () => createStaleStateReader(options)(), tick: ms => { now += ms; }, run };
  };
  it('a cached SAFE row is reported unknown (never safe), keeps the cached value for reporting, and says so in gaps', () => {
    const dir = temp();
    const r = reader(dir, [{ path: '/fixture/lane-1', clean: true, lease }], '0');
    const first = r.read();
    expect(first.records[0]).toMatchObject({ hasUnsafeWork: false, safety: { source: 'fresh', cachedHasUnsafeWork: null } });
    r.tick(41000);
    const second = r.read();
    expect(second.records[0]).toMatchObject({ hasUnsafeWork: null,
      safety: { source: 'cache', observedAt: new Date(1000).toISOString(), cachedHasUnsafeWork: false } });
    expect(second.gaps.some(g => g.includes('reporting only, never safe'))).toBe(true);
    expect(Object.keys(second.records[0])).toEqual(Object.keys(first.records[0]));
  });
  it('a cached UNKNOWN row stays unknown and a cached UNSAFE row stays unsafe', () => {
    const dir = temp();
    const r = reader(dir, [{ path: '/fixture/a', clean: true, lease }, { path: '/fixture/b', clean: false, lease }], 'garbage');
    r.read();
    r.tick(1000);
    const [a, b] = r.read().records;
    expect(a).toMatchObject({ hasUnsafeWork: null, safety: { source: 'cache', cachedHasUnsafeWork: null } });
    expect(b).toMatchObject({ hasUnsafeWork: true, safety: { source: 'cache', cachedHasUnsafeWork: true } });
  });
  it('never writes an unsafe or unknown row into the cache as safe', () => {
    const dir = temp();
    const r = reader(dir, [{ path: '/fixture/a', clean: true, lease }, { path: '/fixture/b', clean: false, lease }], 'garbage');
    r.read();
    const cached = JSON.parse(readFileSync(join(dir, 'lane-scan.json'), 'utf8')).lanes;
    expect(cached.map(row => row.ahead)).toEqual([null, null]);
    expect(cached[1].lane.clean).toBe(false);
  });
  it('isolates both the lane-pool child and per-lane git reporting reads from inherited Git selectors', () => {
    vi.stubEnv('GIT_DIR', '/foreign/clean');
    const r = reader(temp(), [{ path: '/fixture/lane-1', clean: true, lease }], '0');
    try {
      r.read();
      expect(r.run.mock.calls.map(([bin, , options]) => [bin === 'git', options.cwd, options.env.GIT_CEILING_DIRECTORIES]))
        .toEqual([[false, '/fixture', '/'], [true, '/fixture/lane-1', '/fixture']]);
      for (const [, , options] of r.run.mock.calls) {
        expect(options.env).not.toHaveProperty('GIT_DIR');
        expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0');
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('shared lane Git environment', () => {
  it('strips every repository selector without changing the base or the transport credential role', () => {
    const selectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
    const base = { ...Object.fromEntries(selectors.map(key => [key, '/foreign/clean'])),
      GIT_CEILING_DIRECTORIES: '/foreign', WE_GITHUB_APP_ROLE: 'reader', PATH: '/bin' };
    const env = laneGitEnv('/fixture/lane', base);
    for (const key of selectors) {
      expect(env).not.toHaveProperty(key);
      expect(base[key]).toBe('/foreign/clean');
    }
    expect(env).toMatchObject({ GIT_CEILING_DIRECTORIES: '/fixture', WE_GITHUB_APP_ROLE: 'reader', PATH: '/bin' });
    expect(worktreeGitEnv('/fixture/lane', base)).toEqual({ ...env, WE_GITHUB_APP_ROLE: 'ledger' });
  });
});

describe('fresh per-lane safety check before any destructive action', () => {
  const commands = [
    ['git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']],
    ['git', ['ls-files', '-v']],
    ['git', ['stash', 'list']],
    ['git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']],
  ];
  const gitMocks = [];
  // Assert outside the checker: it catches exec errors, including failed assertions inside a mock.
  afterEach(() => {
    for (const exec of gitMocks.splice(0)) {
      for (const [bin, argv] of exec.mock.calls) expect(commands).toContainEqual([bin, argv]);
    }
  });
  const git = outputs => {
    const replies = new Map(commands.map((command, i) => [JSON.stringify(command),
      [outputs.status, outputs['ls-files'] ?? 'H tracked.txt\n', outputs.stash, outputs['rev-list']][i]]));
    const exec = vi.fn((bin, argv) => {
      const out = replies.get(JSON.stringify([bin, argv]));
      if (out instanceof Error) throw out;
      return out;
    });
    gitMocks.push(exec);
    return exec;
  };
  it('safe only when clean, no stash and nothing unpushed', () => {
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '', stash: '', 'rev-list': '0\n' }) })).toMatchObject({ hasUnsafeWork: false, fresh: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: ' M a.mjs\n', stash: '', 'rev-list': '0' }) })).toMatchObject({ hasUnsafeWork: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '?? new.mjs\n', stash: '', 'rev-list': '0' }) })).toMatchObject({ hasUnsafeWork: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '', stash: 'stash@{0}: x', 'rev-list': '0' }) })).toMatchObject({ hasUnsafeWork: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '', stash: '', 'rev-list': '3' }) })).toMatchObject({ hasUnsafeWork: true });
  });
  it('pins the exact git argv: untracked files listed in full, unpushed counted against origin refs only', () => {
    const exec = git({ status: '', stash: '', 'rev-list': '0\n' });
    freshLaneSafety({ path: '/l', exec });
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([
      ['git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']],
      ['git', ['ls-files', '-v']],
      ['git', ['stash', 'list']],
      ['git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']],
    ]);
    for (const [, , options] of exec.mock.calls) {
      expect(options).toMatchObject({ cwd: '/l', encoding: 'utf8', timeout: 30_000 });
      expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0');
    }
  });
  it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'])(
    'ignores inherited %s so a clean foreign repository cannot authorize a dirty lane', variable => {
      vi.stubEnv(variable, '/foreign/clean');
      const exec = vi.fn((bin, argv, options) => {
        // Model a clean foreign repo masking edits in the lane selected by cwd.
        if (argv[0] === 'status') return options.env[variable] ? '' : ' M tracked.txt\n';
        if (argv[0] === 'ls-files') return 'H tracked.txt\n';
        if (argv[0] === 'stash') return '';
        if (argv[0] === 'rev-list') return '0\n';
        throw new Error(`unexpected command: ${bin} ${argv.join(' ')}`);
      });
      gitMocks.push(exec);
      try {
        expect(freshLaneSafety({ path: '/l', exec })).toMatchObject({ hasUnsafeWork: true, reason: 'worktree has changes' });
        for (const action of ['reclaim', 'reset', 'reuse', 'release-on-behalf']) {
          expect(guardLaneAction({ path: '/l', action, exec, log: vi.fn() }).act).toBe(false);
        }
        for (const [, , options] of exec.mock.calls) {
          expect(options.cwd).toBe('/l');
          expect(options.env).not.toHaveProperty(variable);
          expect(options.env.GIT_CEILING_DIRECTORIES).toBe('/');
        }
      } finally { vi.unstubAllEnvs(); }
    });
  it('sanitizes the environment of every git probe in a clean lane', () => {
    const selectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
    for (const key of selectors) vi.stubEnv(key, '/foreign/clean');
    const exec = git({ status: '', stash: '', 'rev-list': '0' });
    try {
      expect(freshLaneSafety({ path: '/fixture/lane', exec }).hasUnsafeWork).toBe(false);
      expect(exec).toHaveBeenCalledTimes(commands.length);
      for (const [, , options] of exec.mock.calls) {
        for (const key of selectors) expect(options.env).not.toHaveProperty(key);
        expect(options.env.GIT_CEILING_DIRECTORIES).toBe('/fixture');
        expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0');
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    { work: 'only an untracked file', status: '?? dir/new.mjs\n', count: '0\n', reason: 'worktree has changes' },
    { work: 'only commits missing from origin', status: '', count: '2\n', reason: '2 unpushed commit(s)' },
  ])('reports a lane with $work unsafe using the full git argv', ({ status, count, reason }) => {
    // Deliberately return clean results for other argv so a missing flag cannot pass by triggering an exec error.
    const exec = vi.fn((bin, argv) => {
      const command = JSON.stringify([bin, argv]);
      if (command === JSON.stringify(['git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']])) return status;
      if (command === JSON.stringify(['git', ['ls-files', '-v']])) return 'H tracked.txt\n';
      if (command === JSON.stringify(['git', ['stash', 'list']])) return '';
      if (command === JSON.stringify(['git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']])) return count;
      if (argv.includes('status')) return '';
      return '0\n';
    });
    gitMocks.push(exec);
    expect(freshLaneSafety({ path: '/l', exec })).toMatchObject({ hasUnsafeWork: true, reason });
  });
  it('refuses every destructive action when status would hide submodule changes without an explicit override', () => {
    // Model Git hiding submodule dirt unless the command explicitly overrides ignore settings.
    // The fallback is clean (not an error), so omission must fail by authorizing the action.
    const exec = vi.fn((bin, argv) => {
      if (argv[0] === 'status') return argv.includes('--ignore-submodules=none') ? ' M child\n' : '';
      if (argv[0] === 'ls-files') return 'H child\n';
      if (argv[0] === 'stash') return '';
      if (argv[0] === 'rev-list') return '0\n';
      throw new Error(`unexpected command: ${bin} ${argv.join(' ')}`);
    });
    gitMocks.push(exec);
    for (const action of ['reclaim', 'reset', 'reuse', 'release-on-behalf']) {
      expect(guardLaneAction({ path: '/l', action, exec, log: vi.fn() })).toMatchObject({
        act: false, fresh: { hasUnsafeWork: true, reason: 'worktree has changes' },
      });
    }
  });
  it.each(['h', 'S', 's', 'M', '?'])(
    'refuses every destructive action when index tag %s hides work despite clean status', tag => {
      const exec = git({ status: '', 'ls-files': `H ordinary.txt\n${tag} tracked.txt\n`, stash: '', 'rev-list': '0' });
      expect(freshLaneSafety({ path: '/l', exec })).toMatchObject({
        hasUnsafeWork: true, fresh: true, reason: 'index flags may hide worktree changes',
      });
      for (const action of ['reclaim', 'reset', 'reuse', 'release-on-behalf']) {
        expect(guardLaneAction({ path: '/l', action, exec, log: vi.fn() })).toMatchObject({
          act: false, fresh: { hasUnsafeWork: true, reason: 'index flags may hide worktree changes' },
        });
      }
    });
  it('refuses destructive action when the index flag probe fails', () => {
    const exec = git({ status: '', 'ls-files': new Error('index unreadable'), stash: '', 'rev-list': '0' });
    expect(guardLaneAction({ path: '/l', action: 'reset', exec, log: vi.fn() })).toMatchObject({
      act: false, fresh: { hasUnsafeWork: true, reason: 'fresh safety check failed', error: 'index unreadable' },
    });
  });
  it('any error, timeout or unparseable output is unsafe', () => {
    for (const outputs of [{ status: new Error('timeout') }, { status: '', stash: new Error('locked') },
      { status: '', stash: '', 'rev-list': new Error('bad object') }, { status: '', stash: '', 'rev-list': 'nope' }]) {
      expect(freshLaneSafety({ path: '/l', exec: git(outputs) })).toMatchObject({ hasUnsafeWork: true, fresh: true });
    }
    expect(freshLaneSafety({ path: '', exec: git({}) })).toMatchObject({ hasUnsafeWork: true });
  });
  it('stale cached SAFE + fresh UNSAFE -> no action (the record is ignored, the fresh check decides)', () => {
    const cachedRecord = { kind: 'lane-lease', id: '/fixture/lane-1', hasUnsafeWork: null, safety: { source: 'cache', cachedHasUnsafeWork: false } };
    const log = vi.fn();
    const exec = git({ status: ' M work-in-progress.mjs\n', stash: '', 'rev-list': '0' });
    const verdict = guardLaneAction({ path: cachedRecord.id, action: 'release-on-behalf', exec, log });
    expect(verdict).toMatchObject({ act: false, fresh: { hasUnsafeWork: true, fresh: true } });
    expect(exec).toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('refused');
    for (const action of ['reclaim', 'reset', 'reuse', 'release-on-behalf']) {
      expect(guardLaneAction({ path: '/fixture/lane-1', action, exec, log }).act).toBe(false);
    }
  });
  it('fresh check error -> no action; a throwing or non-fresh checker -> no action; only fresh safe -> act', () => {
    const log = vi.fn();
    expect(guardLaneAction({ path: '/l', action: 'reset', exec: git({ status: new Error('EACCES') }), log }).act).toBe(false);
    expect(guardLaneAction({ path: '/l', action: 'reset', check: () => { throw new Error('boom'); }, log }).act).toBe(false);
    expect(guardLaneAction({ path: '/l', action: 'reset', check: () => ({ hasUnsafeWork: false }), log }).act).toBe(false);
    expect(guardLaneAction({ path: '/l', action: 'reset', exec: git({ status: '', stash: '', 'rev-list': '0' }), log }).act).toBe(true);
  });
});

describe('stale-state operation factory cache opt-in', () => {
  it.each([
    { enabled: undefined, dir: '/cache', write: '1', laneScan: undefined },
    { enabled: '', dir: '/cache', write: '1', laneScan: undefined },
    { enabled: '0', dir: '/cache', write: '1', laneScan: undefined },
    { enabled: 'true', dir: '/cache', write: '1', laneScan: undefined },
    { enabled: '1', dir: '/cache', write: '1', laneScan: { dir: '/cache', write: true } },
    { enabled: '1', dir: '', write: '', laneScan: { dir: undefined, write: false } },
    { enabled: '1', dir: undefined, write: undefined, laneScan: { dir: undefined, write: false } },
    { enabled: '1', dir: '/cache', write: '0', laneScan: { dir: '/cache', write: false } },
  ])('passes laneScan=$laneScan for enabled=$enabled, dir=$dir, write=$write', ({ enabled, dir, write, laneScan }) => {
    for (const [key, value] of Object.entries({
      WE_HEALTH_WATCH_LANE_SCAN: enabled,
      WE_HEALTH_WATCH_LANE_SCAN_DIR: dir,
      WE_HEALTH_WATCH_LANE_SCAN_WRITE: write,
    })) {
      vi.stubEnv(key, value ?? '');
      if (value === undefined) delete process.env[key];
    }
    createStaleStateReader.mockClear();
    try {
      OPERATIONS['stale-state']();
      expect(createStaleStateReader).toHaveBeenCalledTimes(1);
      expect(createStaleStateReader).toHaveBeenCalledWith({ laneScan });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('lane scan setting cascade', () => {
  const resolve = options => resolveLaneScanPolicy({ env: {}, platform: {}, tool: {}, ...options });
  it('uses standard, platform, tool, then environment and logs the winning source', () => {
    expect(resolve()).toEqual(policy);
    expect(resolve({ platform: { laneScanIntervalSec: 60 } })).toMatchObject({ interval: 60, source: 'platform' });
    expect(resolve({ platform: { laneScanIntervalSec: 60 }, tool: { laneScanIntervalSec: 90 } })).toMatchObject({ interval: 90, source: 'tool' });
    const resolved = resolve({ platform: { laneScanIntervalSec: 60 }, tool: { laneScanIntervalSec: 90 },
      env: { WE_HEALTH_WATCH_LANE_SCAN_INTERVAL_SEC: '120' } });
    expect(resolved).toMatchObject({ interval: 120, source: 'env' });
    const log = vi.fn();
    cachedLaneScan(() => rows, { dir: null, root: '/fixture', policy: resolved, log });
    expect(log).toHaveBeenCalledWith('health-watch: lane scan running (due, interval=120s, source=env)');
  });
  it.each(['0', '-1', '1.5', 'abc', '', 'Infinity', '9007199254740992'])(
    'falls back to standard and says so for invalid env %s', value => {
      const resolved = resolve({ platform: { laneScanIntervalSec: 60 }, env: { WE_HEALTH_WATCH_LANE_SCAN_INTERVAL_SEC: value } });
      expect(resolved).toMatchObject({ interval: 300, source: 'standard' });
      const log = vi.fn();
      cachedLaneScan(() => rows, { dir: null, root: '/fixture', policy: resolved, log });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('source=standard');
      expect(log.mock.calls[0][0]).toContain('falling back to default 300s');
    });
  it.each([0, -1, 1.5, '300'])( 'falls back for invalid tool setting %s', value => {
    expect(resolve({ tool: { laneScanIntervalSec: value } })).toMatchObject({ interval: 300, source: 'standard' });
  });
});
