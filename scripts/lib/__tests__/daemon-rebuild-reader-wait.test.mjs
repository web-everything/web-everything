import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRead, acquireWrite, withReadLock, cloneLockDirs } from '../daemon-clone-lock.mjs';
import { readLockEntry, heartbeat } from '../../readiness/file-locks.mjs';
import * as jobs from '../daemon-rebuild/rebuild-job.mjs';
import { spawnSync } from 'node:child_process';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import * as planner from '../daemon-rebuild/plan.mjs';
import * as edgeFetch from '../daemon-rebuild/edge-fetch.mjs';
import * as adoption from '../daemon-rebuild/adopt.mjs';
import * as repair from '../lane-repair.mjs';
import { gitRun } from '../main-staleness.mjs';
import { readRebuildState, writeRebuildState, writeReadyCandidate } from '../daemon-rebuild/state.mjs';
import { alertsFilePath } from '../daemon-rebuild/state.mjs';

const dirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(join(tmpdir(), 'reader-wait-'));
  dirs.push(base);
  const root = join(base, 'clone');
  const lockRoot = join(base, 'locks');
  const env = { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_STATE_DIR: join(base, 'state') };
  let clock = 10_000;
  const opts = { lockRoot, probe: () => 'alive', now: () => clock, waitMs: 20, pollMs: 10,
    readerPriorityAfter: 0, writerPriorityAfter: 0, ignoreOwners: [], sleep: async ms => { clock += ms; } };
  const read = (owner, pid) => acquireRead(root, { ...opts, owner, pid, nowMs: clock });
  return { root, lockRoot, env, opts, read };
}

