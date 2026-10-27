/** Replay PR #5990: preserve later operator changes and abstention alongside settled referrals. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'label-reconcile-confirm-and-referral-metadata',
  title: 'label reconciliation erases operator changes or abstention, or strands independently settled referrals',
  card: 'PR #5990',
  fixedBy: { sha: 'HEAD', where: 'lane/labels-reconcile-main', paths: [
    'scripts/conveyor/label-state-reconcile.mjs', 'scripts/conveyor/advisory-label-sweep.mjs',
  ] },
  fixPresent(root) {
    const planner = readFileSync(join(root, 'scripts/conveyor/label-state-reconcile.mjs'), 'utf8');
    const reader = readFileSync(join(root, 'scripts/conveyor/advisory-label-sweep.mjs'), 'utf8');
    return planner.includes("review.findings?.confirm === 'changes'")
      && planner.includes("review.findings?.confirm !== 'abstain'")
      && planner.includes('!laterHold')
      && planner.includes("review.findings?.confirm === 'accept'")
      && planner.includes('laterReviewHold(reviews')
      && planner.includes('const fresh = readLive()')
      && reader.includes("fields = 'number,state,labels,headRefOid'");
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { sweepLabelStateReconcile } = await load('scripts/conveyor/label-state-reconcile.mjs');
    const { defaultReadPr } = await load('scripts/conveyor/advisory-label-sweep.mjs');
    const { reviewRunEvidence } = await load('scripts/conveyor/review-referral-hold.mjs');
    const { planRecordDecision } = await load('scripts/operations/review-pr.mjs');
    const { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord }
      = await load('scripts/lib/jury-core.mjs');
    const repo = 'o/n', number = 5990, head = 'a'.repeat(40);
    const body = '<!-- authored-by-actor: author -->';
    const runId = 'review-pr-bounced', original = { summary: 'broken case', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const key = referralFindingKey('judge', original), reviewer = mandatoryReferralReviewer(runId);
    const settled = { author: { login: 'web-everything' }, body: renderReferralRecord({
      version: 1, repo, pr: number, head, runId, reviewer, authorBody: body, attempted: true,
      referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
      rulings: [{ id: 'r1', key, reviewerId: reviewer.id, lens: 'correctness', result: 'not-real',
        rationale: 'checked independently', evidence: ['diff'] }],
    }) };
    const violations = [];
    // Round 3 (red team on c3bd94bd0): an unanswered confirm, a verdict landing between the plan and the
    // write, and a native GitHub change request must each keep the holds.
    const holding = ['changes', 'later-changes', 'awaiting-confirm', 'racing-changes', 'native-changes'];
    for (const scenario of ['changes', 'accept', 'abstain', 'later-changes', 'newer-accept',
      'awaiting-confirm', 'racing-changes', 'native-changes']) {
      const confirm = ['changes', 'abstain'].includes(scenario) ? scenario
        : scenario === 'awaiting-confirm' ? undefined : 'accept';
      let labels = ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge'];
      const review = { id: 'review-pr-accepted', op: 'review-pr', input: { reason: 'remaining operator blocker' }, findings: {
        read: { repo, pr: number, netBasis: { rev: head } }, ...(confirm ? { confirm } : {}),
        referralVerdict: { verdict: 'accept', pendingReferrals: [], blockedReferrals: [],
          lenses: ['correctness', 'security'], lensVerdicts: { correctness: 'accept', security: 'accept' } },
      }, stepTimings: [{ step: 'read', startedAt: '2026-10-26T01:00:00Z' },
        { step: 'advise', finishedAt: '2026-10-26T01:01:00Z' }] };
      if (confirm === 'abstain' && !planRecordDecision(review).abstain) violations.push('abstain: unexpectedly records');
      const comments = confirm === 'changes' ? [] : [settled];
      const operatorChanges = { author: { login: 'chalbert' },
        body: '🔁 review — changes requested\nRemaining operator blocker', createdAt: '2026-10-26T01:02:00Z' };
      if (['later-changes', 'newer-accept'].includes(scenario)) comments.push(operatorChanges);
      // racing-changes: the verdict is posted after the first thread read, before the final one.
      let threadReads = 0;
      const readComments = () => (scenario === 'racing-changes' && ++threadReads > 1
        ? [...comments, operatorChanges] : comments);
      const reviews = scenario === 'native-changes'
        ? [{ state: 'CHANGES_REQUESTED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T01:02:00Z' }] : [];
      if (scenario === 'newer-accept') review.stepTimings = [
        { step: 'read', startedAt: '2026-10-26T01:03:00Z' },
        { step: 'advise', finishedAt: '2026-10-26T01:04:00Z' },
      ];
      const exec = (_cmd, argv) => {
        const live = { number, state: 'OPEN', headRefOid: head, labels, body, createdAt: '2026-01-01T00:00:00Z' };
        return JSON.stringify(Object.fromEntries(argv[argv.indexOf('--json') + 1].split(',').map(f => [f, live[f]])));
      };
      const io = { repo, prs: [{ number, labels }],
        readPr: args => defaultReadPr({ ...args, exec, readComments: () => comments }),
        readComments, readReviews: () => [reviewRunEvidence(review)], readReview: () => review,
        readRedTeam: () => null, emit: () => {}, provider: { ensureLabel() {}, readPrReviews: () => reviews,
          setLabels(_repo, _pr, { remove }) { labels = labels.filter(l => !remove.includes(l)); } } };
      const rows = sweepLabelStateReconcile(io);
      if (rows.some(row => row.error)) violations.push(`${scenario}: sweep failed`);
      const expected = ['abstain', 'awaiting-confirm'].includes(scenario)
        ? ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge']
        : holding.includes(scenario)
          ? ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held'] : ['ready-to-merge'];
      if (JSON.stringify(labels) !== JSON.stringify(expected)) violations.push(`${scenario}: unexpected labels ${labels.join(',')}`);
      // The next tick must be stable after either a hold or a clearance.
      io.prs[0].labels = labels;
      if (sweepLabelStateReconcile(io).length) violations.push(`${scenario}: repeated reconciliation`);
    }
    log?.(`label reconciliation: ${violations.length} violation(s)`);
    return { violations };
  },
  judge: report => report.violations,
};
