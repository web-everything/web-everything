/**
 * @file breaks/too-large-pr-diff-scope-read.mjs — live break, 2026-10-03 (PR #3794). A card-only PR (8 backlog files)
 * showed 309 changed files on GitHub (its recorded base lagged main while the drain's rebuilt tips carried main's
 * commits), so `gh pr diff` answered HTTP 406 `PullRequest.diff too_large` ("exceeded the maximum number of files
 * (300)"). The fix-dispatch scope read (`reconcile-fix-dispatch.mjs#fetchPrDiffPaths`) read every failure as a
 * TRANSIENT `gh` error — `scope-read-failed — retrying next pass` — so the same permanent 406 refused the PR on every
 * pass forever and no fixer ever started, although an operator had sent it back to fix.
 *
 * Fix: `fetchPrDiffPaths` recognises the 406 and reads the file list through the paginated REST endpoints instead
 * (`compare/<base>...<head>`, then `pulls/<n>/files`); only when those fail too is the refusal a distinct, non-retried
 * `scope-too-large`.
 *
 * SCENARIO: one item-less `review:changes` PR changes 130 files. The reconcile pass only trusts a PR's carried file list
 * under 100 entries (`planFixesFromReconcile`'s `entryFiles`), so the scope read goes to `gh pr diff` — which a persistent
 * fake-`gh` fault makes answer exactly GitHub's 406 text. RED = the `owed` invariant fires for that PR's fix (the scope
 * read never recovers, so no fixer session is spawned). GREEN = the fallback reads the file list via the API and the fix
 * dispatches.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';

const ROUNDS = 9;
/** Over the 100-entry carried-files trust cap, so the scope read really goes to `gh pr diff`. */
const BIG_PR_FILES = 130;
const FAULT_TIMES = 400;

export default {
  id: 'too-large-pr-diff-scope-read',
  title: "fix-dispatch retries a permanent HTTP 406 'diff too large' scope read forever, so the PR never gets a fixer",
  card: 'PR #3794 live incident (fix-dispatch scope-read-failed on a 309-file PR)',
  fixedBy: { sha: '438c1da9b391685d105e90c4df602251d029cfd9', where: 'main', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) {
    try {
      return /fetchPrFilesPaginated\(pr,/.test(readFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), 'utf8'));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:too-large-pr-diff-scope-read',
      rounds: ROUNDS,
      daemons: ['fix-dispatch'],
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      setup(w) {
        const files = {};
        for (let i = 0; i < BIG_PR_FILES; i += 1) files[`soak/big/f${String(i).padStart(3, '0')}.txt`] = `file ${i}\n`;
        const head = 'lane/soak-too-large-diff';
        w.git.createBranch('we', head, { from: 'main', files });
        const pr = w.gh.openPr({ repo: 'we', head, title: 'soak: a PR over the 300-file diff limit', labels: ['review:changes'], body: 'No backlog item.' });
        w.gh.comment('we', pr, '1. soak finding: the change needs a test', { author: 'review-bot' });
        w.gh.fault({ verb: 'pr diff', kind: 'too-large', times: FAULT_TIMES });
        return { pr };
      },
      perRound(w, round, ctx, api) {
        if (!ctx.owed) { api.owe(ctx.pr, 'fix', 'review:changes on a PR whose gh pr diff answers 406'); ctx.owed = true; }
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
