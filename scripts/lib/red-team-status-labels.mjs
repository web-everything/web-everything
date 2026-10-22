/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { readRedTeamDisposition, readRedTeamProbes } from './red-team-gate.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { execFileSync } from 'node:child_process';
import { computeClearanceCoverage } from './approval-binding.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, standingRuling = null, clearanceCoverage = null } = {}) {
  const disposition = readRedTeamDisposition({ comments, pr, head, env, repo, standingRuling, clearanceCoverage });
  const desired = disposition.sendBack.length || disposition.held.length ? 'red-team:blocked'
    : disposition.result ? 'red-team:clear'
      : redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read, evidence, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly }) ? 'red-team:pending' : null;
  const names = labels.map(l => typeof l === 'string' ? l : l?.name);
  return { add: desired && !names.includes(desired) ? desired : null,
    remove: names.filter(l => RED_TEAM_STATUS_LABELS.includes(l) && l !== desired) };
}

/** Uses the existing label provider/writer, including the known-label metadata provisioning path. */
export function syncRedTeamStatusLabels({ repo, pr, head, evidence = {}, env = process.env,
  provider = createGhProvider(), log = () => {}, live, comments, dryRun = false, standingRuling, readGrantScope = standingRulingScope, clearanceCoverage,
  exec = execFileSync } = {}) {
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { add: null, remove: [] };
  const state = live ?? provider.readPrState(repo, pr);
  if (state.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
  const thread = comments ?? provider.readComments(repo, pr);
  // The verified standing-ruling scope (PR #5758): given by the caller, else read fresh; unreadable = no automatic credit.
  let scope = standingRuling ?? null;
  if (standingRuling === undefined) {
    try { scope = readGrantScope({ repo, pr: { number: Number(pr), headRefOid: head, comments: thread } }) ?? null; } catch { scope = null; }
  }
  // approval-binding: every status writer shares one coverage read (complete thread, formal reviews, read-only git in this
  // checkout), lazily — only when the sha rule fails on a recorded clearance. `null` disables it (sha rule only).
  const coverage = clearanceCoverage !== undefined ? clearanceCoverage
    : (h) => computeClearanceCoverage({ comments: thread, liveHead: h, exec, reviews: () => provider.readPrReviews(repo, pr) });
  const plan = planRedTeamStatusLabels({ ...state, repo, pr, head, evidence, env, comments: thread, standingRuling: scope, clearanceCoverage: coverage });
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
