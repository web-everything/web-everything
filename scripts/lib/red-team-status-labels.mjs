/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { readRedTeamDisposition, readRedTeamProbes } from './red-team-gate.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { buildRedTeamDispositionInputs } from './red-team-disposition-inputs.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, standingRuling = null } = {}) {
  const disposition = readRedTeamDisposition({ comments, pr, head, env, repo, standingRuling });
  const verdict = evidence.status?.status === 'finished' ? evidence.status.result?.foldedVerdict : null;
  const finished = verdict === 'changes' ? 'red-team:blocked' : verdict === 'accept' ? 'red-team:clear' : null;
  const desired = disposition.sendBack.length || disposition.held.length ? 'red-team:blocked'
    : disposition.result ? 'red-team:clear'
      : finished ? finished
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
  provider = createGhProvider(), log = () => {}, live, comments, dryRun = false, standingRuling, readGrantScope } = {}) {
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { add: null, remove: [] };
  const state = live ?? provider.readPrState(repo, pr);
  if (state.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
  const thread = comments ?? provider.readComments(repo, pr);
  const inputs = buildRedTeamDispositionInputs({ repo, pr, head, comments: thread, env, standingRuling, readGrantScope });
  const plan = planRedTeamStatusLabels({ ...state, ...inputs, evidence });
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
