/** Planner read an all-green but incomplete (or other-head) required-check row set as proof, so it dispatched review. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/reconcile-core.mjs', 'scripts/lib/review-ci-gate.mjs',
  'scripts/lib/review-timing.mjs', 'scripts/conveyor/ci-heal-verdict-recheck.mjs',
  'scripts/conveyor/reconcile-pass.mjs'];
const HEAD = 'c'.repeat(40);

export default {
  id: 'review-ci-ignores-incomplete-rows',
  title: 'review dispatch trusts required-check rows whose evidence is incomplete or for another head',
  card: 'rowsComplete hydration fix (split from #7042)',
  fixedBy: { sha: 'HEAD', where: 'lane/rowscomplete-hydration-fix', paths: PATHS },
  // Fix presence is decided by behaviour (run), not by markers: report present only when the planner refuses.
  fixPresent(root) {
    try {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const { probe } = await import(${JSON.stringify(import.meta.url)}); console.log(JSON.stringify(await probe(${JSON.stringify(root)})));`],
      { encoding: 'utf8', timeout: 60000 });
      return JSON.parse(out.trim().split('\n').pop()).length === 0;
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = await probe(sourceRoot);
    for (const v of violations) log?.(`${v}\n`);
    return { violations };
  },
  judge: report => report.violations,
};

export async function probe(root) {
  const { planReconcile } = await import(pathToFileURL(join(root, PATHS[0])).href);
  const violations = [];
  const row = name => ({ name, status: 'completed', conclusion: 'success' });
  const plan = extra => planReconcile({
    prs: [{ number: 7042, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: 'lane/x',
      headRefOid: HEAD, baseRefName: 'main', labels: ['review:pending'], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [row('test')], ...extra }],
    agents: [], durableCounts: {}, requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' },
    now: Date.parse('2026-11-18T12:00:00Z'),
  });
  const reviews = extra => plan(extra).dispatch.filter(d => d.kind === 'review').length;
  if (reviews({ rowsComplete: true, rowsHead: HEAD }) !== 1) violations.push('complete rows for the head: review not dispatched');
  if (reviews({ rowsComplete: false, rowsHead: HEAD }) !== 0) violations.push('incomplete rows: review dispatched');
  if (reviews({ rowsComplete: true, rowsHead: 'd'.repeat(40) }) !== 0) violations.push('rows for another head: review dispatched');
  if (reviews({ rowsComplete: true }) !== 0) violations.push('rows without a head binding: review dispatched');
  violations.push(...await probeHydration(root));
  return violations;
}

/** Exercise the production hydration shell as well as its downstream planner. All external IO is injected. */
async function probeHydration(root) {
  const { runReconcilePass, defaultReadChecks } = await import(pathToFileURL(join(root, PATHS[4])).href);
  const same = rows => rows;
  const options = { readOnly: true, repo: 'we', readAgents: () => [], enrich: same,
    readRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
    enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
    ...Object.fromEntries(['excuseMergeGateHolds', 'enrichAlreadyLanded', 'enrichBaseRef', 'enrichConflictDisposition',
      'enrichSystemFix', 'enrichEscalationBase', 'enrichFixClaims', 'enrichTimeouts', 'enrichReferralHolds',
      'enrichLedgerHolds', 'enrichReferralAutoResolve', 'enrichRulings', 'enrichCodeQL', 'enrichScopeBloat',
      'enrichOwedMainRule', 'enrichMechanicalRound', 'enrichStandingRulingGrants', 'enrichVerifyGreen'].map(key => [key, same])),
    resolveMainSha: () => null, readPriority: () => null, stepLog: () => {},
    env: { VITEST: 'true', WE_REVIEW_START_AFTER: 'ci-green', WE_REVIEW_START_BEFORE_CI: 'false' },
    now: Date.parse('2026-11-18T12:00:00Z'),
  };
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1,
    name: i ? `optional-${i}` : 'test', head_sha: HEAD, status: 'completed', conclusion: 'success' }));
  const pr = { number: 7160, state: 'OPEN', isDraft: false, headRefName: 'lane/x', headRefOid: HEAD,
    baseRefName: 'main', labels: ['review:pending'], comments: [], mergeStateStatus: 'CLEAN',
    statusCheckRollup: rows, rowsComplete: true, rowsHead: HEAD };
  const violations = [];
  for (const shape of ['complete', 'truncated', 'unreadable-status', 'short-feed']) {
    let reads = 0;
    const plan = runReconcilePass({ ...options,
      readPrs: () => [{ ...pr, rowsComplete: shape === 'complete' }],
      readChecks: args => defaultReadChecks(args, { exec: (_file, argv) => {
        reads++;
        if (argv.some(arg => arg.includes('/check-runs'))) return JSON.stringify([{ total_count: shape === 'short-feed' ? 150 : 100, check_runs: rows }]);
        if (shape === 'unreadable-status') throw new Error('status page unavailable');
        return JSON.stringify([{ total_count: 0, statuses: [] }]);
      } }),
    });
    const expected = ['unreadable-status', 'short-feed'].includes(shape) ? 0 : 1;
    if (plan.dispatch.filter(d => d.kind === 'review').length !== expected) violations.push(`${shape} 100-row rollup: expected ${expected} reviews`);
    if (reads !== (shape === 'complete' ? 0 : 2)) violations.push(`${shape} 100-row rollup: unexpected hydration read count ${reads}`);
  }
  return violations;
}
