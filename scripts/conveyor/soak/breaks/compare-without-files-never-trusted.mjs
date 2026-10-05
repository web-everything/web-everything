/**
 * @file breaks/compare-without-files-never-trusted.mjs — PR #3881 operator ruling (block, escalation rung 2), follow-up
 * to `capped-compare-scope-never-trusted`. When `gh pr diff` answers HTTP 406 `too_large`, fix-dispatch reads the file
 * list from `compare/<base>...<head>` and returned it before ever asking `pulls/<n>/files` whenever it held fewer than
 * 300 paths. A compare answer with NO `files` array read as zero paths (`.files[]?.filename` yields nothing), so it
 * was returned as the PR's complete scope: an item-less PR was refused `no-scope` forever, and an item PR was
 * dispatched with an empty overlap scope (overlap understated).
 *
 * Fix: `completeCompareFiles` only trusts a compare answer that is provably complete (a `files` array, every entry
 * named, raw count under 300); anything else falls through to `pulls/<n>/files`.
 *
 * SCENARIO: one item-less `review:changes` PR changes 130 files (over the 100-entry carried-files trust cap, so the
 * scope read goes to `gh`). `gh pr diff` answers the 406, and every compare answer carries no `files` array (the
 * fake-`gh` `no-files` fault); `pulls/<n>/files` answers normally. RED = the `owed` invariant fires for that PR's fix
 * (the empty compare answer is taken as "no files", so no fixer is spawned). GREEN = the read falls through to
 * `pulls/<n>/files` and the fix dispatches on all 130 paths.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';

const ROUNDS = 9;
/** Over the 100-entry carried-files trust cap, so the scope read really goes to `gh pr diff`. */
const BIG_PR_FILES = 130;
const FAULT_TIMES = 400;

export default {
  id: 'compare-without-files-never-trusted',
  title: 'fix-dispatch takes a compare answer with no file list as "no files changed" and never asks pulls/files',
  card: 'PR #3881 operator ruling (block) — compare fallback accepts a truncated response as the complete PR scope',
  fixedBy: { sha: '81215f139', where: 'lane/fix-polluted-branch-scope-read', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) {
    try {
      return /completeCompareFiles/.test(readFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), 'utf8'));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:compare-without-files-never-trusted',
      rounds: ROUNDS,
      daemons: ['fix-dispatch'],
      mainEvery: 0,
      lanes: 1,
      fleet: false,
      scorecards: false,
      setup(w) {
        const files = {};
        for (let i = 0; i < BIG_PR_FILES; i += 1) files[`soak/nofiles/f${String(i).padStart(3, '0')}.txt`] = `file ${i}\n`;
        const head = 'lane/soak-compare-no-files';
        w.git.createBranch('we', head, { from: 'main', files });
        const pr = w.gh.openPr({ repo: 'we', head, title: 'soak: a too-large PR whose compare answer has no file list', labels: ['review:changes'], body: 'No backlog item.' });
        w.gh.comment('we', pr, '1. soak finding: the change needs a test', { author: 'review-bot' });
        w.gh.fault({ verb: 'pr diff', kind: 'too-large', times: FAULT_TIMES });
        w.gh.fault({ verb: 'api compare', kind: 'no-files', times: FAULT_TIMES });
        return { pr };
      },
      perRound(w, round, ctx, api) {
        if (!ctx.owed) { api.owe(ctx.pr, 'fix', 'review:changes on a too-large PR whose compare answer has no files array'); ctx.owed = true; }
      },
      log,
    });
  },
  judge(report) {
    return [...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['owed', 'crash', 'isolation'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`)];
  },
};
