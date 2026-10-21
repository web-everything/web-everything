/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { readRedTeamDisposition, readRedTeamProbes } from './red-team-gate.mjs';
import { savedRedTeamFallback } from './drain-saved-red-team.mjs';
import { createGhProvider } from './review-label-provider.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, savedResult } = {}) {
  const disposition = readRedTeamDisposition({ comments, pr, head, env, savedResult, repo });
  const names0 = labels.map(l => typeof l === 'string' ? l : l?.name);
  // #5608 — a red-team record that is provably over and never owed (`overNotOwed`, see the evidence reader) shows no
  // pending label on a PR that is not accepted. An accepted PR keeps its pending label: the drain still holds it.
  const overNotOwed = evidence.overNotOwed === true && !names0.includes('review:accepted');
  const desired = disposition.sendBack.length || disposition.held.length ? 'red-team:blocked'
    : disposition.result?.recheckIncomplete ? 'red-team:pending'
      : disposition.result ? 'red-team:clear'
      : overNotOwed ? null
      : redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read, evidence, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly }) ? 'red-team:pending' : null;
  const names = labels.map(l => typeof l === 'string' ? l : l?.name);
  return { add: desired && !names.includes(desired) ? desired : null,
    remove: names.filter(l => RED_TEAM_STATUS_LABELS.includes(l) && l !== desired) };
}

/** Uses the existing label provider/writer, including the known-label metadata provisioning path. */
export function syncRedTeamStatusLabels({ repo, pr, head, evidence = {}, env = process.env,
  provider = createGhProvider(), log = () => {}, live, comments, savedResult, dryRun = false } = {}) {
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { add: null, remove: [] };
  const state = live ?? provider.readPrState(repo, pr);
  if (state.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
  const thread = comments ?? provider.readComments(repo, pr);
  if (savedResult === undefined && !readRedTeamDisposition({ comments: thread, pr, head, env }).result) {
    try { savedResult = savedRedTeamFallback({ repo, pr, head, env })(); }
    catch (error) { log(`red-team-status-labels: saved result unavailable: ${error.message}`); }
  }
  const plan = planRedTeamStatusLabels({ ...state, repo, pr, head, evidence, env, comments: thread, savedResult });
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
