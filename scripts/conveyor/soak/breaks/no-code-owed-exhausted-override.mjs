/** PR #7406: a second cap override reported success although the guard ignored the answer. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStandDownAnswer } from '../../stand-down-answer.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';
import { decideEmptyFixRound } from '../../rearm-review.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';

const HEAD = 'b'.repeat(40);
const trusted = (id, body) => ({ id, body, author: { login: 'web-everything' }, createdAt: '2026-11-14T10:00:00Z' });
const begin = trusted('IC_begin', `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-1 -->`);
const stop = id => trusted(id, buildStandDownComment({ head: HEAD, reason: 'needs-judgment', detail: 'Is code owed?' }));
const answer = (id, noCodeOwed = false) => trusted(`IC_answer_${id}`, buildOperatorAnswer({
  standDownId: id, reason: 'No code owed', actor: 'chalbert', channel: 'chat', disposition: 'rearm-review', noCodeOwed,
}));

export default {
  id: 'no-code-owed-exhausted-override',
  title: 'an exhausted no-code-owed override refuses before posting, including a superseding retry (#7406)',
  card: 'PR #7406',
  fixedBy: { sha: 'pending', where: 'lane/standdown-empty-round', paths: [
    'scripts/conveyor/rearm-review.mjs', 'scripts/conveyor/stand-down-answer.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/stand-down-answer.mjs'), 'utf8').includes('win.wouldHonour(');
  },
  async run() {
    const violations = [];
    const comments = [trusted('IC_verdict', '🔁 review — changes requested'), begin, stop('IC_first'), answer('IC_first'),
      begin, stop('IC_second'), answer('IC_second'), begin, stop('IC_third'), answer('IC_third', true), begin, stop('IC_fourth')];
    for (const retry of [false, true]) {
      const snapshot = { comments: [...comments, ...(retry ? [answer('IC_fourth', true)] : [])],
        labels: [{ name: 'status:answered-waiting-fixer' }], headRefOid: HEAD,
        commits: [{ oid: HEAD, committedDate: '2026-11-14T09:00:00Z' }] };
      let writes = 0;
      let refused = false;
      const gh = args => {
        if (args[1] === 'view') return JSON.stringify(snapshot);
        writes += 1;
        snapshot.comments.push(trusted('IC_posted', args[args.indexOf('--body') + 1]));
        return 'posted';
      };
      try {
        runStandDownAnswer(['7406', '--repo=no-code-owed-fixture/example', '--reason=No code owed',
          '--actor=chalbert', '--channel=chat', '--disposition=rearm-review', '--no-code-owed'], { gh });
      } catch (error) {
        if (!/guard would ignore|no unresolved stand-down/.test(error.message)) throw error;
        refused = true;
      }
      if (!refused || writes !== 0 || !decideEmptyFixRound({ comments: snapshot.comments, liveHead: HEAD }).empty) {
        violations.push(`retry=${retry}: refused=${refused}, writes=${writes}; exhausted override must preserve the empty round without a write`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
