/** #6744: a dead running red-team owner must recover behind a quiet pending human confirm. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'red-team-dead-owner-behind-pending-confirm', title: 'a dead red-team owner redispatches behind a quiet pending human confirm',
  card: '#6744', fixedBy: { sha: '09bf0e46f2', where: 'lane/redteam-dead-owner-unfinished-review-m2',
    paths: ['scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/review-red-team-on-skip.mjs'] },
  fixPresent: root => ['scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/review-red-team-on-skip.mjs']
    .every(path => readFileSync(join(root, path), 'utf8').includes('unfinishedReviewException')),
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-pending-confirm-red-team-'));
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const e = await load('scripts/lib/drain-red-team-evidence.mjs'), r = await load('scripts/lib/review-red-team-on-skip.mjs');
      const runs = await load('scripts/operations/run-store.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6744, head = 'a'.repeat(40);
      const now = Date.parse('2026-11-13T12:00:00Z'), deadlineMs = 7_200_000, old = new Date(now - 3 * deadlineMs);
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_STALE_RUN_MS: String(deadlineMs) };
      const key = { repo, pr, head, env, now }, id = 'review-pr-pending-confirm';
      const run = { ...runs.newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
        findings: { read: { netBasis: { rev: head }, diffText: '+code', netChangedFiles: ['scripts/example.mjs'] } },
        verdict: { verdict: 'needs-human', humanRequired: true, lensVerdicts: { correctness: 'accept' }, findings: [] },
        pending: { kind: 'confirm', step: 'confirm', stepIndex: 1 }, effects: [],
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: old.toISOString() }] };
      runs.writeRun(run, env.WE_SHARED_RUNS_DIR);
      const runPath = join(env.WE_SHARED_RUNS_DIR, `${id}.json`);
      utimesSync(runPath, old, old);
      const before = readFileSync(runPath, 'utf8');
      mkdirSync(e.redTeamStatusDir(env), { recursive: true });
      const statusPath = join(e.redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
      writeFileSync(statusPath, JSON.stringify({ repo, pr, head, status: 'running', result: null,
        pid: 99999999, host: 'foreign-host', pidNamespace: 'soak-ns', pidStart: old.toISOString(), loopPayload: {} }));
      utimesSync(statusPath, old, old);
      const readWitness = () => e.readRecoveryWitness({ ...key, readScorecards: () => [] });
      const witness = readWitness(), setting = { enabled: true, retryCooldownMin: 30 };
      const recoveryOptions = { now, deadlineMs, env,
        probe: { host: 'local-host', namespace: 'soak-ns', isAlive: () => false } };
      const recovery = witness.ok === false ? null : r.planRedTeamRecovery(witness, { ...recoveryOptions, setting });
      const [decision] = r.planRedTeamOnSkip({ repo, now, setting, lastDispatch: new Map(), readWitness, recoveryOptions,
        refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
        rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [] }], headNeverReviewed: () => false,
        readReviewRuns: () => [], readEvidence: () => e.readDrainRedTeamEvidence({ ...key, readScorecards: () => [] }),
        readStatus: () => e.readRedTeamStatus(key) });
      const drain = e.readDrainRedTeamEvidence({ ...key, readScorecards: () => [] });
      return { violations: witness.unfinishedReviewException === true && witness.newest?.pending?.kind === 'confirm'
        && recovery?.mode === 'fresh' && decision?.action === 'dispatch' && decision.mode === 'fresh'
        && decision.staleRecovery === true && decision.why === 'dead owner recovery' && !decision.escalate
        && drain.ok === false && drain.reason === 'review-unfinished' && readFileSync(runPath, 'utf8') === before
        ? [] : [`dead owner behind pending confirm did not redispatch without settling the review: ${decision?.why}`] };
    } catch (error) { return { violations: [error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
