import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFastPassCli, REVIEW_DISPATCH_LEASE_KEY } from '../../review-fast-pass-cli.mjs';
import { sharedHostBudget, runDaemonLoop, runReviewDispatchPass } from '../../../../skills-src/conveyor/review-daemon.mjs';
import { makeOwner, acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned } from '../../../../skills-src/conveyor/runner-lock.mjs';
import { acquireWrite, releaseWrite } from '../../daemon-clone-lock.mjs';

/** CLI integration: real self-sync wrapper, real host budget and real cross-process lease/checkout locks.
 * Only external evidence readers, rebuild work and the final spawn are replaced with hermetic IO.
 */
export async function exerciseFastCli(kinds = ['writer', 'unreadable', 'quarantine', 'ordinary', 'lease-lost', 'reserve', 'lanes', 'throw', 'ok', 'cadence', 'race']) {
  const dir = mkdtempSync(join(tmpdir(), 'fast-cli-admission-'));
  const violations = [];
  const head = 'a'.repeat(40), main = 'b'.repeat(40);
  const repo = 'web-everything/web-everything';
  const pr = { number: 1, state: 'OPEN', headRefOid: head, labels: ['review:pending'], comments: [], statusCheckRollup: [], files: [] };
  const key = '<conveyor:review-daemon-lease>', owner = 'fixture-ordinary';
  async function probe(kind) {
    let starts = 0, factories = 0;
    let clock = 0, labelledAt = 0, current = { ...pr }, concurrent;
    const latencies = [], jobs = [];
    if (kind === 'cadence') current.labels = [];
    const budget = { max: kind === 'race' ? 1 : 3, left: kind === 'race' ? 1 : 3, reserve: kind === 'reserve' ? 3 : 0 };
    const lockRoot = join(dir, 'leases'), checkoutLocks = join(dir, 'checkout-locks');
    const env = { WE_DAEMON_CLONE_LOCK_ROOT: checkoutLocks };
    let writer;
    if (kind === 'writer') writer = await acquireWrite(dir, { lockRoot: checkoutLocks, owner: 'fixture-writer', waitMs: 0 });
    const ordinaryLive = ['ordinary', 'cadence', 'race'].includes(kind);
    if (ordinaryLive) acquireRunnerLease(lockRoot, owner, { key });
    const ordinaryTick = (duringSpawn = null) => runReviewDispatchPass({ owner, lockRoot, repos: [repo],
      log: { error: () => {} }, authGateOverride: () => ({ paused: false }),
      reviewTickOpts: () => ({
        readPrs: () => kind === 'race' ? [current] : [], readAgents: () => [],
        reconcile: () => ({ dispatch: kind === 'race' && !jobs.length ? [{ kind: 'review', prNumber: 1 }] : [], refusals: [] }),
        holdReconcile: () => [], statusCandidates: () => [], tagStatus: () => {}, tagRound: () => {},
        dispatchState: { firstOwedAt: new Map(), lastDispatched: new Map() }, acquirableLanes: () => [1],
        liveReviewBudget: { max: 1, left: 1 - jobs.length, reserve: 0 }, hostAdmission: () => ({ admitted: true, maxPerTick: 1 }),
        dispatch: () => { duringSpawn?.(); starts++; jobs.push({ repo, pr: 1, pid: 5 }); return { jobPid: 5 }; },
      }),
    });
    try {
      await runFastPassCli({ repos: kind === 'cadence' ? [repo] : [repo, 'second/repo'], once: true, env: {}, lockRoot,
        log: line => { if (line.endsWith(' dispatched')) latencies.push(clock - labelledAt); }, appAuth: effects => effects, sharedHostBudget,
        selfSyncOptions: { root: dir, env, readHead: () => head, readReady: () => null,
          rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
          readState: () => { if (kind === 'unreadable') throw Error('unreadable evidence');
            return { adopted: null, rejected: null, inProgress: null, quarantine: kind === 'quarantine' ? { reason: 'smoke rejected' } : null }; },
          log: { error: () => {} }, onRestart: () => {} },
        cliReviewTickOpts: () => { factories++; return {
          readAgents: () => [], liveReviewBudget: kind === 'cadence' ? { max: 1, left: 1, reserve: 0 } : budget,
          acquirableLanes: () => kind === 'lanes' ? [] : [1, 2],
          hostAdmission: () => {
            if (kind === 'lease-lost') releaseRunnerLeaseIfOwned(lockRoot, makeOwner('review-fast-pass'), { key: REVIEW_DISPATCH_LEASE_KEY });
            return { admitted: true, maxPerTick: 1 };
          },
          dispatch: args => { args.checkStaleness(dir); starts++; if (kind === 'throw') throw Error('post-spawn'); return { jobPid: 5 }; },
        }; },
        optionsIo: { gh: args => args[0] === 'api' ? main : JSON.stringify([current]), readLivePr: () => current, readJobs: () => [...jobs],
          readPlan: () => ({ plan: { dispatch: [] }, rawPrs: [], savedAt: 1, mainSha: main }),
          auth: () => ({ paused: false }), capability: () => null,
          reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: current.number }] }),
          staleness: () => ({ fresh: true }) },
        runDaemonLoop: async effects => {
          if (ordinaryLive) heartbeatRunnerLease(lockRoot, owner, { key });
          if (kind === 'race') {
            await ordinaryTick(() => { concurrent = effects.tickOnce(); });
            await concurrent;
          }
          if (kind === 'cadence') return runDaemonLoop({ ...effects, maxTicks: 11,
            tickOnce: async () => { await ordinaryTick(); return effects.tickOnce(); },
            sleep: async ms => {
              labelledAt = clock + 1;
              clock += ms;
              current = { ...pr, number: current.number + 1, updatedAt: new Date(labelledAt).toISOString() };
              heartbeatRunnerLease(lockRoot, owner, { key });
            },
          });
          return effects.tickOnce();
        },
      });
    } finally {
      if (writer?.ok) releaseWrite(dir, { lockRoot: checkoutLocks, owner: 'fixture-writer' });
      if (ordinaryLive) releaseRunnerLeaseIfOwned(lockRoot, owner, { key });
    }
    const expected = kind === 'cadence' ? 10 : ['ok', 'throw', 'ordinary', 'race'].includes(kind) ? 1 : 0;
    if (starts !== expected) violations.push(`${kind}: expected ${expected} starts, got ${starts}`);
    if (['writer', 'unreadable', 'quarantine'].includes(kind) && factories !== 0) violations.push(`${kind}: admission ran discovery`);
    if (kind === 'cadence') {
      const sorted = latencies.toSorted((a, b) => a - b);
      if (latencies.length !== 10 || sorted.at(-1) > 180000 || (sorted[4] + sorted[5]) / 2 >= 180000)
        violations.push(`cadence: expected ten dispatched log lines within 180s and median under 3min, got ${JSON.stringify(latencies)}`);
    }
  }
  try {
    for (const kind of kinds) await probe(kind);
    return { violations };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
