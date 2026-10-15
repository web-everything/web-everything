import { it, expect, vi } from 'vitest';
import { runFeedLoop, NEEDS_YOU_FEED_KIND, ensureNeedsYouFeedJob, superviseNeedsYouFeed } from '../needs-you-feed-job.mjs';
import { createJobStore } from '../../lib/daemon-jobs-runtime.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const log = vi.fn();
  expect(await superviseNeedsYouFeed({ env: { WE_NEEDS_YOU_FEED_ENABLED: '0' }, log })).toEqual({ disabled: true });
  expect(log).toHaveBeenCalledWith('needs-you-feed enabled=false source=env');
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
