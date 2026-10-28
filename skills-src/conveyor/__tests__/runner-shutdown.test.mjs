// @vitest-environment node
import { expect, it, vi } from 'vitest';
import b from '../../../scripts/conveyor/soak/breaks/runner-shutdown-abandons-passes.mjs';
import { makeBackgroundMechanicalPasses } from '../runner.mjs';

it.each(['once', 'max-ticks', 'idle-stop', 'lease-lost', 'error', 'emit-error', 'heartbeat-error',
  'sleep-error', 'restart', 'SIGTERM', 'SIGINT', 'SIGTERM-twice', 'SIGINT-twice',
  'daemon-SIGTERM', 'daemon-SIGINT', 'daemon-sleep-error'])(
  '%s drains CLI pass batches before exit while subsequent ticks stay independent', async mode => {
    const report = await b.run({ mode, log: console.log });
    expect(b.judge(report)).toEqual([]);
  }, 15_000,
);

it('logs a rejected batch, drains its pending sibling, and admits no new batches while closing', async () => {
  const held = Promise.withResolvers();
  const logged = Promise.withResolvers();
  const error = vi.spyOn(console, 'error').mockImplementation(() => logged.resolve());
  let calls = 0;
  const launch = makeBackgroundMechanicalPasses(() => {
    if (++calls === 1) throw new Error('fixture pass failure');
    return held.promise;
  });
  launch();
  launch();
  const drained = launch.drain();
  let finished = false;
  drained.then(() => { finished = true; });
  try {
    await logged.promise;
    expect(error).toHaveBeenCalledWith(expect.stringContaining('fixture pass failure'));
    expect(finished).toBe(false);
    launch();
    held.resolve();
    await drained;
    expect(calls).toBe(2);
  } finally {
    held.resolve();
    await drained;
    error.mockRestore();
  }
});
