import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFastPassCli, REVIEW_DISPATCH_LEASE_KEY, withReviewDispatchLease } from '../../review-fast-pass-cli.mjs';
import { sharedHostBudget, runDaemonLoop, runReviewDispatchPass } from '../../../../skills-src/conveyor/review-daemon.mjs';
import { makeOwner, acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned } from '../../../../skills-src/conveyor/runner-lock.mjs';
import { acquireWrite, releaseWrite } from '../../daemon-clone-lock.mjs';
import { dispatchReviewByMode } from '../../../operations/review-job.mjs';

/** CLI integration: real self-sync wrapper, real host budget and real cross-process lease/checkout locks.
 * Only external evidence readers, rebuild work and the final spawn are replaced with hermetic IO.
 */
export async function exerciseFastCli(kinds = ['writer', 'unreadable', 'quarantine', 'ordinary', 'lease-lost', 'lease-ci', 'lease-stack', 'reserve', 'lanes', 'throw', 'ok', 'cadence', 'cadence-load', 'race', 'maintenance', 'contention']) {
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
    const cadence = kind.startsWith('cadence');
    if (cadence) current.labels = [];
    const budget = { max: kind === 'race' ? 1 : 3, left: kind === 'race' ? 1 : 3, reserve: kind === 'reserve' ? 3 : 0 };
    const lockRoot = join(dir, 'leases'), checkoutLocks = join(dir, 'checkout-locks');
    const env = { WE_DAEMON_CLONE_LOCK_ROOT: checkoutLocks };
    let writer;
    if (kind === 'writer') writer = await acquireWrite(dir, { lockRoot: checkoutLocks, owner: 'fixture-writer', waitMs: 0 });
    const ordinaryLive = ['ordinary', 'cadence', 'cadence-load', 'race', 'maintenance'].includes(kind);
    if (ordinaryLive) acquireRunnerLease(lockRoot, owner, { key });
    const ordinaryTick = (duringSpawn = null) => runReviewDispatchPass({ owner, lockRoot, repos: [repo],
      log: { error: () => {} }, authGateOverride: () => ({ paused: false }),
      reviewTickOpts: () => ({
        readPrs: () => kind === 'race' ? [current] : [], readAgents: () => [],
        reconcile: () => {
          if (kind === 'cadence-load') {
            clock += 45000;
            const probe = acquireRunnerLease(lockRoot, 'maintenance-probe', { key: REVIEW_DISPATCH_LEASE_KEY });
            if (!probe.ok) violations.push('ordinary maintenance held the dispatch mutex');
            else releaseRunnerLeaseIfOwned(lockRoot, 'maintenance-probe', { key: REVIEW_DISPATCH_LEASE_KEY });
          }
          return { dispatch: kind === 'race' && !jobs.length ? [{ kind: 'review', prNumber: 1 }] : [], refusals: [] };
        },
        holdReconcile: () => { if (kind === 'maintenance') starts++; return []; }, statusCandidates: () => [], tagStatus: () => {}, tagRound: () => {},
        dispatchState: { firstOwedAt: new Map(), lastDispatched: new Map() }, acquirableLanes: () => [1],
        liveReviewBudget: { max: 1, left: 1 - jobs.length, reserve: 0 }, hostAdmission: () => ({ admitted: true, maxPerTick: 1 }),
        dispatch: () => { duringSpawn?.(); starts++; jobs.push({ repo, pr: 1, pid: 5 }); return { jobPid: 5 }; },
      }),
    });
    try {
      await runFastPassCli({ repos: cadence ? [repo] : [repo, 'second/repo'], once: true, env: {}, lockRoot,
        log: line => { if (line.endsWith(' dispatched')) latencies.push(clock - labelledAt); }, appAuth: effects => effects, sharedHostBudget,
        selfSyncOptions: { root: dir, env, readHead: () => head, readReady: () => null,
          rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
          readState: () => { if (kind === 'unreadable') throw Error('unreadable evidence');
            return { adopted: null, rejected: null, inProgress: null, quarantine: kind === 'quarantine' ? { reason: 'smoke rejected' } : null }; },
          log: { error: () => {} }, onRestart: () => {} },
        cliReviewTickOpts: () => { factories++; return {
          readAgents: () => [], liveReviewBudget: cadence ? { max: 1, left: 1, reserve: 0 } : budget,
          acquirableLanes: () => kind === 'lanes' ? [] : [1, 2],
          hostAdmission: () => {
            if (kind === 'lease-lost') releaseRunnerLeaseIfOwned(lockRoot, makeOwner('review-fast-pass'), { key: REVIEW_DISPATCH_LEASE_KEY });
            return { admitted: true, maxPerTick: 1 };
          },
          dispatch: args => {
            if (['lease-ci', 'lease-stack'].includes(kind)) {
              const lose = () => releaseRunnerLeaseIfOwned(lockRoot, makeOwner('review-fast-pass'), { key: REVIEW_DISPATCH_LEASE_KEY });
              return dispatchReviewByMode({ ...args, root: dir, dir: join(dir, `jobs-${kind}`),
                io: { liveHead: () => head }, readCompletion: () => null, resolveSettingsEnv: () => ({}),
                stackCheck: () => { if (kind === 'lease-stack') lose(); return { base: null }; },
                ciGate: () => { if (kind === 'lease-ci') lose(); return { allowed: true, headSha: head }; },
                spawnJob: () => { starts++; return null; },
              });
            }
            args.checkStaleness(dir); starts++; if (kind === 'throw') throw Error('post-spawn'); return { jobPid: 5 };
          },
        }; },
        optionsIo: { gh: args => args[0] === 'api' ? main : JSON.stringify([current]),
          readLivePr: () => { if (kind === 'cadence-load') clock += 5000; return current; }, readJobs: () => [...jobs],
          readPlan: () => ({ plan: { dispatch: [] }, rawPrs: [], savedAt: 1, mainSha: main }),
          auth: () => ({ paused: false }), capability: () => null,
          reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: current.number }] }),
          staleness: () => ({ fresh: true }) },
        runDaemonLoop: async effects => {
          if (ordinaryLive) heartbeatRunnerLease(lockRoot, owner, { key });
          if (kind === 'maintenance') {
            return withReviewDispatchLease(() => ordinaryTick(), { lockRoot, owner: 'fast-holder', log: () => {} });
          }
          if (kind === 'contention') {
            await withReviewDispatchLease(async () => {
              await effects.tickOnce();
              if (starts) violations.push('contending fast tick spawned');
              clock += 45000;
            }, { lockRoot, owner, log: () => {} });
            clock += effects.intervalMs;
            return effects.tickOnce();
          }
          if (kind === 'race') {
            await ordinaryTick(() => { concurrent = effects.tickOnce(); });
            await concurrent;
          }
          if (cadence) return runDaemonLoop({ ...effects, maxTicks: 11,
            tickOnce: async () => {
              await ordinaryTick();
              return effects.tickOnce();
            },
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
    const expected = cadence ? 10 : ['ok', 'throw', 'ordinary', 'race', 'maintenance', 'contention'].includes(kind) ? 1 : 0;
    if (starts !== expected) violations.push(`${kind}: expected ${expected} starts, got ${starts}`);
    if (['writer', 'unreadable', 'quarantine'].includes(kind) && factories !== 0) violations.push(`${kind}: admission ran discovery`);
    if (kind === 'contention' && (latencies.length !== 1 || latencies[0] !== 150000)) violations.push(`contention: ${JSON.stringify(latencies)}`);
    if (cadence) {
      const sorted = latencies.toSorted((a, b) => a - b);
      if (latencies.length !== 10 || sorted.at(-1) > 180000 || (sorted[4] + sorted[5]) / 2 >= 180000)
        violations.push(`${kind}: expected ten dispatched log lines within 180s and median under 3min, got ${JSON.stringify(latencies)}`);
    }
  }
  try {
    for (const kind of kinds) await probe(kind);
    return { violations };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
