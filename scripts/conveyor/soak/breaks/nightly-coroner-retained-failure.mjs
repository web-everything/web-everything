/** PR #5487: the 10-16 failed ledger row must not poison every subsequent health tick. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNightlyCoronerJob } from '../../nightly-coroner-job.mjs';
import { createJobStore } from '../../../lib/daemon-jobs-runtime.mjs';
import { emptyHealthState, runHealthTick } from '../../health-watch-core.mjs';
import smell from '../../health-smells/nightly-coroner-failed.mjs';

const SOURCE = 'scripts/conveyor/nightly-coroner-job.mjs';
export default {
  id: 'nightly-coroner-retained-failure',
  title: 'a retained failed night clears from health alerts when a later night succeeds',
  card: 'PR #5487',
  fixedBy: { sha: 'HEAD', where: 'lane/coroner-job-fix', paths: [SOURCE, 'scripts/conveyor/health-watch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('r.input.night === night'); },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-coroner-ledger-'));
    const violations = [];
    try {
      const store = createJobStore(join(root, 'jobs')), statusFeed = join(root, 'feed.jsonl');
      const options = { store, statusFeed, dir: root, sourceRoot: root, config: {}, codeSha: 'abc', snapshot: {}, reattach: async () => {}, evict: () => {} };
      const run = (at) => runNightlyCoronerJob({ ...options, now: Date.parse(at) });
      const first = await run('2026-10-17T02:17:00Z');
      store.update(first.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'failed', error: 'no lane within 0ms (lock contention)' } }));
      const failed = await run('2026-10-17T03:00:00Z');
      if (failed.alerts.length !== 1) violations.push('current failed night did not alert');
      let health = runHealthTick(emptyHealthState(), { nightlyCoronerStatus: { alerts: failed.alerts, threshold: 3 } }, [smell], Date.parse('2026-10-17T03:00:00Z')).state;
      const feed = readFileSync(statusFeed, 'utf8');
      const next = await run('2026-10-18T02:17:00Z');
      store.update(next.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'succeeded' } }));
      for (const at of ['2026-10-18T03:00:00Z', '2026-10-18T03:01:00Z', '2026-10-18T03:02:00Z']) {
        const result = await run(at);
        if (result.alerts.length || result.failures.length) violations.push('old failed night still returned as a current failure');
        health = runHealthTick(health, { nightlyCoronerStatus: { alerts: result.alerts, threshold: 3 } }, [smell], Date.parse(at)).state;
      }
      if (Object.values(health.episodes).some((ep) => ep.subject === first.enqueued)) violations.push('old failure episode never closed');
      if (readFileSync(statusFeed, 'utf8') !== feed) violations.push('historical failure republished to feed');
      if (store.list().records.length !== 2) violations.push('once-per-night ledger was pruned');
      log?.(`retained ledger: ${store.list().records.length} records; ${violations.length} violations`);
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
