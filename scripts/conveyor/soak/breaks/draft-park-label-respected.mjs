/** Exit-ruling label parks survive fixer pushes across both promotion paths. */
import { isDraftOwedPromotion } from '../../draft-promotion-rule.mjs';
import { runDraftPromotionStep } from '../../draft-promotion-loop.mjs';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

export default {
  id: 'draft-park-label-respected',
  title: 'status:parked drafts stay draft after fixer pushes and promote after explicit label removal',
  card: 'exit-ruling label park regression',
  fixedBy: { sha: 'working-tree', where: 'draft promotion label guards', paths: [
    'scripts/conveyor/draft-promotion-rule.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs',
  ] },
  fixPresent() {
    return isDraftOwedPromotion({ pr: { isDraft: true, headRefName: 'lane/park',
      headRefOid: 'head', labels: ['status:parked'] }, checks: { state: 'green', sha: 'head' } }).reason === 'operator-parked';
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
