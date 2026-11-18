/** Live send-back: string labels must outrank an older accepted/queued snapshot. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planReconcile } from '../../reconcile-core.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildReviewedShaMarker } from '../../../lib/review-escalation.mjs';

export default {
  id: 'live-changes-stale-accepted-phase',
  title: 'live string review:changes dispatches past stale acceptance; an unanswered stand-down emits exactly one operator note',
  card: 'live review:changes ignored behind an older accepted/queued phase',
  fixedBy: { sha: '02eeb4e57f', where: 'lane/live-review-changes', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8')
      .includes('labels: labelNames(pr?.labels).map(name => ({ name }))');
  },
  run({ log } = {}) {
    const head = 'b'.repeat(40);
    const pr = {
      number: 1563, state: 'OPEN', isDraft: false,
      headRefName: 'lane/soak-live-changes', headRefOid: head,
      labels: ['review:changes'], phase: 'queued', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
      comments: [
        { author: { login: 'web-everything' }, createdAt: '2026-08-26T15:00:00Z',
          body: buildReviewedShaMarker('a'.repeat(40)) },
        { createdAt: '2026-08-26T16:00:00Z',
          body: '🔁 human review — changes requested\n\nRepair the scope guard.' },
      ],
    };
    const plan = snapshot => planReconcile({ prs: [snapshot], agents: [], requiredChecks: ['gate'],
      now: Date.parse('2026-08-26T17:34:00Z') });
    const dispatch = plan(pr);
    const held = plan({ ...pr, comments: [...pr.comments, {
      author: { login: 'web-everything' }, createdAt: '2026-08-26T17:00:00Z',
      body: buildStandDownComment({ reason: 'needs-judgment', head }),
    }] });
    const report = { dispatch, held };
    log?.(JSON.stringify(report));
    return report;
  },
  judge({ dispatch, held }) {
    const violations = [];
    if (dispatch.dispatch?.length !== 1 || dispatch.dispatch[0].kind !== 'fix'
      || dispatch.dispatch[0].prNumber !== 1563 || dispatch.dispatch[0].phase !== 'bounced'
      || dispatch.refusals?.length !== 0) violations.push('live-changes-not-dispatched: stale acceptance hid the fixer obligation');
    if (held.dispatch?.length !== 0 || held.refusals?.length !== 1
      || held.refusals[0].kind !== 'stood-down') violations.push('unanswered-stand-down-dispatched: the question must hold');
    if (held.notes?.length !== 1 || held.notes[0].kind !== 'stood-down'
      || held.notes[0].prNumber !== 1563 || !held.notes[0].text?.includes('needs your decision')) {
      violations.push('stand-down-operator-note-count: expected exactly one operator note');
    }
    return violations;
  },
};
