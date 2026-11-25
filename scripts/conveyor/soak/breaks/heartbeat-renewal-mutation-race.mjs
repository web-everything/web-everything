import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { renewLaneLeaseOnce } from '../../../lib/lane-lease-heartbeat.mjs';
import { leasePool } from './lease-keeps-while-renewed.mjs';

// Real lane-pool processes run at the last possible seam: after the heartbeat's
// final read, immediately before its rename. No mocked allocator decisions.
export function heartbeatMutationRace(action) {
  const pool = leasePool();
  try {
    const now = new Date();
    const lease = { session: 'a', acquiredAt: new Date(now.getTime() - 30_000).toISOString(), ttlMinutes: 240 };
    writeFileSync(pool.marker, JSON.stringify(lease));
    pool.env.CLAUDE_CODE_SESSION_ID = 'adopting-worker';
    const args = action === 'release' ? ['--session=a'] : action === 'acquire'
      ? ['--session=a', '--no-reset', '--no-reap'] : [];
    let concurrent;
    const fs = { existsSync, readFileSync, writeFileSync, rmSync,
      renameSync: (from, to) => {
        concurrent = pool.run(action, ...args);
        renameSync(from, to);
      } };
    const renewed = renewLaneLeaseOnce({ cwd: pool.dir, now: () => now, fs });
    const afterRenewal = JSON.parse(readFileSync(pool.marker, 'utf8'));
    const retry = pool.run(action, ...args);
    const read = () => existsSync(pool.marker) ? JSON.parse(readFileSync(pool.marker, 'utf8')) : null;
    const afterRetry = read();
    const nextRenewed = renewLaneLeaseOnce({ cwd: pool.dir,
      owner: `a||${lease.acquiredAt}`, now: () => now });
    return { action, lease, renewed, concurrentCode: concurrent?.status,
      retryCode: retry.status, afterRenewal, afterRetry, nextRenewed, final: read(),
      expectedRenewal: { ...lease, renewedAt: now.toISOString() } };
  } finally { pool.close(); }
}

export function judgeMutationRace(r) {
  if (!r.renewed || typeof r.concurrentCode !== 'number' || r.concurrentCode === 0 || r.retryCode !== 0) {
    return [`${r.action}: concurrent mutation was not excluded or retry failed`];
  }
  if (JSON.stringify(r.afterRenewal) !== JSON.stringify(r.expectedRenewal)) return ['renewal clobbered another mutation'];
  if (r.action === 'release') return !r.nextRenewed && r.final === null ? [] : ['released lease was resurrected'];
  if (r.action === 'acquire') return !r.nextRenewed && r.final?.holder &&
    JSON.stringify(r.final) === JSON.stringify(r.afterRetry) ? [] : ['reacquired lease was overwritten'];
  if (r.action === 'adopt') return r.nextRenewed && r.final?.workerSession === 'adopting-worker' &&
    JSON.stringify(r.final) === JSON.stringify(r.afterRetry) ? [] : ['adopted worker was overwritten'];
  return ['unknown mutation'];
}

export default {
  id: 'heartbeat-renewal-mutation-race', title: 'heartbeat publication excludes concurrent lease release, reacquire and adopt',
  card: 'PR-7488', fixedBy: { sha: 'heartbeat-renewal-mutation-race', where: 'working-tree' },
  fixPresent: (root) => existsSync(join(root, 'scripts/lib/lane-lease-lock.mjs')),
  run: async () => ['release', 'acquire', 'adopt'].map(heartbeatMutationRace),
  judge: (reports) => reports.length === 3 && ['release', 'acquire', 'adopt'].every(a => reports.some(r => r.action === a))
    ? reports.flatMap(judgeMutationRace) : ['incomplete mutation matrix'],
};
