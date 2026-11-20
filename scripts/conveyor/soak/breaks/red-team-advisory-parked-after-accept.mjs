/** D/R755: unresolved writes keep escalation; safe abandonment permits a fresh panel. */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'red-team-advisory-parked-after-accept', title: 'dead advisory owners retain unknown-write fences before a fresh panel',
  card: 'R755', fixedBy: { sha: 'design-D', where: 'design-D', paths: ['scripts/lib/review-red-team-on-skip.mjs'] },
  // The scenario's observed decisions are the authority, including on a tree without D.
  fixPresent: () => true,
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-D-'));
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { writeRun, newRunRecord } = await load('scripts/operations/run-store.mjs');
      const { markRunAbandoned, runRecordVersion } = await load('scripts/lib/run-abandoned.mjs');
      const { readDrainRedTeamEvidence } = await load('scripts/lib/drain-red-team-evidence.mjs');
      const { planRedTeamOnSkip } = await load('scripts/lib/review-red-team-on-skip.mjs');
      const repo = 'web-everything/web-everything', pr = 7116, head = 'a'.repeat(40), id = 'review-pr-parked';
      const runsDir = join(dir, 'runs'), env = { WE_SHARED_RUNS_DIR: runsDir, OPERATION_RUNS_DIR: runsDir };
      const key = { repo, pr, head, runsDir, env, readScorecards: () => [] };
      const make = (id, at) => ({ ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
        verdict: { verdict: 'accept' }, findings: { read: { repo, pr, netBasis: { rev: head } } },
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(at).toISOString() }] });
      writeRun(make('review-pr-old-accept', 1000), runsDir);
      writeRun({ ...make(id, 2000), pending: { kind: 'effect', step: 'advise', stepIndex: 1 },
        effects: [{ key: 'note', type: 'review.note', stepIndex: 1, index: 0, status: 'failed', attempts: 2, unknownAttempts: 2 }] }, runsDir);
      markRunAbandoned({ id, dir: runsDir, reason: 'owner dead', by: 'soak', probes: { owner: 'dead', recordVersion: runRecordVersion(statSync(join(runsDir, `${id}.json`))) } });
      const held = readDrainRedTeamEvidence(key);
      const plan = () => planRedTeamOnSkip({ repo, env, runsDir, now: 2000000,
        refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
        rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: [] }],
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
        readEvidence: () => held, readStatus: () => null, headNeverReviewed: () => false,
        readReviewRuns: () => [{ id, repo, pr, head }] })[0];
      const refused = plan();
      // A person resolves the unknown advisory outcome before a safe fresh panel is permitted.
      writeRun({ ...make(id, 2000), pending: { kind: 'effect', step: 'advise', stepIndex: 1 },
        effects: [{ key: 'note', type: 'review.note', stepIndex: 1, index: 0, status: 'failed', attempts: 2, unknownAttempts: 0 }] }, runsDir);
      markRunAbandoned({ id, dir: runsDir, reason: 'owner dead', by: 'soak',
        probes: { owner: 'dead', recordVersion: runRecordVersion(statSync(join(runsDir, `${id}.json`))) } });
      const decision = plan();
      writeRun(make('review-pr-fresh-accept', 3000), runsDir);
      const released = readDrainRedTeamEvidence(key);
      const checks = {
        unknownWriteEscalates: refused.action === 'skip' && refused.escalate === true,
        tombstoneAloneHolds: held.ok === false && held.reason === 'review-unfinished',
        plannerDispatchesReview: decision.action === 'review'
          && decision.why === 'unfinished review owner proven dead (R755); fresh review on live head',
        freshFinishedAcceptReleases: released.ok !== false && released.loopPayload?.id === 'review-pr-fresh-accept',
      };
      return { checks, violations: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
    } catch (error) { return { violations: [error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
