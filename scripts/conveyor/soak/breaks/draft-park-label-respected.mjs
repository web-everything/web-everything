/** Exit-ruling label parks survive fixer pushes across both promotion paths. */
import { AGENT_HEAD_PREFIX, WITHDRAWN_LABEL, isOperatorParked, isDraftOwedPromotion } from '../../draft-promotion-rule.mjs';
import { isGithubStacked, stackReviewWhileBaseOpen } from '../../../lib/stack-review-while-open.mjs';
import { runDraftPromotionStep } from '../../draft-promotion-loop.mjs';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

// Pinned pre-fix classifier: intentionally lacks the status:parked label guard.
const labelNames = labels => (Array.isArray(labels) ? labels : []).map(l => typeof l === 'string' ? l : l?.name).filter(Boolean);
function beforeLabelGuard({ pr = {}, checks = null, reviewWhileBaseOpen, defaultBranch = 'main' } = {}) {
  if (String(pr?.state ?? 'OPEN').toUpperCase() !== 'OPEN') return { owed: false, why: 'not open' };
  if (pr?.isDraft !== true) return { owed: false, why: 'not a draft' };
  // A `lane/` prefix is only proof of agent authorship when the branch lives in THIS repo: a fork can name its branch anything.
  if (pr?.isCrossRepository === true) return { owed: false, why: 'cross-repository (fork) branch — a lane/ prefix there is not agent authorship' };
  if (!String(pr?.headRefName ?? '').startsWith(AGENT_HEAD_PREFIX)) return { owed: false, why: 'not an agent lane branch (draft-first covers lane/* only)' };
  if (labelNames(pr?.labels).includes(WITHDRAWN_LABEL)) return { owed: false, why: 'draft is withdrawn — explicit release is required before promotion' };
  if (isOperatorParked(pr.comments)) return { owed: false, reason: 'operator-parked', why: 'draft PR is operator-parked — explicit release is required before promotion' };
  const redTeamHold = labelNames(pr?.labels).find(label => ['red-team:blocked', 'red-team:pending'].includes(label));
  if (redTeamHold) return { owed: false, why: `${redTeamHold} — a draft held by red team is never promoted` };
  const stacked = isGithubStacked(pr, defaultBranch);
  if (stacked && !(reviewWhileBaseOpen ?? stackReviewWhileBaseOpen())) {
    return { owed: false, why: `stacked on ${pr.baseRefName} — stack.reviewWhileBaseOpen is off, so it waits for its base to land` };
  }
  if (!checks) return { owed: false, why: 'required checks not read yet' };
  if (!pr?.headRefOid || checks.sha !== pr.headRefOid) return { owed: false, why: 'check verdict is for a different head' };
  if (checks.state === 'unchecked') {
    const conflict = pr.mergeable === 'CONFLICTING'
      || labelNames(pr.labels).some(label => ['status:conflict', 'merge-status:conflicting'].includes(label));
    return conflict
      ? { owed: false, reason: 'ci-blocked-by-conflict', why: 'required checks have no rows on this head — CI cannot run until rebased' }
      : { owed: false, reason: 'awaiting-ci-trigger', why: 'required checks have no rows on this head — missing-run recovery owns the synchronize-push nudge' };
  }
  if (checks.state !== 'green' && !(checks.state === 'red' && checks.reviewHoldOnly === true)) {
    return { owed: false, why: `required checks read ${checks.state ?? 'unknown'}, not green` };
  }
  if (checks.state === 'red') return { owed: true, why: 'draft lane PR — required checks are held only for review on its head; promote it to ready for review' };
  if (stacked) return { owed: true, why: `stacked draft lane PR (base ${pr.baseRefName}, still open) — its own required checks are green on its head; promote it to ready for review while the base is open (stack.reviewWhileBaseOpen); merge still waits for the base` };
  return { owed: true, why: 'draft lane PR — every required check is green on its head; promote it to ready for review (draft-first PRs)' };
}

const parkedProbe = { pr: { isDraft: true, headRefName: 'lane/park',
  headRefOid: 'head', labels: ['status:parked'] }, checks: { state: 'green', sha: 'head' } };

export default {
  id: 'draft-park-label-respected',
  title: 'status:parked drafts stay draft after fixer pushes and promote after explicit label removal',
  card: 'exit-ruling label park regression',
  fixedBy: { sha: 'working-tree', where: 'draft promotion label guards', paths: [
    'scripts/conveyor/draft-promotion-rule.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs',
  ] },
  reproduce(input = parkedProbe) {
    return beforeLabelGuard(input);
  },
  fixPresent() {
    return isDraftOwedPromotion(parkedProbe).reason === 'operator-parked';
  },
  async run() {
    const violations = [];
    const repo = CONSTELLATION_REPOS.we.slug;
    for (const path of ['loop', 'dispatch']) {
      for (const [push, parked] of [[1, true], [2, true], [3, false]]) {
        const sha = String(push).repeat(40);
        const pr = { number: 1, state: 'OPEN', isDraft: true, headRefName: 'lane/park', headRefOid: sha,
          baseRefName: 'main', labels: [], comments: [], isCrossRepository: false,
          body: '', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }] };
        const labels = parked ? [{ name: 'status:parked' }] : [];
        const ready = () => { pr.isDraft = false; };
        let result;
        if (path === 'loop') {
          let reads = 0;
          result = runDraftPromotionStep({ repos: [repo], listDrafts: () => [pr],
            readHeadCheckState: () => ({ state: 'green' }),
            readPrView: () => ({ ...pr, labels: ++reads > 1 ? labels : [] }),
            readAgents: () => [], readClaim: () => null, readRequiredChecks: () => ({ checks: ['test'] }),
            ready, clearAwaiting: () => {},
          });
          if (parked && !result.rows.some(r => r.action === 'skip' && r.reason === 'operator-parked' && r.why.includes('parked'))) {
            violations.push(`${path}: missing parked skip on push ${push}`);
          }
        } else {
          result = runReconcilePromoteDraftDispatch({ root: '.', repo,
            checkStaleness: () => ({ fresh: true, behind: 0 }),
            reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 1, headRefOid: sha }], refusals: [] }),
            readHeadCheckState: () => ({ state: 'green' }), readPrLabels: () => labels,
            readComments: () => [], provider: { ready }, clearAwaitingCi: () => {},
          });
          if (parked && !result.refusals.some(r => r.kind === 'operator-parked')) violations.push(`${path}: missing park refusal`);
        }
        if (pr.isDraft !== parked) violations.push(`${path}: incorrect draft state on push ${push}`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
