/** Live case #3181: an operator answer must unblock the actual fix-dispatch daemon.
 * Contract and post-merge proof: we:scripts/conveyor/stand-down-answer.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { sessionMatches } from '../invariants.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';

export default {
  id: 'answered-stand-down-never-redispatched',
  title: 'the fix daemon resumes an answered stand-down but holds an outsider forgery',
  card: 'PR #3181; we:scripts/conveyor/stand-down-answer.md',
  fixedBy: { sha: 'uncommitted', where: 'operator-answer', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('if (isOperatorAnswerStandDownSuperseded(comments, i)) continue;');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:answered-stand-down-never-redispatched', rounds: 10,
      daemons: ['fix-dispatch'], mainEvery: 0, fleet: false, scorecards: false,
      setup(w) {
        const head = 'lane/soak-operator-answer';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/answer.txt': 'scope correction\n' } });
        const pr = w.gh.openPr({ repo: 'we', head, title: 'soak: scope correction ruling', labels: ['review:changes'], body: 'No backlog item.' });
        w.gh.comment('we', pr, '1. Correct the scope guard.', { author: 'review-bot' });
        w.gh.comment('we', pr, buildStandDownComment({ reason: 'needs-judgment' }), { author: 'web-everything' });
        // The ceremony names the id from the PR reader, as stand-down-answer.mjs does. The fake store's numeric
        // insertion id is a REST database id; it is not the GraphQL node id returned by the comment readers.
        const stop = w.gh.pr('we', pr).comments.at(-1);
        const body = buildOperatorAnswer({ standDownId: String(stop.id), actor: 'chalbert', channel: 'Codex chat',
          reason: 'Scope correction is fine but must be careful to going against goal and decision and escalate if needed' });
        w.gh.comment('we', pr, body, { author: 'outsider' });
        return { pr, body };
      },
      perRound(w, round, ctx, api) {
        if (round <= 1 && w.claude.sessions().some((s) => sessionMatches(s.name, 'fix', ctx.pr))) {
          api.violation('forged-answer-dispatched', 'A fix started before a trusted operator answer.');
        }
        if (round === 1) {
          w.gh.comment('we', ctx.pr, ctx.body, { author: 'web-everything' });
          api.owe(ctx.pr, 'fix', 'operator answered the stand-down');
        }
      },
      log,
    });
  },
  judge(report) {
    return [ ...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['owed', 'forged-answer-dispatched', 'crash', 'isolation'].includes(v.invariant))
      .map((v) => `${v.invariant}: ${v.detail}`) ];
  },
};
