/** PR #6030: a lease-lost terminal hid earlier infra discounts in a reused fix session. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReconcileCiHealDispatch } from '../../../operations/ci-heal-pr-dispatch.mjs';

export default {
  id: 'fix-run-lease-lost-alignment',
  title: 'lease loss preserves earlier infrastructure discounts in the same fix session',
  card: 'PR #6030',
  fixedBy: { sha: 'HEAD', where: 'lane/fix-run-lease-lost', paths: ['scripts/conveyor/fix-loop-ledger.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/fix-loop-ledger.mjs'), 'utf8').includes("LEASE_LOST: 'lease-lost'");
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'lease-lost-alignment-'));
    const head = 'a'.repeat(40), build = 'b'.repeat(40), now = Date.parse('2026-10-28T16:45:20Z');
    const entry = { kind: 'ci-heal', prNumber: 6030, headRefName: 'lane/fix-run-lease-lost', headRefOid: head };
    // Historical sessions without outcome rows rely on the log fallback, including reused session names.
    const rows = Array.from({ length: 3 }, () => ({ v: 1, at: new Date(now - 1000).toISOString(),
      repo: 'we', pr: 6030, head, build, kind: 'ci-heal', session: 'fix-6030' }));
    const terminals = ['failed (EPERM)', 'no-change (agent committed nothing)', 'lease-lost (lease-lost: .git lease missing)'];
    const launches = [];
    try {
      const result = await runReconcileCiHealDispatch({ root: dir, repo: 'we', now,
        reconcile: () => ({ dispatch: [entry], refusals: [] }), checkStaleness: () => ({ fresh: true }),
        flushOwed: () => ({}), pollAttempts: () => [], flushTimeouts: async () => [], timeoutHold: () => null,
        resolveProfile: () => ({ capabilities: { ciHeal: true }, lanePoolRepo: 'x' }),
        pickFreeLanes: () => [1], resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
        unsupportedPath: join(dir, 'unsupported.json'), queueAdmission: null, salvage: () => null,
        fixConfig: { hold: true, maxSessions: 3, windowHours: 6, redMainDiscount: 'off' },
        fixLoop: { killed: () => false, readRows: () => rows, append: () => {}, currentBuild: () => build,
          readSessionLog: () => terminals.map(terminal => `fix-run: PR #6030 ${terminal}; claim released`).join('\n') },
        dispatch: entry => { launches.push(entry); return { agentId: 'test' }; },
      });
      const violations = result.dispatched.length === 1 && launches.length === 1 ? []
        : [{ invariant: 'infra-discount-preserved', detail: JSON.stringify(result.refusals) }];
      return { violations, launches: launches.length, dispatched: result.dispatched.length };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations.map(v => `${v.invariant}: ${v.detail}`); },
};
