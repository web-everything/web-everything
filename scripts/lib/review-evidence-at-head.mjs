/** Completed review evidence pinned to the requested repo/PR/head, shared by drain and daemon. */
import { listRunIds, readRun } from '../operations/run-store.mjs';
import { isCompletedReviewPr } from '../operations/review-pr-completion.mjs';
import { savedRedTeamRunsDir } from './saved-red-team-provenance.mjs';

export function readReviewEvidenceAtHead({ repo, pr, head, env = process.env }) {
  const runsDir = savedRedTeamRunsDir(env);
  const at = run => Math.max(0, ...(run.stepTimings ?? []).flatMap(t =>
    [Date.parse(t.startedAt) || 0, Date.parse(t.finishedAt) || 0]));
  const run = listRunIds(runsDir).filter(id => id.startsWith('review-pr-')).map(id => readRun(id, runsDir))
    .filter(run => run.op === 'review-pr' && run.input?.repo?.toLowerCase() === repo.toLowerCase()
      && Number(run.input?.pr) === Number(pr) && run.findings?.read?.netBasis?.rev === head)
    .sort((a, b) => at(b) - at(a))[0];
  return run && isCompletedReviewPr(run) ? { runId: run.id, verdict: run.verdict, findings: run.findings } : null;
}
