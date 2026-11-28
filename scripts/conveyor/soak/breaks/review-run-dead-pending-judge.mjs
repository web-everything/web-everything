/** R755: a dead judge-pending cursor must stop holding its head after the authoritative sweep. */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export default {
  id: 'review-run-dead-pending-judge',
  title: 'an authoritative version-bound tombstone releases a dead judge-pending review',
  card: 'REVIEW-RUN-DEAD-PENDING-JUDGE',
  fixedBy: { sha: 'HEAD', where: 'working-tree', paths: ['scripts/lib/reap-dead-review-runs.mjs',
    'scripts/lib/run-abandoned.mjs', 'scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/review-red-team-on-skip.mjs'] },
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-dead-judge-')), violations = [];
    try {
      const load = name => import(pathToFileURL(join(sourceRoot, name)).href);
      const { newRunRecord } = await load('scripts/operations/run-record.mjs');
      const { reapDeadReviewRuns } = await load('scripts/lib/reap-dead-review-runs.mjs');
      const { readDrainRedTeamEvidence } = await load('scripts/lib/drain-red-team-evidence.mjs');
      const { headNeverReviewedFromRuns } = await load('scripts/lib/review-red-team-on-skip.mjs');
      const runs = join(root, 'runs'), jobs = join(root, 'jobs'); mkdirSync(runs); mkdirSync(jobs);
      const repo = 'fixture/repo', pr = 7603, head = '5f9446e' + 'a'.repeat(33), now = Date.parse('2026-11-27T23:00:00Z');
      const id = 'review-pr-pr7603-dead';
      const record = { ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
        findings: { read: { netBasis: { rev: head } } }, pending: { kind: 'judge', step: 'judgeAdvisory', stepIndex: 0 } };
      writeFileSync(join(runs, `${id}.json`), JSON.stringify(record));
      utimesSync(join(runs, `${id}.json`), new Date(now - 6 * 3600000), new Date(now - 6 * 3600000));
      const env = { HOME: root, WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'),
        OPERATION_REVIEW_JOBS_DIR: jobs, WE_SHARED_RUNS_DIR: runs, WE_COORDINATION_ROOT: join(root, 'coordination') };
      const args = { repo, pr, head, env, runsDir: runs, now, host: 'fixture-host', namespace: 'fixture-namespace', isAlive: () => false, readPidStart: () => 'start', readScorecards: () => [] };
      if (readDrainRedTeamEvidence(args).reason !== 'review-unfinished') violations.push('before: dead judge must hold');
      const result = await reapDeadReviewRuns({ dir: runs, repo, env, now, apply: true, log: () => {},
        probeContext: { checkout: root, pool: 'fixture', poolRoot: join(root, 'pools') },
        probes: { reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' } });
      if (!result.reaped.includes(id)) violations.push('after: authoritative sweep did not tombstone the run');
      if (readDrainRedTeamEvidence(args).reason === 'review-unfinished') violations.push('after: dead run still holds evidence');
      if (!headNeverReviewedFromRuns(args)) violations.push('after: dead run still prevents a fresh review');
    } catch (error) { violations.push(`reproduction failed: ${error.message}`); }
    finally { rmSync(root, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
