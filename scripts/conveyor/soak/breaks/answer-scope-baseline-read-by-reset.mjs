/** A verified operator answer's scope-baseline must reach the fix daemon's repeated-finding reset. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { buildStandDownComment, standDownTrailerReason } from '../../stand-down.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';

export default {
  id: 'answer-scope-baseline-read-by-reset',
  title: 'the fix daemon reads an answered scope baseline without another repeated-finding stand-down',
  card: 'PR #6703; we:scripts/conveyor/repeated-finding-reset.mjs',
  fixedBy: { sha: 'uncommitted', where: 'operator-answer', paths: ['scripts/conveyor/repeated-finding-reset.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/repeated-finding-reset.mjs'), 'utf8').includes('parseOperatorAnswer(raw)');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:answer-scope-baseline-read-by-reset', rounds: 10,
      daemons: ['fix-dispatch'], mainEvery: 0, fleet: false, scorecards: false,
      setup(w, { api }) {
        const head = 'lane/soak-answer-scope-baseline';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/answer.txt': 'scope correction\n' } });
        const pr = w.gh.openPr({ repo: 'we', head, title: 'soak: answered scope baseline', labels: ['review:changes'], body: 'No backlog item.' });
        const finding = '🔁 review — changes requested\nRecorded by agent\n### Findings (1)\n**correctness/bug** (1)\n- `soak/answer.txt:1` — Correct the scope guard.';
        w.gh.comment('we', pr, finding, { author: 'web-everything' });
        w.gh.comment('we', pr, '🔓 conveyor fix-end', { author: 'web-everything' });
        w.gh.comment('we', pr, finding, { author: 'web-everything' });
        w.gh.comment('we', pr, buildStandDownComment({ reason: 'repeated-finding' }), { author: 'web-everything' });
        // Use the reader's comment id, as the operator-answer ceremony does.
        const stop = w.gh.pr('we', pr).comments.at(-1);
        w.gh.comment('we', pr, buildOperatorAnswer({ standDownId: String(stop.id), actor: 'chalbert', channel: 'Codex chat',
          reason: `Scope correction approved. scope-baseline: ${'b'.repeat(40)}` }), { author: 'chalbert' });
        api.owe(pr, 'fix', 'operator answered with a scope baseline');
        return { pr, initialComments: w.gh.pr('we', pr).comments.length };
      },
      perRound(w, round, ctx, api) {
        if (w.gh.pr('we', ctx.pr).comments.slice(ctx.initialComments)
          .some((c) => standDownTrailerReason(c.body) === 'repeated-finding')) {
          api.violation('repeated-finding-stand-down', 'The fix daemon stood down again despite the answered scope baseline.');
        }
      },
      log,
    });
  },
  judge(report) {
    return [ ...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['owed', 'repeated-finding-stand-down', 'crash', 'isolation'].includes(v.invariant))
      .map((v) => `${v.invariant}: ${v.detail}`) ];
  },
};
