/** Only a version-bound tombstone releases parked advisory work; it never supplies the payload. */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newRunRecord, writeRun } from '../../../operations/run-store.mjs';
import { abandonedPath, runRecordVersion } from '../../../lib/run-abandoned.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/drain-red-team-evidence.mjs';

export default {
  id: 'red-team-advisory-parked-after-accept',
  title: 'a valid tombstone releases advisory work; missing or stale tombstones hold',
  card: '#7167 tombstone-bound advisory recovery',
  fixedBy: { sha: 'pending', where: 'committee decision', paths: [SOURCE] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: scenario } = await import(process.argv[1]);
      const report = await scenario.run({ sourceRoot: process.argv[2] });
      process.exitCode = scenario.judge(report).length ? 1 : 0;
    `, import.meta.url, root], { cwd: root, env: process.env, encoding: 'utf8',
      timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { readRecoveryWitness } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-red-team-advisory-'));
    try {
      const runsDir = join(dir, 'runs'), repo = 'example/soak-repo', pr = 7151, head = 'a'.repeat(40);
      const accepted = { ...newRunRecord({ id: 'review-pr-accepted', op: 'review-pr', input: { repo, pr } }),
        verdict: { verdict: 'accept', humanRequired: false }, findings: { read: { netBasis: { rev: head } } },
        pending: null, effects: [{ key: 'record-label', type: 'review.label-swap', stepIndex: 1, index: 0, status: 'applied' }],
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(1000).toISOString() }] };
      const parked = { ...accepted, id: 'review-pr-advisory',
        pending: { kind: 'effect', step: 'advise', stepIndex: 2 },
        effects: [{ key: 'review-pr-advisory#2#0', type: 'review.scoped-rereview-shadow', stepIndex: 2, index: 0, status: 'pending' }],
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(15_000).toISOString() }] };
      utimesSync(writeRun(accepted, runsDir), 12, 12);
      const parkedPath = writeRun(parked, runsDir);
      utimesSync(parkedPath, 20, 20);
      const read = () => readRecoveryWitness({ repo, pr, head, runsDir, env: { WE_SHARED_RUNS_DIR: runsDir },
        now: 30_000, readScorecards: () => [], scanSettings: { file: {}, platform: {}, env: {} } });
      const missing = read();
      const sidecar = abandonedPath(parked.id, runsDir);
      writeFileSync(sidecar, JSON.stringify({ at: new Date(25_000).toISOString(), reason: 'owner proven dead',
        by: 'session-reaper', probes: { recordVersion: runRecordVersion(statSync(parkedPath)),
          reviewJobs: 'dead', handles: 'dead', writers: 'dead', leases: 'absent', sessions: 'absent' } }));
      utimesSync(sidecar, 25, 25);
      const valid = read();
      // Atomic replacement at the same mtime invalidates the old version binding.
      utimesSync(writeRun(parked, runsDir), 20, 20);
      const stale = read();
      const observations = {
        missingHolds: missing?.ok === false && missing.reason === 'review-unfinished',
        validReleases: valid?.ok !== false && valid?.newest?.id === accepted.id,
        staleHolds: stale?.ok === false && stale.reason === 'review-unfinished',
      };
      return { observations, violations: Object.entries(observations).filter(([, passed]) => !passed)
        .map(([invariant]) => ({ invariant, detail: 'tombstone-bound advisory recovery behaviour violated' })) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