describe('detached rebuild reader wait', () => {
  it('excludes the live spawner without reclaiming its entry', async () => {
    const f = fixture();
    expect(f.read('Mac:60796', 60796).ok).toBe(true);
    expect(await acquireWrite(f.root, { ...f.opts, owner: 'Mac:12154', ignoreOwners: ['Mac:60796'] })).toEqual({ ok: true });
    expect(readLockEntry(cloneLockDirs(f.root, f.lockRoot).readersRoot, 'Mac:60796')).not.toBeNull();
  });

  it('still waits for a foreign live reader and times out', async () => {
    const f = fixture();
    f.read('Mac:60796', 60796);
    f.read('Mac:222', 222);
    expect(await acquireWrite(f.root, { ...f.opts, owner: 'Mac:12154', ignoreOwners: ['Mac:60796'] }))
      .toEqual({ ok: false, reason: 'tick-in-progress', heldBy: 'Mac:222' });
  });

  it('retains expired ignored readers with unknown liveness, but reclaims proven dead owners', async () => {
    const f = fixture();
    f.read('Mac:60796', 60796);
    f.read('Mac:333', 333);
    expect(await acquireWrite(f.root, { ...f.opts, owner: 'Mac:12154',
      now: () => 1_000_000, ignoreOwners: ['Mac:60796', 'Mac:333'],
      probe: entry => entry?.owner === 'Mac:333' ? 'dead' : 'unknown',
    })).toEqual({ ok: true });
    const { readersRoot } = cloneLockDirs(f.root, f.lockRoot);
    expect(readLockEntry(readersRoot, 'Mac:60796')).not.toBeNull();
    expect(readLockEntry(readersRoot, 'Mac:333')).toBeNull();
  });

  it('refuses the spawner next tick while the job reservation is pending, including withReadLock', async () => {
    const f = fixture();
    f.read('Mac:222', 222);
    const fn = vi.fn();
    const sleep = vi.fn(async () => {
      const opts = { ...f.opts, owner: 'Mac:60796', nowMs: f.opts.now(), trackStarvation: false };
      expect(acquireRead(f.root, opts)).toEqual({ ok: false, reason: 'writer-active', heldBy: 'Mac:12154' });
      expect(await withReadLock(f.root, fn, opts)).toEqual({ ok: false, reason: 'writer-active', heldBy: 'Mac:12154' });
      await f.opts.sleep(20);
    });
    await acquireWrite(f.root, { ...f.opts, owner: 'Mac:12154', ignoreOwners: ['Mac:60796'], sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores inherited ignored-owner env for acquireWrite defaults', async () => {
    const f = fixture();
    f.read('Mac:60796', 60796);
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', ' , Mac:60796, Mac:333 , ');
    const { ignoreOwners, ...opts } = f.opts;
    expect(await acquireWrite(f.root, { ...f.opts, owner: 'Mac:12154' })).toMatchObject({ reason: 'tick-in-progress' });
    expect(await acquireWrite(f.root, { ...opts, owner: 'Mac:12154' }))
      .toEqual({ ok: false, reason: 'tick-in-progress', heldBy: 'Mac:60796' });
  });

  it('passes only the spawner identity to the CLI child, excluding orphan ppid', () => {
    const env = { WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS: 'unsafe:123', DAEMON_JOB_ID: 'job' };
    expect(jobs.rebuildChildEnv(env, { ppid: 60796, host: 'Mac' })).toMatchObject({
      WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS: 'Mac:60796', WE_DAEMON_REBUILD_AS_JOB: '0',
    });
    expect(jobs.rebuildChildEnv(env, { ppid: 1, host: 'Mac' }).WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS).toBeUndefined();
    expect(jobs.rebuildChildEnv(env, { ppid: 60796, host: 'Mac' }).DAEMON_JOB_ID).toBeUndefined();
  });

  it('builds a bounded timeout outcome from heartbeat and emits both needs-you records with injected IO', () => {
    const f = fixture();
    f.read('Mac:222', 222);
    heartbeat(cloneLockDirs(f.root, f.lockRoot).readersRoot, 'Mac:222', 'Mac:222', new Date(12_000).toISOString(), 222);
    const exec = vi.fn(() => 'node\u0000 daemon\n' + 'x'.repeat(300));
    const event = vi.fn();
    const r = { reason: 'tick-in-progress', heldBy: 'Mac:222' };
    const outcome = jobs.reportReaderWaitTimeout({ root: f.root, env: f.env, r, io: fs, event, exec, now: () => 15_000, host: 'Mac' });
    expect(outcome).toEqual({ reason: 'reader-wait-timeout', detail: { pid: 222, command: ('node daemon' + 'x'.repeat(300)).slice(0, 200), tickAgeMs: 3000 } });
    expect(exec).toHaveBeenCalledWith('ps', ['-o', 'command=', '-p', '222'], expect.objectContaining({ timeout: 5000, maxBuffer: 65536 }));
    expect(event).toHaveBeenCalledWith(f.root, { kind: 'reader-wait-timeout-needs-you', ...outcome.detail }, { env: f.env });
    expect(JSON.parse(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8'))).toEqual({
      at: new Date(15_000).toISOString(), kind: 'reader-wait-timeout-needs-you', detail: outcome.detail,
    });
  });

  it('pure timeout builder falls back to acquired time, and leaves unreadable evidence null', () => {
    expect(jobs.buildReaderWaitOutcome({ reason: 'tick-in-progress', heldBy: 'Mac:222' }, {
      nowMs: 5000, readerEntry: { acquiredAt: new Date(1000).toISOString() },
    })).toEqual({ reason: 'reader-wait-timeout', detail: { pid: 222, command: null, tickAgeMs: 4000 } });
    expect(jobs.buildReaderWaitOutcome({ reason: 'tick-in-progress', heldBy: 'unknown' }))
      .toEqual({ reason: 'reader-wait-timeout', detail: { pid: null, command: null, tickAgeMs: null } });
    expect(jobs.buildReaderWaitOutcome({ reason: 'ready-recorded' })).toBeNull();
  });

  it('still writes the alert if event and evidence reads fail, and never probes a foreign host pid', () => {
    const f = fixture();
    const exec = vi.fn(() => { throw new Error('unavailable'); });
    const event = vi.fn(() => { throw new Error('unavailable'); });
    const io = { ...fs, readFileSync: () => { throw new Error('unreadable'); } };
    const outcome = jobs.reportReaderWaitTimeout({ root: f.root, env: f.env,
      r: { reason: 'tick-in-progress', heldBy: 'other:222' }, io, event, exec, host: 'Mac', now: () => 15_000 });
    expect(outcome.detail).toEqual({ pid: 222, command: null, tickAgeMs: null });
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8')).toContain('reader-wait-timeout-needs-you');
  });

  it('reports a local timeout even when ps and reader evidence are unavailable', () => {
    const f = fixture();
    const exec = vi.fn(() => { throw new Error('process exited'); });
    const outcome = jobs.reportReaderWaitTimeout({ root: f.root, env: f.env,
      r: { reason: 'tick-in-progress', heldBy: 'Mac:222' }, io: fs, exec, event: vi.fn(), host: 'Mac', now: () => 15_000 });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(outcome.detail).toEqual({ pid: 222, command: null, tickAgeMs: null });
    expect(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8')).toContain('reader-wait-timeout-needs-you');
  });
});

// Real checkout bytes (including HEAD, index, refs and tracked/untracked files) must survive a
// ready-only prepare; state and alerts live outside it, exactly as in a daemon clone.
function prepareFixture() {
  const f = fixture();
  fs.mkdirSync(f.root, { recursive: true });
  const git = args => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: f.root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(join(f.root, 'file'), 'old');
  git(['add', '.']); git(['commit', '-qm', 'old']);
  const old = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(join(f.root, 'file'), 'new');
  git(['commit', '-qam', 'new']);
  const head = git(['rev-parse', 'HEAD']);
  // Local baseline: no network or external origin is needed for these pre-fetch guards.
  git(['update-ref', 'refs/remotes/origin/main', head]);
  f.env = { ...process.env, ...f.env, WE_DAEMON_OVERLAY_DIR: join(f.root, '..', 'overlays'),
    WE_DAEMON_AUTO_REBASE: '0' };
  const run = vi.fn((args, opts) => args[0] === 'rev-list' && args.includes('--remotes=origin')
    ? { status: 0, stdout: '', stderr: '' } : args[0] === 'fetch'
    ? { status: 1, stdout: '', stderr: 'fixture stops before planning' } : gitRun(args, opts));
  const args = { root: f.root, env: f.env, log: { error() {} }, run, now: () => Date.now(), mainOnly: true };
  return { ...f, git, old, head, run, args };
}
function cloneBytes(root) {
  const files = {};
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path.slice(root.length)] = fs.readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return files;
}


function plannedFixture(f) {
  const plan = { ok: true, upToDate: false, finalSha: f.old, mainSha: f.head,
    inputsKey: 'fixture', applied: [], decisions: [], alerts: [] };
  vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [], refEvidence: new Map() });
  vi.spyOn(planner, 'planRebuild').mockResolvedValue(plan);
  return plan;
}

