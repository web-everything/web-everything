/** Regression: official parks survive new heads across both promotion paths. */
import { WITHDRAWN_LABEL, OPERATOR_PARK_MARKER, OPERATOR_PARK_RELEASE_MARKER, isDraftOwedPromotion } from '../../draft-promotion-rule.mjs';
import { runDraftPromotionStep } from '../../draft-promotion-loop.mjs';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const comment = body => ({ author: { login: 'web-everything' }, body });

export default {
  id: 'draft-park-respected',
  title: 'withdrawn labels and operator parks survive new pushes and promote after release',
  card: 'official park regression (existing guards already refuse on main)',
  fixedBy: { sha: 'working-tree', where: 'draft promotion last-read guards' },
  fixPresent() {
    return ['label', 'marker'].every(park => !isDraftOwedPromotion({
      pr: { isDraft: true, headRefName: 'lane/park', headRefOid: 'head',
        labels: park === 'label' ? [WITHDRAWN_LABEL] : [],
        comments: park === 'marker' ? [comment(OPERATOR_PARK_MARKER)] : [] },
      checks: { state: 'green', sha: 'head' },
    }).owed);
  },
  async run() {
    const violations = [];
    const repo = CONSTELLATION_REPOS.we.slug;
    for (const path of ['loop', 'dispatch']) {
      for (const park of ['label', 'marker']) {
        const pr = { number: 1, state: 'OPEN', isDraft: true, headRefName: 'lane/park',
          baseRefName: 'main', labels: [], comments: [], isCrossRepository: false,
          body: '', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }] };
        // The same draft stays parked through two different heads, then releases on that head.
        for (const [push, parked] of [[1, true], [2, true], [2, false]]) {
          const sha = String(push).repeat(40);
          pr.headRefOid = sha;
          const labels = park === 'label' && parked ? [{ name: WITHDRAWN_LABEL }] : [];
          const comments = park === 'marker'
            ? [comment(OPERATOR_PARK_MARKER), ...(!parked ? [comment(OPERATOR_PARK_RELEASE_MARKER)] : [])] : [];
          const ready = () => { pr.isDraft = false; };
          let result;
          if (path === 'loop') {
            let reads = 0;
            result = runDraftPromotionStep({ repos: [repo], listDrafts: () => [pr],
              readHeadCheckState: () => ({ state: 'green' }),
              // Park arrives during the slow reads: only the final view contains it.
              readPrView: () => ({ ...pr, ...( ++reads > 1 ? { labels, comments } : {}) }),
              readAgents: () => [], readClaim: () => null, readRequiredChecks: () => ({ checks: ['test'] }),
              ready, clearAwaiting: () => {},
            });
            const why = park === 'label' ? 'withdrawn' : 'operator-parked';
            if (parked && !result.rows.some(r => r.action === 'skip' && r.why.includes(why))) {
              violations.push(`${path}/${park}: missing park skip on push ${push}`);
            }
          } else {
            result = runReconcilePromoteDraftDispatch({ root: '.', repo,
              checkStaleness: () => ({ fresh: true, behind: 0 }),
              reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 1, headRefOid: sha }], refusals: [] }),
              readHeadCheckState: () => ({ state: 'green' }), readPrLabels: () => labels,
              readComments: () => comments, provider: { ready }, clearAwaitingCi: () => {},
            });
            const kind = park === 'label' ? 'draft-withdrawn' : 'operator-parked';
            if (parked && !result.refusals.some(r => r.kind === kind)) violations.push(`${path}/${park}: missing park refusal`);
          }
          if (pr.isDraft !== parked) violations.push(`${path}/${park}: incorrect draft state on push ${push} (parked=${parked})`);
        }
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
