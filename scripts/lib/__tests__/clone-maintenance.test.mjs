import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireRead, acquireWrite, inspectCloneLock } from '../daemon-clone-lock.mjs';
import { maybeMaintainClone, maintenanceStampPath, resolveCloneMaintenanceSettings, cloneHasRebuildJob } from '../clone-maintenance.mjs';
import { createJobStore, enqueueJob } from '../daemon-jobs-runtime.mjs';
import { rebuildJobsDir, REBUILD_JOB_KIND } from '../daemon-rebuild/rebuild-job.mjs';
import { markSucceeded } from '../daemon-jobs.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'clone-maintenance-'));
  dirs.push(dir);
  const root = join(dir, 'clone');
  mkdirSync(join(root, '.git'), { recursive: true });
  const env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'), WE_DAEMON_JOBS_ROOT: join(dir, 'jobs'), WE_POLICY_CASCADE_LOG: '0' };
  const emitEvent = vi.fn();
  let time = Date.now();
  let measures = 0;
  const run = vi.fn(async (args, opts) => {
    expect(opts.cwd).toBe(root);
    expect(inspectCloneLock(root, { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT }).writerLive).toBe(true);
    if (args.includes('gc')) {
      expect(args).not.toContain('--prune=now');
      expect(args).not.toContain('--aggressive');
      expect(acquireRead(root, { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'competitor' }).ok).toBe(false);
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: `size: ${measures++ ? 2 : 10}\nsize-pack: 1\n` };
  });
  const o = { root, env, run, emitEvent, now: () => time, hasRebuildJob: () => false };
  return { ...o, o, advance: (ms) => { time += ms; } };
}
describe('clone maintenance', () => {
  it.each(['writer', 'reader'])('skips a held %s lock', async (kind) => {
    const f = fixture();
    const opts = { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'other' };
    if (kind === 'writer') await acquireWrite(f.root, opts); else acquireRead(f.root, opts);
    expect(await maybeMaintainClone(f.o)).toMatchObject({ skipped: true, reason: `${kind}-active` });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('holds the lock throughout gc, releases it, and emits measured bytes', async () => {
    const f = fixture();
    expect(await maybeMaintainClone(f.o)).toMatchObject({ clone: f.root, bytesBefore: 11264, bytesAfter: 3072, freed: 8192, durationMs: 0 });
    expect(f.run.mock.calls.some(([args]) => args.includes('gc'))).toBe(true);
    expect(inspectCloneLock(f.root, { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT }).writer).toBeNull();
    expect(f.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'clone-maintenance', detail: expect.objectContaining({ freed: 8192 }) }), { env: f.env });
  });
  it('persists a per-clone 24h limit and runs again at the interval', async () => {
    const f = fixture();
    await maybeMaintainClone(f.o);
    f.run.mockClear();
    f.advance(86400000 - 1);
    expect(await maybeMaintainClone({ ...f.o })).toMatchObject({ skipped: true, reason: 'rate-limited' });
    expect(f.run).not.toHaveBeenCalled();
    f.advance(1);
    expect((await maybeMaintainClone(f.o)).skipped).not.toBe(true);
  });
  it.each(['throw', 'nonzero'])('gc failure (%s) never throws, releases the lock and limits failed attempts too', async (failure) => {
    const f = fixture();
    f.run.mockImplementation(async (args) => {
      if (args.includes('gc')) {
        if (failure === 'throw') throw new Error('disk full');
        return { status: 1, stdout: '' };
      }
      return { status: 0, stdout: 'size: 1\nsize-pack: 0\n' };
    });
    expect(await maybeMaintainClone(f.o)).toMatchObject({ reason: 'gc-failed' });
    expect(inspectCloneLock(f.root, { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT }).writer).toBeNull();
    expect(await maybeMaintainClone(f.o)).toMatchObject({ reason: 'rate-limited' });
  });
  it.each([true, null])('fails closed on active or unknown rebuild state: %s', async (state) => {
    const f = fixture();
    expect(await maybeMaintainClone({ ...f.o, hasRebuildJob: () => state })).toMatchObject({ skipped: true });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('rechecks rebuild state under the write lock', async () => {
    const f = fixture();
    const hasRebuildJob = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    expect(await maybeMaintainClone({ ...f.o, hasRebuildJob })).toMatchObject({ reason: 'rebuild-active' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('checks real persisted rebuild jobs and ignores completed jobs', async () => {
    const f = fixture();
    expect(cloneHasRebuildJob(f.root, f.env)).toBe(false);
    const store = createJobStore(rebuildJobsDir(f.root, f.env));
    mkdirSync(store.dir, { recursive: true });
    const rec = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root: f.root } });
    expect(await maybeMaintainClone({ ...f.o, hasRebuildJob: undefined })).toMatchObject({ reason: 'rebuild-active' });
    store.update(rec.id, (r) => markSucceeded(r, { at: new Date().toISOString() }));
    expect(cloneHasRebuildJob(f.root, f.env)).toBe(false);
    writeFileSync(join(store.dir, `${rec.id}.json`), '{broken');
    expect(cloneHasRebuildJob(f.root, f.env)).toBe(true);
  });
  it('fails closed when the job store cannot be listed', async () => {
    const f = fixture();
    const path = rebuildJobsDir(f.root, f.env);
    mkdirSync(path, { recursive: true });
    rmSync(path, { recursive: true });
    writeFileSync(path, 'not a directory');
    expect(await maybeMaintainClone({ ...f.o, hasRebuildJob: undefined })).toMatchObject({ reason: 'rebuild-state-unreadable' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('honors the configured interval and keeps stamps separate per clone', async () => {
    const f = fixture();
    const o = { ...f.o, settings: { value: { intervalMs: 1000 } } };
    await maybeMaintainClone(o);
    f.advance(999);
    expect(await maybeMaintainClone(o)).toMatchObject({ reason: 'rate-limited' });
    f.advance(1);
    expect((await maybeMaintainClone(o)).skipped).not.toBe(true);
    expect(maintenanceStampPath(`${f.root}-other`, f.env)).not.toBe(maintenanceStampPath(f.root, f.env));
  });
  it('skips failed lock acquisition even after an idle snapshot', async () => {
    const f = fixture();
    const withLock = vi.fn(async (_root, _fn, opts) => {
      expect(opts.waitMs).toBe(0);
      return { ok: false, reason: 'concurrent-mover' };
    });
    expect(await maybeMaintainClone({ ...f.o, withLock })).toMatchObject({ skipped: true, reason: 'concurrent-mover' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['broken', ' '.repeat(1025)])('skips corrupt or oversized stamps with an operator-visible reason (%#)', async (content) => {
    const f = fixture();
    mkdirSync(f.env.WE_DAEMON_STATE_DIR, { recursive: true });
    writeFileSync(maintenanceStampPath(f.root, f.env), content);
    expect(await maybeMaintainClone(f.o)).toMatchObject({ reason: 'stamp-unreadable', skipped: true });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('refuses unknown measurements before gc', async () => {
    const f = fixture();
    f.run.mockResolvedValue({ status: 0, stdout: 'incomplete' });
    expect(await maybeMaintainClone(f.o)).toMatchObject({ reason: 'measurement-failed', skipped: true });
    expect(f.run.mock.calls.some(([args]) => args.includes('gc'))).toBe(false);
  });
  it('never runs gc if the attempt stamp cannot be persisted', async () => {
    const f = fixture();
    writeFileSync(f.env.WE_DAEMON_STATE_DIR, 'not a directory');
    expect(await maybeMaintainClone(f.o)).toMatchObject({ skipped: true });
    expect(f.run.mock.calls.some(([args]) => args.includes('gc'))).toBe(false);
  });
  it('resolves interval through standard, platform, tool, env; rejects oversized values', () => {
    expect(resolveCloneMaintenanceSettings({ env: {}, tool: {}, platform: {} }).value.intervalMs).toBe(86400000);
    const r = resolveCloneMaintenanceSettings({ env: { WE_DAEMON_CLONE_MAINTENANCE_INTERVAL_MS: '4000' }, tool: { intervalMs: 3000 }, platform: { intervalMs: 2000 } });
    expect(r.value.intervalMs).toBe(4000);
    expect(r.sources.intervalMs).toBe('env');
    expect(resolveCloneMaintenanceSettings({ env: {}, tool: { intervalMs: 3000 }, platform: { intervalMs: 2000 } }).sources.intervalMs).toBe('tool');
    expect(resolveCloneMaintenanceSettings({ env: { WE_DAEMON_CLONE_MAINTENANCE_INTERVAL_MS: '999999999999999999' }, tool: {}, platform: { intervalMs: 2000 } }).sources.intervalMs).toBe('platform');
  });
  it('packs real local Git objects with default prune and keeps recent unreachable data', async () => {
    const f = fixture();
    const git = (args, input) => execFileSync('git', args, { cwd: f.root, input, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['-c', 'user.name=Maintenance test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-qm', 'initial']);
    const blob = git(['hash-object', '-w', '--stdin'], 'recent unreachable content');
    const r = await maybeMaintainClone({ ...f.o, run: undefined, env: { ...process.env, ...f.env } });
    expect(r.reason).toBeUndefined();
    expect(r.bytesBefore).toBeGreaterThan(0);
    expect(r.bytesAfter).toBeGreaterThan(0);
    expect(git(['cat-file', '-p', blob])).toBe('recent unreachable content');
    expect(git(['count-objects', '-v'])).toMatch(/in-pack: [1-9]/);
  });
  it('skips a worktree gitfile instead of maintaining a shared repository', async () => {
    const f = fixture();
    rmSync(join(f.root, '.git'), { recursive: true });
    writeFileSync(join(f.root, '.git'), 'gitdir: elsewhere');
    expect(await maybeMaintainClone(f.o)).toMatchObject({ reason: 'shared-git-dir', skipped: true });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('event failure does not change the outcome', async () => {
    const f = fixture();
    expect(await maybeMaintainClone({ ...f.o, emitEvent: async () => { throw new Error('unavailable'); } })).toMatchObject({ freed: 8192 });
  });
  it('logs the effective interval and its policy source', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      resolveCloneMaintenanceSettings({ env: { WE_POLICY_CASCADE_LOG: '1', WE_DAEMON_CLONE_MAINTENANCE_INTERVAL_MS: '3456789' }, tool: {}, platform: {} });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('intervalMs=3456789 (env)'));
    } finally { log.mockRestore(); }
  });
});

describe('withSelfSync maintenance hook', () => {
  it.each(['up-to-date', 'rebuild-job-running'])('runs after adoption before the reader only when idle (%s)', async (reason) => {
    const order = [];
    const maintain = vi.fn(async () => { order.push('maintenance'); throw new Error('best effort'); });
    const effects = withSelfSync({ tickOnce: async () => { order.push('tick'); return 'ok'; } }, {
      root: '/fake-clone', env: {}, log: { error() {} }, readHead: () => 'same', readReady: () => null,
      rebuild: async () => { order.push('adoption'); return { reason }; },
      maintain, hasMaintenanceRebuildJob: () => reason !== 'up-to-date',
      acquireRead: () => { order.push('reader'); return { ok: true }; }, releaseRead() {},
      versions: null, background: null, cloneIdentity: () => 'same',
    });
    expect(await effects.tickOnce()).toBe('ok');
    expect(order).toEqual(reason === 'up-to-date' ? ['adoption', 'maintenance', 'reader', 'tick'] : ['adoption', 'reader', 'tick']);
  });
});
