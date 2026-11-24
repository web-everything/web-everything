import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Offline loaded benchmark: 64 failing PRs, 2 ms per graph read and 1 ms per
// signature read. These are controlled reader latencies, not live GitHub timings.
export async function loadedMemoBenchmark() {
  const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
  const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const delay = ms => Atomics.wait(sleeper, 0, 0, ms);
  const prs = Array.from({ length: 64 }, (_, i) => ({ number: i + 1, headRefOid: `loaded-${i}`,
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
      completedAt: '2026-10-01T00:00:00Z' }] }));
  let signatureReads = 0;
  const options = { repo: 'soak/loaded-memo', requiredChecks: ['test'],
    readMainTip: () => 'a'.repeat(40),
    readMainRuns: () => [],
    readMainLatestCheckRuns: () => [{ name: 'test', conclusion: 'success', head_sha: 'green' }],
    readAheadBy: () => { delay(2); return 3; },
    readMainGreenFixFacts: () => { delay(2); return { prContainsMainGreenSha: true }; },
    readMainFixedSignatureFacts: () => { signatureReads++; delay(1); return { signatures: [] }; },
    readJobAttempt: () => 1, readBudget: () => null };
  const tick = () => {
    const start = performance.now();
    pass.enrichPrsWithMainRedFacts(prs, options);
    return performance.now() - start;
  };
  pass.resetMainRedMemo?.();
  try {
    const coldMs = tick();
    const warmMs = tick();
    return { coldMs, warmMs, signatureReads, prCount: prs.length };
  } finally { pass.resetMainRedMemo?.(); }
}

export default {
  id: 'review-speed-main-red-reads-not-memoized',
  title: 'unchanged main-red evidence is reused across review ticks',
  card: 'REVIEW-SPEED-MEMO',
  fixedBy: { sha: '16c167cd20e995e5adc94985e3aa4549fcae2d6d', where: 'lane/review-speed-memo', paths: ['scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) {
    return spawnSync('env', ['git', 'merge-base', '--is-ancestor', this.fixedBy.sha, 'HEAD'],
      { cwd: root, stdio: 'ignore', timeout: 5000 }).status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    pass.resetMainRedMemo?.();
    const calls = { ahead: 0, green: 0 };
    const pr = { number: 1, headRefOid: 'memo-head', statusCheckRollup: [{ name: 'test',
      status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-01T00:00:00Z',
      detailsUrl: 'https://github.com/soak/memo/actions/runs/1/job/2' }] };
    const options = { repo: 'soak/memo', requiredChecks: ['test'],
      readMainTip: () => 'a'.repeat(40),
      readMainRuns: () => [{ headSha: 'memo-main', status: 'queued', createdAt: '2026-10-02T00:00:00Z' }],
      readMainLatestCheckRuns: () => [{ name: 'test', conclusion: 'success', head_sha: 'memo-green' }],
      readAheadBy: () => { calls.ahead++; return 3; },
      readMainGreenFixFacts: () => { calls.green++; return { prContainsMainGreenSha: true, mergeBaseCheckRuns: null }; },
      readMainFixedSignatureFacts: () => ({ signatures: [] }),
      readJobAttempt: () => 1, readBudget: () => null };
    try {
      pass.enrichPrsWithMainRedFacts([pr], options);
      pass.enrichPrsWithMainRedFacts([pr], options);
      const violations = Object.entries(calls).filter(([, count]) => count !== 1)
        .map(([reader, count]) => `${reader} reader ran ${count} times for unchanged evidence`);

      // Same SHAs, but a merge-base run is retried after a successful result.
      // No PR/main-run field advertises this independent rerun to the memo.
      pr.headRefOid = 'mutable-merge-base-head';
      let facts = { prContainsMainGreenSha: false, mergeBaseCheckRuns: [
        { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      ], mergeBaseRunConclusion: 'success' };
      let mutableReads = 0;
      options.readMainGreenFixFacts = () => { mutableReads++; return facts; };
      pass.enrichPrsWithMainRedFacts([pr], options);
      facts = { prContainsMainGreenSha: false, mergeBaseCheckRuns: [
        { id: 2, name: 'test', status: 'in_progress', conclusion: null },
      ], mergeBaseRunConclusion: null };
      const rerun = pass.enrichPrsWithMainRedFacts([pr], options).prs[0];
      if (mutableReads !== 2 || rerun.mergeBaseCheckRuns?.[0]?.id !== 2) {
        violations.push('merge-base rerun reused stale successful evidence');
      }
      return { calls, mutableReads, violations };
    } finally { pass.resetMainRedMemo?.(); }
  },
  judge(report) { return report.violations; },
};
