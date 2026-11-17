/** Slow pre-loop work must not starve the six CI-heal dispatches owed in a pass. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReconcileCiHealDispatch } from '../../../operations/ci-heal-pr-dispatch.mjs';

export default {
  id: 'ci-heal-starved-by-slow-prelude',
  title: 'ci-heal dispatches only one owed PR per pass when the pre-loop work spends the phase budget (live 2026-11-16: prs=1 deferred=5)',
  card: '#8412',
  fixedBy: { sha: 'working-tree', where: 'lane', paths: ['scripts/operations/ci-heal-pr-dispatch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/operations/ci-heal-pr-dispatch.mjs'), 'utf8').includes('gateSliceMs'); },
  async run({ adoption = null, hostRecheck = true, runDispatch = runReconcileCiHealDispatch } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-slow-prelude-'));
    let time = 0;
    let yieldRequested = false;
    let probes = 0;
    try {
      return await runDispatch({
        root: dir,
        checkStaleness: () => ({ fresh: true, behind: 0 }),
        now: () => time,
        deadlineAt: 180_000,
        shouldYield: adoption == null ? undefined : () => adoption === 'during-admission' ? ++probes >= 3 : yieldRequested,
        reconcile: () => ({
          dispatch: [1, 2, 3, 4, 5, 6].map(prNumber => ({
            kind: 'ci-heal', prNumber, headRefOid: 'a'.repeat(40),
          })),
          refusals: [],
        }),
        flushOwed: () => ({}),
        pollAttempts: () => [],
        flushTimeouts: async () => { time += 192_000; return []; },
        timeoutHold: () => null,
        salvage: async () => null,
        resolveProfile: () => ({ capabilities: { ciHeal: true } }),
        resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
        pickFreeLanes: () => [11, 12, 13, 14, 15, 16],
        unsupportedPath: join(dir, 'unsupported.json'),
        fixConfig: { maxSessions: 3, windowHours: 6, hold: true },
        fixLoop: {
          killed: () => false,
          readRows: () => [],
          append: async () => {},
          currentBuild: () => 'test-build',
          readSessionLog: () => '',
        },
        dispatch: async planned => { time += 5_000; yieldRequested = true; return { pr: planned.pr }; },
        dispatchThrottle: { tryAdmit: () => ({ admit: true }), recheckHost: hostRecheck ? () => ({ admit: true }) : undefined },
        queueAdmission: { tryAdmit: () => ({ admit: true }) },
        ciHealReserve: null,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) {
    const violations = [];
    if (!Array.isArray(report?.dispatched) || report.dispatched.length < 6) {
      violations.push('slow prelude starved owed CI-heal work: fewer than six PRs dispatched');
    }
    if (!Array.isArray(report?.deferred) || report.deferred.length !== 0) {
      violations.push('slow prelude left CI-heal PRs deferred');
    }
    return violations;
  },
};
