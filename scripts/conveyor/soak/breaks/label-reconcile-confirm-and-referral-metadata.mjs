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
      && planner.includes('writeHead.headRefOid !== pr.headRefOid')
      && planner.includes('at >= observed.startedAt')
      && planner.includes('publishedAccept')
      && planner.includes('c.updatedAt ?? c.updated_at')
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
    // during-run-changes: posted after the run read the thread but before its advise step finished.
    const holding = ['changes', 'later-changes', 'awaiting-confirm', 'racing-changes', 'native-changes',
      'during-run-changes', 'edited-changes', 'rest-edited-changes', 'unknown-edit', 'racing-edit'];
    for (const scenario of ['changes', 'accept', 'abstain', 'later-changes', 'newer-accept',
      'awaiting-confirm', 'racing-changes', 'native-changes', 'during-run-changes',
      'failed-self-accept', 'edited-changes', 'rest-edited-changes', 'unknown-edit', 'racing-edit']) {
      const confirm = ['changes', 'abstain'].includes(scenario) ? scenario
        : scenario === 'awaiting-confirm' ? undefined : 'accept';
      let labels = ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge'];
      const review = { id: 'review-pr-accepted', op: 'review-pr', input: { reason: 'remaining operator blocker' }, findings: {
        read: { repo, pr: number, netBasis: { rev: head } }, ...(confirm ? { confirm } : {}),
        record: { applied: true, effects: [{ type: 'review.label-swap', status: 'applied' }] },
        referralVerdict: { verdict: 'accept', pendingReferrals: [], blockedReferrals: [],
          lenses: ['correctness', 'security'], lensVerdicts: { correctness: 'accept', security: 'accept' } },
      }, stepTimings: [{ step: 'read', startedAt: '2026-10-26T01:00:00Z' },
        { step: 'advise', finishedAt: '2026-10-26T01:01:00Z' }] };
      if (scenario === 'failed-self-accept') {
        review.input.actor = 'author';
        delete review.findings.record;
        review.effects = [{ step: 'record', type: 'review.label-swap', status: 'failed',
          error: 'accepting actor matches PR author' }];
      }
      if (confirm === 'abstain' && !planRecordDecision(review).abstain) violations.push('abstain: unexpectedly records');
      const comments = confirm === 'changes' ? [] : [settled];
      const operatorChanges = { author: { login: 'chalbert' },
        body: '🔁 review — changes requested\nRemaining operator blocker', createdAt: '2026-10-26T01:02:00Z',
        updatedAt: '2026-10-26T01:02:00Z' };
      if (['later-changes', 'newer-accept'].includes(scenario)) comments.push(operatorChanges);
      if (scenario === 'during-run-changes') comments.push({ ...operatorChanges,
        createdAt: '2026-10-26T01:00:30Z', updatedAt: '2026-10-26T01:00:30Z' });
      const edited = { ...operatorChanges, createdAt: '2026-10-26T00:59:00Z' };
      if (scenario === 'rest-edited-changes') {
        edited.updated_at = edited.updatedAt;
        delete edited.updatedAt;
      }
      if (scenario === 'unknown-edit') delete edited.updatedAt;
      if (['edited-changes', 'rest-edited-changes', 'unknown-edit'].includes(scenario)) comments.push(edited);
      // racing-changes: the verdict is posted after the first thread read, before the final one.
      let threadReads = 0;
      const readComments = () => {
        threadReads++;
        if (scenario === 'racing-changes' && threadReads > 1) return [...comments, operatorChanges];
        if (scenario === 'racing-edit') return [...comments, threadReads > 1 ? edited
          : { ...edited, body: 'Operator note', updatedAt: edited.createdAt }];
        return comments;
      };
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
      const expected = ['abstain', 'awaiting-confirm', 'failed-self-accept'].includes(scenario)
        ? ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge']
        : holding.includes(scenario)
          ? ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held'] : ['ready-to-merge'];
      if (JSON.stringify(labels) !== JSON.stringify(expected)) violations.push(`${scenario}: unexpected labels ${labels.join(',')}`);
      // The next tick must be stable after either a hold or a clearance.
      io.prs[0].labels = labels;
      if (sweepLabelStateReconcile(io).length) violations.push(`${scenario}: repeated reconciliation`);
    }
    // Round 4: both metadata snapshots still name A when the final evidence read pushes B.
    // Exercise the production metadata reader, stored ACCEPTS, and label writer together.
    for (const phase of ['native', 'stored', 'provision']) {
      let liveHead = head, nativeReads = 0, storedReads = 0, writes = 0, events = 0;
      let labels = ['red-team:blocked'];
      const pushed = 'b'.repeat(40);
      const exec = () => JSON.stringify({ number, state: 'OPEN', headRefOid: liveHead,
        labels, body, createdAt: '2026-01-01T00:00:00Z' });
      const io = { repo, prs: [{ number, labels }],
        readPr: args => defaultReadPr({ exec, readComments: () => [], ...args }),
        readComments: () => [], readReviews: () => [], readReview: () => null,
        readRedTeam: ({ head: requestedHead }) => {
          if (++storedReads === 2 && phase === 'stored') liveHead = pushed;
          return requestedHead === head
            ? { repo, pr: number, head, status: 'finished', result: { foldedVerdict: 'accept' } } : null;
        },
        emit: () => { events++; },
        provider: {
          readPrReviews() {
            if (++nativeReads === 2 && phase === 'native') liveHead = pushed;
            return [];
          },
          ensureLabel() { if (phase === 'provision') liveHead = pushed; },
          setLabels(_repo, _pr, { add, remove }) {
            writes++;
            labels = labels.filter(l => !remove.includes(l));
            if (add) labels.push(...add.split(','));
          },
        },
      };
      const rows = sweepLabelStateReconcile(io);
      if (liveHead !== pushed || writes || events || rows.length || labels.join(',') !== 'red-team:blocked') {
        violations.push(`push-during-${phase}: stale clearance (writes=${writes}, events=${events}, labels=${labels})`);
      }
      // Head B has no result; retry must retain the hold without applying A's evidence.
      io.prs[0].labels = labels;
      const writesBeforeRetry = writes, eventsBeforeRetry = events;
      if (sweepLabelStateReconcile(io).length || writes !== writesBeforeRetry || events !== eventsBeforeRetry) {
        violations.push(`push-during-${phase}: unsafe retry`);
      }
    }
    log?.(`label reconciliation: ${violations.length} violation(s)`);
    return { violations };
  },
  judge: report => report.violations,
};
