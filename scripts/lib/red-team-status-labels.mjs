/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { redTeamOwedOnHead, restampedCardOnlyRedTeamExemption } from './review-red-team-policy.mjs';
import { readRedTeamDisposition, readRedTeamProbes, unknownOperatorOutcomes } from './red-team-gate.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { execFileSync } from 'node:child_process';
import { computeClearanceCoverage } from './approval-binding.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, standingRuling = null, clearanceCoverage = null,
  savedResult = null, realFilesCardOnly = false } = {}) {
  const disposition = readRedTeamDisposition({ comments, pr, head, env, repo, standingRuling, clearanceCoverage, savedResult });
  const verdict = evidence.status?.status === 'finished' ? evidence.status.result?.foldedVerdict : null;
  const finished = verdict === 'changes' ? 'red-team:blocked' : verdict === 'accept' ? 'red-team:clear' : null;
  const desired = disposition.sendBack.length || disposition.held.length ? 'red-team:blocked'
    : disposition.result?.recheckIncomplete ? 'red-team:pending'
    : disposition.result ? 'red-team:clear'
      : finished ? finished
      : restampedCardOnlyRedTeamExemption({ ...evidence, head, realFilesCardOnly }) ? 'red-team:clear'
      : redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read, evidence, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly }) ? 'red-team:pending' : null;
  const names = labels.map(l => typeof l === 'string' ? l : l?.name);
  return { add: desired && !names.includes(desired) ? desired : null,
    // With nothing owed and no result (`desired` null) a hold label (pending or blocked) must not be dropped on
    // unreadable or missing local evidence: only a recorded outcome replaces it.
    remove: names.filter(l => RED_TEAM_STATUS_LABELS.includes(l) && l !== desired
      && !(desired === null && (l === 'red-team:pending' || l === 'red-team:blocked'))) };
}

/** Uses the existing label provider/writer, including the known-label metadata provisioning path. */
export function syncRedTeamStatusLabels({ repo, pr, head, evidence = {}, env = process.env,
  provider = createGhProvider(), log = () => {}, live, comments, dryRun = false, standingRuling, readGrantScope = standingRulingScope, clearanceCoverage,
  exec = execFileSync, savedResult = null, realFilesCardOnly = false } = {}) {
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { add: null, remove: [] };
  const state = live ?? provider.readPrState(repo, pr);
  if (state.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
  const thread = comments ?? provider.readComments(repo, pr);
  // A newer reader's operator ruling this code cannot read: leave the label to that reader (never re-derive over it).
  const unknown = unknownOperatorOutcomes(thread, pr, head);
  if (unknown.length) {
    log(`red-team-status-labels: ${repo}#${pr} skipped — operator ruling outcome(s) ${unknown.join(', ')} unknown to this reader (older code)`);
    return { add: null, remove: [], skipped: 'unknown-operator-outcome' };
  }
  // The verified standing-ruling scope (PR #5758): given by the caller, else read fresh; unreadable = no automatic credit.
  let scope = standingRuling ?? null;
  if (standingRuling === undefined) {
    try { scope = readGrantScope({ repo, pr: { number: Number(pr), headRefOid: head, comments: thread } }) ?? null; } catch { scope = null; }
  }
  // approval-binding: every status writer shares one coverage read (complete thread, formal reviews, read-only git in this
  // checkout), lazily — only when the sha rule fails on a recorded clearance. `null` disables it (sha rule only).
  const coverage = clearanceCoverage !== undefined ? clearanceCoverage
    : (h) => computeClearanceCoverage({ comments: thread, liveHead: h, exec, reviews: () => provider.readPrReviews(repo, pr) });
  const plan = planRedTeamStatusLabels({ ...state, repo, pr, head, evidence, env, comments: thread, standingRuling: scope, clearanceCoverage: coverage,
    savedResult, realFilesCardOnly });
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
