/** Phase 7 red contracts: only the owner executes a detached job's deferred mutation, before queuing. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withSelfSync } from '../daemon-self-sync.mjs';
import { touchOwnerHeartbeat } from '../daemon-clone-lock.mjs';
import { cloneKey } from '../daemon-overlays.mjs';

const T = 1_800_000_000_000;
const MUTATION = { asJob: false, adoptOnly: true };
const normalResult = () => ({ moved: false, reason: 'rebuild-job-started', job: { id: 'job-next', status: 'queued' } });
let scratch, root, lockRoot, stateDir, env;
beforeEach(() => {
  scratch = fs.mkdtempSync(join(tmpdir(), 'self-sync-mutation-due-'));
  root = join(scratch, 'wev-review-daemon'); lockRoot = join(scratch, 'locks'); stateDir = join(scratch, 'state');
  fs.mkdirSync(root); fs.mkdirSync(stateDir);
  env = { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_STATE_DIR: stateDir,
    WE_DAEMON_REBUILD_AS_JOB: '1' };
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); fs.rmSync(scratch, { recursive: true, force: true }); });
// Reader injection contract: one latest FINISHED job, including its unabridged .result payload.
// Reading the job summary's finishedJobs alone loses result.mutation and discovers it after queuing.
const due = (id = 'job-old', mutation = 'clone-ref-repair') => ({ id, status: 'succeeded',
  finishedAt: new Date(T - 1).toISOString(), result: { moved: false, reason: 'readonly-job-mutation-due', mutation } });
// The handled-ID sidecar belongs beside other self-sync state, outside the clone and job-result files.
const marker = () => join(stateDir, `${cloneKey(root)}.mutation-due.json`);
function fixture(overrides = {}) {
  const latest = vi.fn(() => due());
  const rebuild = vi.fn(async (options) => options?.adoptOnly
    ? { moved: false, reason: 'needs-build' } : normalResult());
  const tick = vi.fn(() => 'ticked'), alert = vi.fn(), log = { error: vi.fn() };
  const options = { root, env, entries: ['review-daemon.mjs'], rebuild, readLatestRebuildJobResult: latest,
    rebuildAsJob: true, readHead: () => 'boot', readOriginRef: () => null, readState: () => ({}), readReady: () => null,
    versions: null, background: null, cloneIdentity: () => 'stable-clone', minRestartIntervalMs: 0,
    now: () => T, onRestart: vi.fn(), log, tickProgress: { alert, markTickDone: vi.fn() },
    diffFiles: () => ['shared.mjs'], importClosure: () => ({ complete: true, files: new Set(['shared.mjs']), jsonNames: new Set() }),
    ...overrides };
  return { synced: withSelfSync({ tickOnce: tick }, options), rebuild: options.rebuild,
    latest: options.readLatestRebuildJobResult, tick, alert, log };
}
const mutationCalls = (rebuild) => rebuild.mock.calls.filter(([options]) => options?.adoptOnly === true);
const startLine = (job) => `daemon-self-sync: readonly job ${job.id} deferred mutation ${job.result.mutation}; running it on the owning tick`;

describe('owner handoff of readonly rebuild-job mutations', () => {
  it.each(['throws', 'reader-priority'])('retries a pending mutation after %s and marks only its successful retry', async (failure) => {
    let attempts = 0;
    const rebuild = vi.fn(async (options) => {
      if (!options?.adoptOnly) return normalResult();
      if (++attempts === 1) {
        if (failure === 'throws') throw new Error('retry me');
        return { moved: false, reason: failure };
      }
      return { moved: false, reason: 'needs-build' };
    });
    const w = fixture({ rebuild });
    await w.synced.tickOnce();
    expect(fs.existsSync(marker())).toBe(false);
    await w.synced.tickOnce(); await w.synced.tickOnce();
    expect(mutationCalls(rebuild)).toHaveLength(2);
    expect(fs.readFileSync(marker(), 'utf8')).toContain('job-old');
  });
  it.each(['clone-ref-repair', 'clone-reclone', 'index-lock-recovery', 'dirty-tree-recovery'])('owner runs deferred %s once before normal discovery queues the next job', async (mutation) => {
    const job = due(`job-${mutation}`, mutation);
    const w = fixture({ readLatestRebuildJobResult: vi.fn(() => job) });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.rebuild.mock.calls).toEqual([[MUTATION], []]);
    expect(w.latest).toHaveBeenCalled();
    expect(w.log.error).toHaveBeenCalledWith(startLine(job));
    expect(w.tick).toHaveBeenCalledOnce();
  });
  it('the mutation completes before a new detached job can be queued', async () => {
    const started = Promise.withResolvers(), release = Promise.withResolvers(), queued = Promise.withResolvers();
    const events = [];
    const rebuild = vi.fn(async (options) => {
      if (options?.adoptOnly) {
        events.push('mutation-started'); started.resolve('mutation-started');
        await release.promise; events.push('mutation-finished');
        return { moved: false, reason: 'needs-build' };
      }
      events.push('job-queued'); queued.resolve('job-queued'); return normalResult();
    });
    const w = fixture({ rebuild }); const executing = w.synced.tickOnce();
    try {
      expect(await Promise.race([started.promise, queued.promise])).toBe('mutation-started');
      expect(events).toEqual(['mutation-started']);
      release.resolve(); await executing;
      expect(events).toEqual(['mutation-started', 'mutation-finished', 'job-queued']);
      expect(rebuild.mock.calls).toEqual([[MUTATION], []]);
    } finally { release.resolve(); await executing; }
  });
  it('the same finished job is handled once across repeated owner ticks', async () => {
    const w = fixture();
    await w.synced.tickOnce(); await w.synced.tickOnce(); await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[MUTATION], [], [], []]);
    expect(w.log.error.mock.calls.filter(([line]) => line === startLine(due()))).toHaveLength(1);
  });
  it('a different finished job id gets its own mutation attempt', async () => {
    let job = due('first'); const w = fixture({ readLatestRebuildJobResult: vi.fn(() => job) });
    await w.synced.tickOnce(); job = due('second', 'dirty-tree-recovery');
    await w.synced.tickOnce(); await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[MUTATION], [], [MUTATION], [], []]);
  });
  it('handling a new job never permits a previously handled job id to loop again in this process', async () => {
    let job = due('first'); const w = fixture({ readLatestRebuildJobResult: vi.fn(() => job) });
    await w.synced.tickOnce(); job = due('second'); await w.synced.tickOnce();
    job = due('first'); await w.synced.tickOnce();
    expect(mutationCalls(w.rebuild)).toHaveLength(2);
    expect(w.rebuild.mock.calls).toEqual([[MUTATION], [], [MUTATION], [], []]);
  });
  it('publishes the handled job id atomically next to self-sync state', async () => {
    const original = fs.renameSync, publications = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === marker()) {
        expect(String(from)).not.toBe(marker());
        expect(dirname(String(from))).toBe(stateDir);
        publications.push(JSON.parse(fs.readFileSync(from, 'utf8')));
      }
      return original(from, to);
    });
    syncBuiltinESMExports();
    const w = fixture(); await w.synced.tickOnce();
    expect(mutationCalls(w.rebuild)).toEqual([[MUTATION]]);
    expect(publications).toHaveLength(1);
    expect(JSON.stringify(publications[0])).toContain('job-old');
    expect(JSON.stringify(JSON.parse(fs.readFileSync(marker(), 'utf8')))).toContain('job-old');
  });
  it('the handled job id survives a real daemon process restart', () => {
    const syncUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-self-sync.mjs')).href;
    const script = `
      const [url, root, lockRoot, stateDir, encodedJob] = process.argv.slice(1);
      const { withSelfSync } = await import(url);
      const calls = [];
      const daemon = withSelfSync({ tickOnce: () => 'ticked' }, {
        root, env: { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_STATE_DIR: stateDir, WE_DAEMON_REBUILD_AS_JOB: '1' },
        entries: ['review-daemon.mjs'], rebuildAsJob: true,
        readLatestRebuildJobResult: () => JSON.parse(encodedJob),
        rebuild: async (options) => { calls.push(options ?? null); return options?.adoptOnly
          ? { moved: false, reason: 'needs-build' } : { moved: false, reason: 'rebuild-job-started', job: { id: 'next', status: 'queued' } }; },
        readHead: () => 'boot', readOriginRef: () => null, readState: () => ({}), readReady: () => null,
        versions: null, background: null, cloneIdentity: () => 'stable-clone', now: () => 1800000000000,
        minRestartIntervalMs: 0, onRestart() {}, log: { error() {} },
      });
      await daemon.tickOnce(); process.stdout.write(JSON.stringify(calls));
    `;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', script,
      syncUrl, root, lockRoot, stateDir, JSON.stringify(due())], {
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: scratch },
    });
    const first = run(); expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual([MUTATION, null]);
    const second = run(); expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual([null]);
  });
  it.each(['{broken', '{}', 'directory'])('unreadable handled-ID state (%s) is unhandled but never retries a job within this process', async (contents) => {
    if (contents === 'directory') fs.mkdirSync(marker()); else fs.writeFileSync(marker(), contents);
    const job = due(`unreadable-${contents}`);
    const reader = vi.fn(() => job);
    const first = fixture({ readLatestRebuildJobResult: reader });
    await first.synced.tickOnce(); await first.synced.tickOnce();
    // Even another wrapper in the SAME process must not repeat a failed marker write.
    const second = fixture({ readLatestRebuildJobResult: reader }); await second.synced.tickOnce();
    expect(mutationCalls(first.rebuild)).toEqual([[MUTATION]]);
    expect(mutationCalls(second.rebuild)).toEqual([]);
    expect(first.rebuild.mock.calls.filter((args) => args.length === 0)).toHaveLength(2);
    expect(second.rebuild.mock.calls).toEqual([[]]);
  });
  it.each(['throws', 'tick-in-progress', 'reader-priority', 'dirty'])('a mutation that %s stays pending and retries once on each tick', async (failure) => {
    const job = due(`failed-${failure}`);
    const rebuild = vi.fn(async (options) => {
      if (!options?.adoptOnly) return normalResult();
      if (failure === 'throws') throw new Error('mutation failed');
      return { moved: false, reason: failure };
    });
    const w = fixture({ rebuild, readLatestRebuildJobResult: vi.fn(() => job) });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(rebuild.mock.calls).toEqual([[MUTATION], [], [MUTATION], []]);
    expect(fs.existsSync(marker())).toBe(false);
    expect(w.alert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(w.alert.mock.calls[0])).toContain(job.id);
    expect(JSON.stringify(w.alert.mock.calls[0])).toContain(job.result.mutation);
    const failedLogs = w.log.error.mock.calls.filter(([line]) => String(line).includes(job.id)
      && /mutation/i.test(String(line)) && /fail|refus|tick-in-progress|reader-priority|dirty/i.test(String(line)));
    // Exclude the required start line, whose job id may itself include a failure word.
    expect(failedLogs.filter(([line]) => line !== startLine(job))).toHaveLength(2);
  });
  it('a non-owner never reads finished jobs, mutates, queues jobs, or writes the handled-ID marker', async () => {
    touchOwnerHeartbeat(root, { lockRoot, nowMs: T });
    const w = fixture({ entries: ['pass-daemon.mjs'] });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.latest).not.toHaveBeenCalled(); expect(w.rebuild).not.toHaveBeenCalled();
    expect(fs.existsSync(marker())).toBe(false);
    expect(w.alert).not.toHaveBeenCalled();
  });
  it('an inline owner keeps ordinary discovery instead of replaying a detached-job handoff', async () => {
    const w = fixture({ rebuildAsJob: false }); await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]); expect(w.latest).not.toHaveBeenCalled();
  });
  it('an unreadable latest job result causes no mutation or crash and ordinary discovery continues', async () => {
    const w = fixture({ readLatestRebuildJobResult: vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }) });
    await expect(w.synced.tickOnce()).resolves.toBe('ticked');
    expect(w.rebuild.mock.calls).toEqual([[]]);
  });
  it.each([null, {}, { id: 'missing-result', status: 'succeeded' },
    { ...due('missing-mutation'), result: { reason: 'readonly-job-mutation-due' } },
    { ...due('running'), status: 'running', finishedAt: null },
  ])('incomplete/nonterminal latest result %# cannot authorize a mutation', async (job) => {
    const w = fixture({ readLatestRebuildJobResult: vi.fn(() => job) }); await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
  });
  it.each(['up-to-date', 'smoke-rejected', 'ready-recorded', 'needs-build'])('a latest finished result of %s never replays an older mutation', async (reason) => {
    const job = { ...due('newer-job'), result: { moved: false, reason } };
    const w = fixture({ readLatestRebuildJobResult: vi.fn(() => job) }); await w.synced.tickOnce();
    expect(w.rebuild.mock.calls).toEqual([[]]);
    expect(w.alert).not.toHaveBeenCalled();
  });
});


describe('deferred mutation handoff audit regressions', () => {
  it('only the owner performs adopt-only mutation and completes it before queuing a new job', async () => {
    touchOwnerHeartbeat(root, { lockRoot, nowMs: T });
    const job = due('audit-owner-order');
    const started = Promise.withResolvers(), release = Promise.withResolvers(), queued = Promise.withResolvers();
    const events = [];
    const rebuild = vi.fn(async (options) => {
      if (options?.adoptOnly) {
        events.push('mutation-started'); started.resolve('mutation-started');
        await release.promise; events.push('mutation-completed');
        return { moved: false, reason: 'needs-build' };
      }
      events.push('job-queued'); queued.resolve('job-queued'); return normalResult();
    });
    const owner = fixture({ rebuild, readLatestRebuildJobResult: vi.fn(() => job) });
    const nonOwner = fixture({ entries: ['pass-daemon.mjs'], readLatestRebuildJobResult: vi.fn(() => job) });
    const executing = owner.synced.tickOnce();
    try {
      expect(await Promise.race([started.promise, queued.promise])).toBe('mutation-started');
      await expect(nonOwner.synced.tickOnce()).resolves.toBe('ticked');
      expect(nonOwner.latest).not.toHaveBeenCalled();
      expect(nonOwner.rebuild).not.toHaveBeenCalled();
      expect(nonOwner.alert).not.toHaveBeenCalled();
      expect(rebuild.mock.calls).toEqual([[MUTATION]]);
      expect(events).toEqual(['mutation-started']);
      release.resolve(); await expect(executing).resolves.toBe('ticked');
      expect(rebuild.mock.calls).toEqual([[MUTATION], []]);
      expect(events).toEqual(['mutation-started', 'mutation-completed', 'job-queued']);
    } finally { release.resolve(); await executing; }
  });

  it('persisted handled IDs suppress mutation across wrapper recreation without a previous in-memory attempt', async () => {
    const job = due('audit-persisted-before-process-attempt');
    // This ID has never entered the module's process guard: only the persisted evidence can suppress it.
    fs.writeFileSync(marker(), JSON.stringify({ handledJobIds: [job.id] }));
    const original = fixture({ readLatestRebuildJobResult: vi.fn(() => job) });
    await expect(original.synced.tickOnce()).resolves.toBe('ticked');
    const recreated = fixture({ readLatestRebuildJobResult: vi.fn(() => job) });
    await expect(recreated.synced.tickOnce()).resolves.toBe('ticked');
    expect(original.latest).toHaveBeenCalled(); expect(recreated.latest).toHaveBeenCalled();
    expect(original.rebuild.mock.calls).toEqual([[]]);
    expect(recreated.rebuild.mock.calls).toEqual([[]]);
    expect(original.alert).not.toHaveBeenCalled(); expect(recreated.alert).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toEqual({ handledJobIds: [job.id] });
  });

  it.each(['read-EACCES', 'rename-EACCES', 'read-and-rename-EACCES'])(
    'concurrent wrappers attempt one mutation and await its completion with marker %s', async (failure) => {
      const job = due(`audit-concurrent-${failure}`);
      const originalRead = fs.readFileSync, originalRename = fs.renameSync;
      const faults = { reads: 0, writes: 0 };
      vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
        if (String(path) === marker() && failure !== 'rename-EACCES') {
          faults.reads += 1; throw Object.assign(new Error('marker read denied'), { code: 'EACCES' });
        }
        return originalRead(path, ...args);
      });
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to, ...args) => {
        if (String(to) === marker() && failure !== 'read-EACCES') {
          faults.writes += 1; throw Object.assign(new Error('marker write denied'), { code: 'EACCES' });
        }
        return originalRename(from, to, ...args);
      });
      syncBuiltinESMExports();
      const started = Promise.withResolvers(), release = Promise.withResolvers(), queued = Promise.withResolvers();
      const secondRead = Promise.withResolvers();
      const events = [];
      const rebuild = vi.fn(async (options) => {
        if (options?.adoptOnly) {
          events.push('mutation-started'); started.resolve('mutation-started');
          await release.promise; events.push('mutation-completed');
          return { moved: false, reason: 'needs-build' };
        }
        events.push('job-queued'); queued.resolve('job-queued'); return normalResult();
      });
      const first = fixture({ rebuild, readLatestRebuildJobResult: vi.fn(() => job) });
      const second = fixture({ rebuild, readLatestRebuildJobResult: vi.fn(() => { secondRead.resolve(); return job; }) });
      const firstTick = first.synced.tickOnce();
      let secondTick = Promise.resolve();
      try {
        expect(await Promise.race([started.promise, queued.promise])).toBe('mutation-started');
        secondTick = second.synced.tickOnce(); await secondRead.promise;
        // Both wrappers have observed this job while the first mutation is deliberately held open.
        expect(rebuild.mock.calls).toEqual([[MUTATION]]);
        expect(events).toEqual(['mutation-started']);
        release.resolve();
        await expect(Promise.all([firstTick, secondTick])).resolves.toEqual(['ticked', 'ticked']);
        expect(rebuild.mock.calls).toEqual([[MUTATION], [], []]);
        expect(events).toEqual(['mutation-started', 'mutation-completed', 'job-queued', 'job-queued']);
        if (failure !== 'rename-EACCES') expect(faults.reads).toBeGreaterThan(0);
        if (failure !== 'read-EACCES') {
          expect(faults.writes).toBe(1);
          expect(fs.existsSync(marker())).toBe(false); // persistence failed; retry suppression must be in-process
        }
        const recreated = fixture({ rebuild, readLatestRebuildJobResult: vi.fn(() => job) });
        await expect(recreated.synced.tickOnce()).resolves.toBe('ticked');
        expect(rebuild.mock.calls).toEqual([[MUTATION], [], [], []]);
        expect(mutationCalls(rebuild)).toHaveLength(1);
        expect(first.alert).not.toHaveBeenCalled(); expect(second.alert).not.toHaveBeenCalled();
      } finally { release.resolve(); await Promise.allSettled([firstTick, secondTick]); }
    },
  );
});
