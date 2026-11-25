/** @file RS-7179-1: codex-direct-task renews the lane lease while it runs, and stops after (also on throw). */
import { describe, it, expect } from 'vitest';
import { withLaneLeaseHeartbeat } from '../codex-direct-task.mjs';

describe('withLaneLeaseHeartbeat', () => {
  it('runs the heartbeat during the task and stops it after', async () => {
    const log = [];
    const out = await withLaneLeaseHeartbeat(['a', 'b'], async () => { log.push('run'); return 7; },
      ({ cwds }) => { log.push(`start:${cwds.join(',')}`); return () => log.push('stop'); });
    expect(out).toBe(7);
    expect(log).toEqual(['start:a,b', 'run', 'stop']);
  });
  it('stops the heartbeat when the task throws', async () => {
    const log = [];
    await expect(withLaneLeaseHeartbeat(['a'], async () => { throw new Error('boom'); }, () => () => log.push('stop'))).rejects.toThrow('boom');
    expect(log).toEqual(['stop']);
  });
  it('still runs the task when the heartbeat cannot start', async () => {
    expect(await withLaneLeaseHeartbeat(['a'], async () => 1, () => { throw new Error('x'); })).toBe(1);
  });
});
