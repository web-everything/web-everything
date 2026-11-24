import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFastPassCli } from '../../review-fast-pass-cli.mjs';
import { sharedHostBudget } from '../../../../skills-src/conveyor/review-daemon.mjs';
import { acquireRunnerLease, releaseRunnerLeaseIfOwned } from '../../../../skills-src/conveyor/runner-lock.mjs';
import { acquireWrite, releaseWrite } from '../../daemon-clone-lock.mjs';

/** CLI integration: real self-sync wrapper, real host budget and real cross-process lease/checkout locks.
 * Only external evidence readers, rebuild work and the final spawn are replaced with hermetic IO.
 */
export async function exerciseFastCli(kinds = ['writer', 'unreadable', 'quarantine', 'ordinary', 'reserve', 'lanes', 'throw', 'ok']) {
  const dir = mkdtempSync(join(tmpdir(), 'fast-cli-admission-'));
  const violations = [];
  const head = 'a'.repeat(40), main = 'b'.repeat(40);
  const pr = { number: 1, state: 'OPEN', headRefOid: head, labels: ['review:pending'], comments: [], statusCheckRollup: [], files: [] };
  const key = '<conveyor:review-daemon-lease>', owner = 'fixture-ordinary';
  async function probe(kind) {
    let starts = 0, factories = 0;
    const budget = { max: 3, left: 3, reserve: kind === 'reserve' ? 3 : 0 };
    const lockRoot = join(dir, 'leases'), checkoutLocks = join(dir, 'checkout-locks');
    const env = { WE_DAEMON_CLONE_LOCK_ROOT: checkoutLocks };
    let writer;
    if (kind === 'writer') writer = await acquireWrite(dir, { lockRoot: checkoutLocks, owner: 'fixture-writer', waitMs: 0 });
    if (kind === 'ordinary') acquireRunnerLease(lockRoot, owner, { key });
    try {
      await runFastPassCli({ repos: ['first/repo', 'second/repo'], once: true, env: {}, lockRoot,
        log: () => {}, appAuth: effects => effects, sharedHostBudget,
        selfSyncOptions: { root: dir, env, readHead: () => head, readReady: () => null,
          rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
          readState: () => { if (kind === 'unreadable') throw Error('unreadable evidence');
            return { adopted: null, rejected: null, inProgress: null, quarantine: kind === 'quarantine' ? { reason: 'smoke rejected' } : null }; },
          log: { error: () => {} }, onRestart: () => {} },
        cliReviewTickOpts: () => { factories++; return {
          readAgents: () => [], liveReviewBudget: budget,
          acquirableLanes: () => kind === 'lanes' ? [] : [1, 2],
          hostAdmission: () => ({ admitted: true, maxPerTick: 1 }),
          dispatch: args => { args.checkStaleness(dir); starts++; if (kind === 'throw') throw Error('post-spawn'); return { jobPid: 5 }; },
        }; },
        optionsIo: { gh: args => args[0] === 'api' ? main : JSON.stringify([pr]), readLivePr: () => pr, readJobs: () => [],
          readPlan: () => ({ plan: { dispatch: [] }, rawPrs: [], savedAt: 1, mainSha: main }),
          auth: () => ({ paused: false }), capability: () => null,
          reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 1 }] }),
          staleness: () => ({ fresh: true }) },
        runDaemonLoop: async effects => effects.tickOnce(),
      });
    } finally {
      if (writer?.ok) releaseWrite(dir, { lockRoot: checkoutLocks, owner: 'fixture-writer' });
      if (kind === 'ordinary') releaseRunnerLeaseIfOwned(lockRoot, owner, { key });
    }
    const expected = ['ok', 'throw'].includes(kind) ? 1 : 0;
    if (starts !== expected) violations.push(`${kind}: expected ${expected} starts, got ${starts}`);
    if (['writer', 'unreadable', 'quarantine', 'ordinary'].includes(kind) && factories !== 0) violations.push(`${kind}: admission ran discovery`);
  }
  try {
    for (const kind of kinds) await probe(kind);
    return { violations };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
