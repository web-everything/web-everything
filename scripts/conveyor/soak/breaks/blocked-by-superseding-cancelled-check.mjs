/** LIVE 2026-10-09, PR #4651 (web-everything/web-everything): a ci-heal re-ran an OLDER `soak-replay-gate` run (attempt 2,
 *  green at 18:01:39 ET-4) whose concurrency group cancelled the NEWER run on the same head (cancelled 18:01:04). GitHub
 *  judges a required check by its run in the NEWEST check suite, so it held the PR `BLOCKED` on the cancelled run; the
 *  conveyor's rollup collapse picks the latest `completedAt` (the green re-run), so the PR read phase `queued`,
 *  `nothing-owed`, and the drain skipped it ("owned by the ci-heal / review daemons") every pass. Nobody re-ran it. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'blocked-by-superseding-cancelled-check',
  title: 'A queued PR GitHub holds BLOCKED on a required check whose newest-suite run is CANCELLED is never re-run',
  card: 'unstick PR #4651 (cancelled soak-replay-gate held BLOCKED, drain skips, nobody re-runs)',
  fixedBy: { sha: '5f53e945bc9616f90942507d1fcbd62202af3986', where: 'lane/cancelled-check-rerun', paths: ['scripts/conveyor/infra-cancelled.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('BLOCKED_CANCELLED_RERUN_CAP'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const violations = [];
    const repo = 'o/r';
    const head = 'c'.repeat(40);
    const url = (run, job) => `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
    const json = JSON.stringify;
    // The #4651 shape: soak run 100 (suite 10) re-run to attempt 2 green; newer soak run 200 (suite 20) cancelled by it.
    const restRuns = ({ newerInFlight = false } = {}) => [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success', details_url: url(50, 1), check_suite: { id: 5 } },
      { id: 12, name: 'soak-replay-gate', status: 'completed', conclusion: 'success', details_url: url(100, 12), check_suite: { id: 10 } },
      { id: 11, name: 'soak-replay-gate', status: 'completed', conclusion: 'cancelled', details_url: url(200, 11), check_suite: { id: 20 } },
      ...(newerInFlight ? [{ id: 13, name: 'soak-replay-gate', status: 'in_progress', conclusion: null, details_url: url(300, 13), check_suite: { id: 30 } }] : []),
    ];
    const execFor = (opts) => (_c, [, path]) => {
      if (/\/pulls\/7$/.test(path)) return json({ head: { sha: head }, base: { sha: 'b' }, state: 'open', changed_files: 1 });
      if (/pulls\/7\/files/.test(path)) return json([{ filename: 'a.ts' }]);
      if (/check-runs/.test(path)) { const r = restRuns(opts); return json({ total_count: r.length, check_runs: r }); }
      if (/\/status$/.test(path)) return json({ total_count: 0 });
      if (/actions\/jobs\/11$/.test(path)) return json({ id: 11, run_id: 200, head_sha: head, run_attempt: 1, name: 'soak-replay-gate', status: 'completed', conclusion: 'cancelled', runner_name: 'r1', runner_id: 1, started_at: '2026-10-09T18:00:32Z', completed_at: '2026-10-09T18:01:04Z', steps: [] });
      if (/actions\/runs\/200$/.test(path)) return json({ id: 200, head_sha: head, run_attempt: 1, path: '.github/workflows/soak-replay-gate.yml', repository: { full_name: repo } });
      if (/\/logs$/.test(path)) throw new Error('gh: HTTP 404');
      throw new Error(`unexpected ${path}`);
    };
    const pr = { number: 7, state: 'OPEN', headRefOid: head, headRefName: 'lane/x', isDraft: false, mergeStateStatus: 'BLOCKED',
      labels: [{ name: 'ready-to-merge' }], comments: [],
      statusCheckRollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: url(50, 1), completedAt: '2026-10-09T17:58:00Z' },
        { name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: url(200, 11), completedAt: '2026-10-09T18:01:04Z' },
        { name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: url(100, 12), completedAt: '2026-10-09T18:01:39Z' },
      ] };
    const plan = (budget, opts = {}) => planReconcile({
      prs: pass.enrichPrsWithTimeoutEvidence([pr], { repo, enabled: true, readBudget: () => budget,
        read: (p, o) => pass.readTimeoutEvidence(p, { ...o, exec: execFor(opts) }) }),
      agents: [], durableCounts: {}, now: Date.parse('2026-10-09T19:20:00Z'), requiredChecks: ['test', 'soak-replay-gate'] });
    const rerunOf = (p) => p.dispatch.find((d) => d.prNumber === 7 && d.kind === 'ci-timeout-rerun');
    const first = plan({ confirmed: 0, pending: false });
    const row = rerunOf(first);
    if (!row) violations.push(`no re-run planned for the BLOCKED queued PR; refusals: ${first.refusals.map((r) => `${r.kind}:${r.why}`).join(' | ').slice(0, 240)}`);
    else if (!(row.timeoutRetry?.jobs ?? []).every((j) => j.run === 200) || !row.timeoutRetry.jobs.length) {
      violations.push(`re-run targets the wrong run(s): ${json(row.timeoutRetry?.jobs)} (want only the newest-suite cancelled run 200)`);
    } else if (row.timeoutRetry.cap !== 2) violations.push(`re-run cap is ${row.timeoutRetry.cap}, want 2 per head`);
    if (rerunOf(plan({ confirmed: 2, pending: false }))) violations.push('re-run still planned after 2 confirmed re-runs on this head (unbounded)');
    if (rerunOf(plan({ confirmed: 0, pending: false }, { newerInFlight: true }))) violations.push('re-run planned while a newer run of the same check is in flight');
    return { violations };
  },
  judge(report) { return report.violations; },
};
