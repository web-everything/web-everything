import { it, expect, vi } from 'vitest';
import { runFeedLoop, NEEDS_YOU_FEED_KIND, ensureNeedsYouFeedJob, superviseNeedsYouFeed } from '../needs-you-feed-job.mjs';
import { createJobStore, selfHandle } from '../../lib/daemon-jobs-runtime.mjs';
import { markLaunching, markClaimed } from '../../lib/daemon-jobs.mjs';
import { resolveSettings } from '../../operations/needs-you-feed.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const identity = selfHandle({ readStart: () => 'Thu Oct 15 12:00:00 2026' });
it('survives errors and stops before another read when superseded', async () => {
  const run = vi.fn().mockRejectedValueOnce(Error('read failed')).mockResolvedValue({});
  const owns = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
  const log = vi.fn();
  await runFeedLoop({ run, owns, log, sleep: async () => {}, intervalMs: 1 });
  expect(run).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledWith(expect.stringContaining('read failed'));
});
it('reuses sampler singleton and supersession with a readonly pinned kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-job-'));
  try {
    const store = createJobStore(dir), args = { store, codeSha: 'a'.repeat(40), now: Date.now(), input: { intervalMs: 120000 } };
    const first = ensureNeedsYouFeedJob(args);
    expect(NEEDS_YOU_FEED_KIND.codeMode).toBe('readonly-tree');
    expect(ensureNeedsYouFeedJob(args).enqueued).toBe(false);
    const retired = vi.fn(); const next = ensureNeedsYouFeedJob({ ...args, codeSha: 'b'.repeat(40), retire: retired });
    expect(next.enqueued).toBe(true); expect(retired).toHaveBeenCalled();
    expect(store.read(first.record.id).job.status).toBe('failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('does not create a job when disabled and logs resolved settings', async () => {
  const log = vi.fn(), dir = mkdtempSync(join(tmpdir(), 'feed-disabled-'));
  try {
    expect(await superviseNeedsYouFeed({ dir, env: { WE_NEEDS_YOU_FEED_ENABLED: '0' }, log })).toEqual({ disabled: true });
    expect(log).toHaveBeenCalledWith('needs-you-feed enabled=false source=env');
    expect(createJobStore(dir).list().records).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['env', 'settings', 'invalid feed path'])('disabling via %s retires running and queued jobs without launching a replacement', async source => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-disable-live-'));
  try {
    const store = createJobStore(dir), now = Date.now(), at = new Date(now).toISOString();
    const args = { store, codeSha: 'a'.repeat(40), now };
    const running = ensureNeedsYouFeedJob(args).record;
    store.update(running.id, r => markLaunching(r, { at }));
    store.update(running.id, r => markClaimed(r, { at, ...identity }));
    // A queue entry can coexist with a running job after an interrupted supervisor tick.
    const queued = { ...running, id: `${running.id}-queued` };
    store.create(queued);
    const retire = vi.fn(), reattach = vi.fn();
    const settings = resolveSettings({ env: source === 'env' ? { WE_NEEDS_YOU_FEED_ENABLED: '0' }
      : source === 'invalid feed path' ? { WE_NEEDS_YOU_FEED_ENABLED: '0', WE_NEEDS_YOU_FEED: join(dir, 'needs-you-ack') } : {},
      file: source === 'settings' ? { enabled: false } : {} });
    expect(await superviseNeedsYouFeed({ dir, checkoutRoot: dir, settings, retire, reattach, log: () => {} })).toEqual({ disabled: true });
    expect(store.list().records).toHaveLength(2);
    expect(store.read(running.id).job).toMatchObject({ status: 'failed', handle: null });
    expect(store.read(queued.id).job.status).toBe('failed');
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ id: running.id,
      job: expect.objectContaining({ handle: identity.handle }) }));
    expect(reattach).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('disabling retries a failed retirement on the next tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-disable-retry-'));
  try {
    const store = createJobStore(dir), at = new Date().toISOString();
    const { record } = ensureNeedsYouFeedJob({ store, codeSha: 'a'.repeat(40) });
    store.update(record.id, r => markLaunching(r, { at }));
    store.update(record.id, r => markClaimed(r, { at, ...identity }));
    const retire = vi.fn().mockImplementationOnce(() => { throw Error('signal failed'); });
    const options = { dir, checkoutRoot: dir, env: { WE_NEEDS_YOU_FEED_ENABLED: '0' }, retire, log: () => {} };
    await expect(superviseNeedsYouFeed(options)).rejects.toThrow('signal failed');
    expect(store.read(record.id).job).toMatchObject({ status: 'failed', retiredHandle: identity.handle });
    await superviseNeedsYouFeed(options);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(store.read(record.id).job.retiredHandle).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('provides dependencies for the queue subprocess inside a readonly snapshot', () => {
  expect(NEEDS_YOU_FEED_KIND.nodeModules).toBe(true);
});
it('counts queue-read time toward the polling interval', async () => {
  let time = 0; const sleep = vi.fn(async ms => { time += ms; });
  await runFeedLoop({ run: async () => { time += 40000; }, clock: () => time, sleep, maxIterations: 2, intervalMs: 120000 });
  expect(sleep).toHaveBeenCalledWith(80000);
});
it('leaves a cold snapshot queued and requests detached prewarming', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-warm-'));
  const requestPrewarm = vi.fn(() => ({ state: 'started' }));
  try {
    await superviseNeedsYouFeed({ dir, checkoutRoot: dir, codeSha: 'a'.repeat(40), env: {}, log: () => {},
      warmGate: { isWarm: () => false, requestPrewarm },
      reattach: async options => {
        const record = options.store.list().records[0];
        const result = options.launch({ store: options.store, id: record.id, kindDef: NEEDS_YOU_FEED_KIND });
        expect(result).toBeNull();
        expect(options.store.read(record.id).job.status).toBe('queued');
      } });
    expect(requestPrewarm).toHaveBeenCalledTimes(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
