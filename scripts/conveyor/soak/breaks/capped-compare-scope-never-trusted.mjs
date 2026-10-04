/**
 * @file breaks/capped-compare-scope-never-trusted.mjs — PR #3881 review (CONFIRMED correctness, block), follow-up to
 * `too-large-pr-diff-scope-read`. When `gh pr diff` answers HTTP 406 `too_large`, fix-dispatch reads the file list
 * from `compare/<base>...<head>` instead. GitHub's compare endpoint lists AT MOST 300 changed files (it paginates
 * commits, not files), so a compare answer of 300 paths may be a silently truncated scope — yet it was returned as the
 * PR's complete scope, so a fixer was dispatched with a fence and an overlap check that miss every file past the 300th.
 * Before the 406 fallback existed such a PR was refused; the fallback made it strictly worse.
 *
 * Fix: a compare list that reaches 300 falls through to `pulls/<n>/files` (cap 3000), and a list that is also capped
 * (or unreadable) refuses the PR permanently (`scope-too-large`) instead of returning a partial scope.
 *
 * SCENARIO: one item-less `review:changes` PR changes 301 files (one over the compare cap). `gh pr diff` answers the 406 (persistent fault), the
 * fake `compare` endpoint is capped at 300 paths exactly like GitHub, and `pulls/<n>/files` is made unreadable (5xx
 * fault) — so the ONLY answer available is the truncated 300-path compare list. RED = a `fix` session is dispatched at
 * the PR on that partial scope (`fix-on-truncated-scope`). GREEN = the PR is refused `scope-too-large` and no fixer
 * session is ever spawned.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { sessionMatches } from '../invariants.mjs';

/** `perRound` runs BEFORE its round's tick, so a dispatch is seen one round later; 3 rounds inspects two ticks. */
const ROUNDS = 3;
/** Over GitHub's 300-file compare cap, and over the 100-entry carried-files trust cap so the scope read goes to `gh`. */
const BIG_PR_FILES = 301;
const FAULT_TIMES = 400;

export default {
  id: 'capped-compare-scope-never-trusted',
  title: 'fix-dispatch accepts a 300-file compare answer (GitHub\'s cap) as the complete scope of a too-large PR and dispatches a fixer on it',
  card: 'PR #3881 review (block) — compare fallback accepts a truncated 300-file response',
  fixedBy: { sha: '0c8dbfea8', where: 'lane/fix-polluted-branch-scope-read', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) {
    try {
      return /MAX_COMPARE_FILES/.test(readFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), 'utf8'));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:capped-compare-scope-never-trusted',
      rounds: ROUNDS,
      daemons: ['fix-dispatch'],
      mainEvery: 0,
      lanes: 1, // fix-dispatch never acquires a lane here; one keeps world setup short under load
      fleet: false,
      scorecards: false,
      setup(w) {
        const files = {};
        for (let i = 0; i < BIG_PR_FILES; i += 1) files[`soak/capped/f${String(i).padStart(3, '0')}.txt`] = `file ${i}\n`;
        const head = 'lane/soak-capped-compare';
        w.git.createBranch('we', head, { from: 'main', files });
        const pr = w.gh.openPr({ repo: 'we', head, title: 'soak: a PR over the 300-file compare cap', labels: ['review:changes'], body: 'No backlog item.' });
        w.gh.comment('we', pr, '1. soak finding: the change needs a test', { author: 'review-bot' });
        w.gh.fault({ verb: 'pr diff', kind: 'too-large', times: FAULT_TIMES });
        w.gh.fault({ verb: 'api pulls/files', kind: '5xx', times: FAULT_TIMES });
        return { pr, reported: false };
      },
      perRound(w, round, ctx, api) {
        if (ctx.reported) return;
        const hit = w.claude.sessions().find((s) => sessionMatches(s.name, 'fix', ctx.pr));
        if (hit) {
          ctx.reported = true;
          api.violation('fix-on-truncated-scope', `PR #${ctx.pr} changes ${BIG_PR_FILES} files but only a 300-path compare list was readable, yet fix session "${hit.name}" was dispatched on that partial scope (seen before round ${round})`);
        }
      },
      log,
    });
  },
  judge(report) {
    return [...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['fix-on-truncated-scope', 'crash', 'isolation'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`)];
  },
};