const mutationCases = [
  ['in-progress-rollback', f => writeRebuildState(f.root, { inProgress: {
    target: f.head, prevHead: f.old, startedAt: '2000-01-01T00:00:00Z',
  } }, f.env), f => expect(f.git(['rev-parse', 'HEAD'])).toBe(f.old)],
  ['unverified-rollback', f => writeRebuildState(f.root, { unverified: { head: f.head, prevHead: f.old } }, f.env),
    f => expect(f.git(['rev-parse', 'HEAD'])).toBe(f.old)],
  ['quarantine-reset', f => writeRebuildState(f.root, { quarantine: { prevHead: f.old } }, f.env),
    f => expect(f.git(['rev-parse', 'HEAD'])).toBe(f.old)],
  ['wrong-branch-heal', f => f.git(['checkout', '-qb', 'ops/review-requests']),
    f => expect(f.git(['symbolic-ref', '--short', 'HEAD'])).toBe('main')],
  ['index-lock-recovery', f => {
    const path = join(f.root, '.git', 'index.lock'); fs.writeFileSync(path, ''); fs.utimesSync(path, 1, 1);
  }, f => expect(fs.existsSync(join(f.root, '.git', 'index.lock'))).toBe(false)],
  ['dirty-tree-recovery', f => {
    fs.mkdirSync(join(f.root, 'scripts', 'conveyor'), { recursive: true });
    fs.writeFileSync(join(f.root, 'scripts/conveyor/run-scorecards.json'), '{"records":[]}');
    f.git(['add', '.']); f.git(['commit', '-qm', 'state file']);
    f.git(['update-ref', 'refs/remotes/origin/main', f.git(['rev-parse', 'HEAD'])]);
    fs.writeFileSync(join(f.root, 'scripts/conveyor/run-scorecards.json'), '{"records":[{"id":"test"}]}');
  }, f => expect(f.git(['status', '--porcelain', '--untracked-files=no'])).toBe('')],
  ['clone-ref-repair', f => {
    fs.mkdirSync(join(f.root, '.git/refs/remotes/origin'), { recursive: true });
    fs.writeFileSync(join(f.root, '.git/refs/remotes/origin/broken'), 'a'.repeat(40) + '\n');
  }, f => expect(fs.existsSync(join(f.root, '.git/refs/remotes/origin/broken'))).toBe(false)],
  ['backlog-sidecar-prune', f => {
    fs.mkdirSync(join(f.root, 'backlog'));
    fs.writeFileSync(join(f.root, 'backlog/123-landed.md'), '---\nnum: 123\nbornAs: xabc123\n---\n');
    f.git(['add', '.']); f.git(['commit', '-qm', 'landed']);
    f.head = f.git(['rev-parse', 'HEAD']);
    f.git(['update-ref', 'refs/remotes/origin/main', f.head]);
    fs.writeFileSync(join(f.root, 'backlog/xabc123-sidecar.md'), 'untracked sidecar');
    plannedFixture(f);
  }, f => expect(fs.existsSync(join(f.root, 'backlog/xabc123-sidecar.md'))).toBe(false)],
  ['ready-candidate-adopt', f => {
    const plan = plannedFixture(f);
    writeReadyCandidate(f.root, { prevHead: f.head, adopt: plan }, f.env);
    vi.spyOn(adoption, 'matchReadyCandidate').mockReturnValue({ adopt: plan, dropRefs: [], match: 'exact' });
    vi.spyOn(adoption, 'finalizeRebuild').mockResolvedValue({ moved: true, adopted: true });
  }, () => expect(adoption.finalizeRebuild).toHaveBeenCalledOnce()],
  ['skip-unrelated-adopt', f => {
    plannedFixture(f);
    writeRebuildState(f.root, { adopted: { head: f.head } }, f.env);
    f.args.skipCheck = () => ({ skip: true, reason: 'fixture' });
    vi.spyOn(adoption, 'finalizeRebuild').mockResolvedValue({ moved: true, adopted: true });
  }, () => expect(adoption.finalizeRebuild).toHaveBeenCalledOnce()],
  ['clone-reclone', f => {
    vi.spyOn(repair, 'diagnoseLane').mockReturnValue({ ok: false, problems: ['history unreadable'] });
    vi.spyOn(repair, 'repairCloneRefs').mockImplementation(() => {
      fs.writeFileSync(join(f.root, 'file'), 'replacement');
      return { ok: true, pruned: [], reported: [], reportedNew: [], problems: [], quarantinedTo: 'fixture-quarantine' };
    });
  }, f => expect(fs.readFileSync(join(f.root, 'file'), 'utf8')).toBe('replacement')],
];

