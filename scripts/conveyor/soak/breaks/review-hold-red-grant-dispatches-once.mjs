/** #6769: a stale-gate grant dispatches one review despite review-owned required reds. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export const CORE = 'scripts/conveyor/reconcile-core.mjs';
export const HOLD = 'scripts/conveyor/review-referral-hold.mjs';
export const FIX_MARKERS = [
  [CORE, 'if (reviewHoldRed && pr?.staleGateGrant === true && !pr?.isDraft && withPhase.labels.includes(REVIEW_LABELS.pending)'],
  [CORE, '&& !withPhase.labels.includes(REVIEW_LABELS.human)) {'],
  [HOLD, 'const staleGateGrant = newestLegacy !== null && !headRuns.some(r => r.s2bSeen)'],
  [HOLD, 'return { ...pr, blockRuledReferrals, staleGateGrant,'],
];

export default {
  id: 'review-hold-red-grant-dispatches-once',
  title: 'review-owned red gates allow one stale-gate review and refuse a spent grant',
  card: '#6769',
  fixedBy: { sha: '29cd357f', where: 'main', paths: [CORE, HOLD] },
  fixPresent(root) {
    try {
      return FIX_MARKERS.every(([path, marker]) => readFileSync(join(root, path), 'utf8').includes(marker));
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [], decisions = {};
    try {
      const { planReconcile } = await import(pathToFileURL(join(sourceRoot, CORE)).href);
      const { enrichPrsWithReferralHolds } = await import(pathToFileURL(join(sourceRoot, HOLD)).href);
      const repo = 'example/repo', head = 'b'.repeat(40);
      const now = Date.parse('2026-11-15T10:00:00Z');
      const check = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
      const pr = {
        number: 6769, state: 'OPEN', isDraft: false, headRefName: 'lane/stale-gate-grant',
        headRefOid: head, mergeStateStatus: 'CLEAN', labels: ['review:pending'], comments: [],
        statusCheckRollup: [check('test'),
          check('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['review-gate'], jobId: 6769001 } }),
          check('review-gate', 'failure')],
      };
      // Stay beyond the ten-minute verdict publication grace; these are stale completed holds.
      const legacy = { id: 'legacy', repo, pr: pr.number, head, legacyHumanHold: true,
        startedAt: now - 61 * 60_000, completedAt: now - 60 * 60_000 };
      const s2b = { id: 's2b', repo, pr: pr.number, head, s2bSeen: true,
        startedAt: now - 31 * 60_000, completedAt: now - 30 * 60_000 };
      for (const [name, runs, grant] of [['granted', [legacy], true], ['spent', [legacy, s2b], false]]) {
        const [enriched] = enrichPrsWithReferralHolds([pr], { repo, now, env: {}, readRuns: () => runs,
          readComments: () => { throw new Error('unexpected comment read'); } });
        if (enriched.staleGateGrant !== grant) violations.push(`${name}: expected staleGateGrant=${grant}`);
        // The planner takes a constellation key for session naming; run evidence takes the explicit fixture slug.
        const plan = planReconcile({ repo: 'we', prs: [enriched], agents: [], durableCounts: {}, now,
          requiredChecks: ['test', 'merge-gate', 'review-gate'],
          reviewTiming: { startAfter: 'fast-checks', fastChecks: { we: ['test'] } } });
        decisions[name] = { staleGateGrant: enriched.staleGateGrant, ...plan };
        if (grant) {
          if (plan.dispatch.length !== 1 || plan.dispatch[0].kind !== 'review' || plan.dispatch[0].prNumber !== pr.number) {
            violations.push('granted: expected exactly one review dispatch');
          }
          if (plan.refusals.some(row => row.kind === 'review-hold-red')) violations.push('granted: unexpected review-hold-red refusal');
        } else {
          if (plan.dispatch.length !== 0) violations.push('spent: expected no dispatch');
          if (!plan.refusals.some(row => row.kind === 'review-hold-red')) violations.push('spent: expected review-hold-red refusal');
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations, decisions };
  },
  judge: report => report.violations,
};
