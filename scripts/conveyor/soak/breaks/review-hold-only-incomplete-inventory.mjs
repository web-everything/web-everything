/** LIVE 2026-11-09, PRs #6612/#6621: `review-gate` is red BY DESIGN while a PR sits under a review hold, with every other
 *  check green. The reconcile pass's timeout evidence dropped it as a derived check, found no failed jobs, and reported
 *  `incomplete-failure-inventory`, so reconcile filed an operator ruling-needed event ("incomplete failure inventory ...
 *  rerun spent") for a PR whose CI was green. When review-gate is the SOLE red check the honest answer is
 *  `no-primary-failed-checks`. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'review-hold-only-incomplete-inventory',
  title: 'A PR whose only red check is the by-design review-gate is reported as an incomplete failure inventory instead of no-primary-failed-checks',
  card: 'reconcile ruling-needed noise for review-hold-only PRs #6612/#6621',
  fixedBy: { sha: '9c306d5537', where: 'lane/review-hold-only-inventory', paths: ['scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('reviewHoldOnly'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const repo = 'o/r';
    const head = 'c'.repeat(40);
    const url = (run, job) => `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
    const json = JSON.stringify;
    const exec = (_c, [, path]) => {
      if (/\/pulls\/7$/.test(path)) return json({ head: { sha: head }, base: { sha: 'b' }, state: 'open', changed_files: 1 });
      if (/pulls\/7\/files/.test(path)) return json([{ filename: 'a.ts' }]);
      if (/check-runs/.test(path)) return json({ total_count: 2, check_runs: [
        { id: 1, name: 'test', status: 'completed', conclusion: 'success', details_url: url(50, 1), check_suite: { id: 5 } },
        { id: 2, name: 'review-gate', status: 'completed', conclusion: 'failure', details_url: url(60, 2), check_suite: { id: 6 } },
      ] });
      if (/\/status$/.test(path)) return json({ total_count: 0 });
      throw new Error(`unexpected ${path}`);
    };
    const got = pass.readTimeoutEvidence({ number: 7, headRefOid: head }, { repo, exec });
    const violations = [];
    if (got.eligible !== false || got.reason !== 'timeout-evidence:no-primary-failed-checks') {
      violations.push(`review-gate-only red read as ${json(got)}, want refusal timeout-evidence:no-primary-failed-checks`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