describe('ready-only preparation defers clone mutations to the normal tick', () => {
  it.each([false, true])('readyOnly allows a reported dangling non-remote ref (diagnosis message: %s)', async withDiagnosis => {
    const f = prepareFixture();
    const path = join(f.root, '.git/refs/heads/dangling');
    fs.writeFileSync(path, 'a'.repeat(40) + '\n');
    vi.spyOn(repair, 'diagnoseLane').mockReturnValue(withDiagnosis
      ? { ok: false, problems: ['1 ref(s) point at missing objects'] }
      : { ok: true, problems: [] });
    const plan = plannedFixture(f);
    const before = cloneBytes(f.root);
    const r = await prepareRebuild({ ...f.args, readyOnly: true });
    expect(r.result?.reason).not.toBe('readonly-job-mutation-due');
    expect(r.result?.mutation).not.toBe('clone-reclone');
    expect(r).toMatchObject({ terminal: false, plan, lease: { token: expect.any(String) } });
    expect(cloneBytes(f.root)).toEqual(before);
  });

  it('readyOnly still defers pruning a dangling remote ref that is not the HEAD symref', async () => {
    const f = prepareFixture();
    expect(f.git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    const path = join(f.root, '.git/refs/remotes/origin/dangling');
    fs.writeFileSync(path, 'a'.repeat(40) + '\n');
    const before = cloneBytes(f.root);
    expect(await prepareRebuild({ ...f.args, readyOnly: true })).toMatchObject({
      terminal: true, result: { reason: 'readonly-job-mutation-due', mutation: 'clone-ref-repair' },
    });
    expect(cloneBytes(f.root)).toEqual(before);
  });

  it('readyOnly prepare queues the job with untracked backlog/xabc123-unlanded.md without bornAs on origin/main or a collision', async () => {
    const f = prepareFixture();
    const plan = plannedFixture(f);
    const path = 'backlog/xabc123-unlanded.md';
    fs.mkdirSync(join(f.root, 'backlog'));
    fs.writeFileSync(join(f.root, path), 'unlanded sidecar');
    const before = cloneBytes(f.root);
    const r = await prepareRebuild({ ...f.args, readyOnly: true });
    expect(r.result?.reason).not.toBe('readonly-job-mutation-due');
    expect(r).toMatchObject({ terminal: false, plan, lease: { token: expect.any(String) } });
    expect(readRebuildState(f.root, f.env).building.token).toBe(r.lease.token);
    expect(r.alerts).toContainEqual({ kind: 'untracked-kept', detail: { paths: [path] } });
    expect(cloneBytes(f.root)).toEqual(before);
  });

  it('readyOnly prepare defers pruning a landed backlog sidecar without changing clone bytes', async () => {
    const f = prepareFixture();
    mutationCases.find(([mutation]) => mutation === 'backlog-sidecar-prune')[1](f);
    const before = cloneBytes(f.root);
    expect(await prepareRebuild({ ...f.args, readyOnly: true })).toMatchObject({
      terminal: true, result: { reason: 'readonly-job-mutation-due', mutation: 'backlog-sidecar-prune' },
    });
    expect(planner.planRebuild).not.toHaveBeenCalled();
    expect(cloneBytes(f.root)).toEqual(before);
  });

  it.each(mutationCases)('readyOnly preserves every clone byte for %s', async (mutation, setup) => {
    const f = prepareFixture(); setup(f);
    const before = cloneBytes(f.root);
    const state = readRebuildState(f.root, f.env);
    const r = await prepareRebuild({ ...f.args, readyOnly: true });
    expect(r).toMatchObject({ terminal: true, result: {
      moved: false, reason: 'readonly-job-mutation-due', mutation,
    } });
    expect(cloneBytes(f.root)).toEqual(before);
    expect(readRebuildState(f.root, f.env)).toEqual(state);
  });

  it.each(mutationCases)('normal prepare still performs %s', async (_mutation, setup, check) => {
    const f = prepareFixture(); setup(f);
    const r = await prepareRebuild({ ...f.args, readyOnly: false });
    expect(r.result?.reason).not.toBe('readonly-job-mutation-due');
    check(f);
  });

  it.each(['unreadable refs', 'incomplete refs', 'unreadable diagnosis', 'incomplete diagnosis', 'failed commit-graph verify'])(
    'fails closed on %s without attempting repair', async evidence => {
      const f = prepareFixture();
      let mutation;
      if (evidence === 'unreadable refs') {
        vi.spyOn(repair, 'probeBrokenRefs').mockReturnValue({ broken: [], probeFailed: true });
        mutation = 'clone-ref-repair';
      } else if (evidence === 'incomplete refs') {
        vi.spyOn(repair, 'probeBrokenRefs').mockReturnValue({ broken: [] });
        mutation = 'clone-ref-repair';
      } else if (evidence === 'incomplete diagnosis') {
        vi.spyOn(repair, 'diagnoseLane').mockReturnValue({ ok: true });
        mutation = 'clone-reclone';
      } else if (evidence === 'unreadable diagnosis') {
        vi.spyOn(repair, 'diagnoseLane').mockImplementation(() => { throw new Error('unreadable'); });
        mutation = 'clone-repair-unverified';
      } else {
        const run = f.args.run;
        f.args.run = (args, opts) => args[0] === 'commit-graph' ? { status: 1 } : run(args, opts);
        mutation = 'clone-commit-graph-repair';
      }
      const repairCall = vi.spyOn(repair, 'repairCloneRefs');
      const before = cloneBytes(f.root);
      expect(await prepareRebuild({ ...f.args, readyOnly: true })).toMatchObject({
        terminal: true, result: { moved: false, reason: 'readonly-job-mutation-due', mutation },
      });
      expect(repairCall).not.toHaveBeenCalled();
      expect(cloneBytes(f.root)).toEqual(before);
    });

  it('fails closed when index-lock evidence cannot be read', async () => {
    const f = prepareFixture();
    const path = join(f.root, '.git/index.lock');
    fs.symlinkSync('index.lock', path); // ELOOP, portable without relying on host permissions.
    expect(await prepareRebuild({ ...f.args, readyOnly: true })).toMatchObject({
      terminal: true, result: { moved: false, reason: 'readonly-job-mutation-due', mutation: 'index-lock-unverified' },
    });
    expect(fs.readlinkSync(path)).toBe('index.lock');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('retains read-only preparation and bookkeeping on a healthy clone', async () => {
    const f = prepareFixture();
    const plan = plannedFixture(f); plan.upToDate = true; plan.finalSha = f.head;
    const before = cloneBytes(f.root);
    expect(await prepareRebuild({ ...f.args, readyOnly: true })).toMatchObject({
      terminal: true, result: { moved: false, reason: 'up-to-date' },
    });
    expect(readRebuildState(f.root, f.env).adopted.head).toBe(f.head);
    expect(cloneBytes(f.root)).toEqual(before);
  });

  it('rebuildClone passes readyOnly through its write lock before recovery', async () => {
    const f = prepareFixture(); mutationCases[0][1](f);
    const before = cloneBytes(f.root);
    const r = await rebuildClone({ ...f.args, readyOnly: true, asJob: false });
    expect(r).toMatchObject({ moved: false, reason: 'readonly-job-mutation-due', mutation: 'in-progress-rollback' });
    expect(cloneBytes(f.root)).toEqual(before);
  });

  it.each([
    ['ready-only parses injected env', true, ' , Mac:60796, Mac:333 , ', undefined, true],
    ['normal rebuild ignores env', false, 'Mac:60796', undefined, false],
    ['ready-only ignores process env when injected env is empty', true, undefined, undefined, false],
    ['explicit empty list overrides env', true, 'Mac:60796', [], false],
    ['explicit list replaces env', true, 'Mac:60796', ['Mac:333'], false],
    ['explicit list can allow the spawner', true, 'Mac:333', ['Mac:60796'], true],
  ])('%s', async (_label, readyOnly, envValue, ignoreOwners, admitted) => {
    const f = prepareFixture(); mutationCases[0][1](f);
    f.read('Mac:60796', 60796);
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', !readyOnly || envValue === undefined ? 'Mac:60796' : 'Mac:999');
    const env = { ...f.env, WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS: envValue };
    const { ignoreOwners: _ignored, ...lockOpts } = f.opts;
    const before = cloneBytes(f.root);
    const r = await rebuildClone({ ...f.args, env, readyOnly, asJob: false, versions: null,
      lockOpts: { ...lockOpts, owner: 'Mac:12154', ...(ignoreOwners === undefined ? {} : { ignoreOwners }) },
    });
    expect(r).toMatchObject(admitted
      ? { moved: false, reason: 'readonly-job-mutation-due', mutation: 'in-progress-rollback' }
      : { moved: false, reason: 'tick-in-progress', heldBy: 'Mac:60796' });
    expect(cloneBytes(f.root)).toEqual(before);
    if (!admitted) expect(f.run).not.toHaveBeenCalled();
    expect(readLockEntry(cloneLockDirs(f.root, f.lockRoot).readersRoot, 'Mac:60796')).not.toBeNull();
  });
});
