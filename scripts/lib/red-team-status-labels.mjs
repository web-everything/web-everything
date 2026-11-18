/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { redTeamCardOnly, redTeamOwedDecision } from './review-red-team-policy.mjs';
import { RED_TEAM_SETTINGS_FILE, readRedTeamProbes } from './red-team-gate.mjs';
import { readDrainRedTeamEvidence } from './drain-red-team-evidence.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

/** Every label transition derives from the same normalized evidence decision as admission. */
export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence, env = {}, standingRuling = null, headFiles = null, headVerified = true, settingsPath = RED_TEAM_SETTINGS_FILE } = {}) {
  const { decisionInput } = readDrainRedTeamEvidence({ repo, pr, head, env, comments, labels, standingRuling, evidence, settingsPath });
  // A failed head recheck or contradictory live files invalidate stored card-only proof.
  if (redTeamCardOnly(decisionInput.read) && (!headVerified || (headFiles !== null
    && (!Array.isArray(headFiles) || !headFiles.length || !isCardOnlyDiff(headFiles))))) decisionInput.ok = false;
  const decision = redTeamOwedDecision(decisionInput);
  const desired = decision.cleared ? 'red-team:clear'
    : decision.reasons.some(hold => hold.blocking && hold.kind === 'break') ? 'red-team:blocked' : 'red-team:pending';
  const names = labels.map(label => typeof label === 'string' ? label : label?.name);
  // Pending evidence never erases a previously confirmed block.
  return { add: !names.includes(desired) && !(desired === 'red-team:pending' && names.includes('red-team:blocked')) ? desired : null,
    remove: names.filter(name => RED_TEAM_STATUS_LABELS.includes(name) && name !== desired
      && !(name === 'red-team:blocked' && desired === 'red-team:pending')) };
}

/** Uses the existing label provider/writer, including the known-label metadata provisioning path. */
export function syncRedTeamStatusLabels({ repo, pr, head, evidence, env = process.env,
  provider = createGhProvider(), log = () => {}, live, comments, dryRun = false, standingRuling, readGrantScope = standingRulingScope } = {}) {
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { add: null, remove: [] };
  const state = live ?? provider.readPrState(repo, pr);
  if (state.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
  const thread = comments ?? provider.readComments(repo, pr);
  // The verified standing-ruling scope (PR #5758): given by the caller, else read fresh; unreadable = no automatic credit.
  let scope = standingRuling ?? null;
  if (standingRuling === undefined) {
    try { scope = readGrantScope({ repo, pr: { number: Number(pr), headRefOid: head, comments: thread } }) ?? null; } catch { scope = null; }
  }
  // Only a held pending label needs the current head's files: read them lazily, and unreadable stays unclassified.
  let headFiles = null;
  // False when the head re-check could not run: no card-only bypass may drop pending then (fail closed); other transitions plan as usual.
  let headVerified = true;
  if ((state.labels ?? []).some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:pending')) {
    try {
      headFiles = provider.readPrFiles?.(repo, pr, { exact: true }) ?? null;
      // The files API lists at most 3000 files: a list at the cap may be truncated, so it classifies nothing. The head is
      // re-read AFTER the files, and a head that moved meanwhile makes the files someone else's: unclassified.
      if (!Array.isArray(headFiles) || headFiles.length >= 3000) { headFiles = null; headVerified = false; }
      if (provider.readPrState(repo, pr)?.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
    } catch { headFiles = null; headVerified = false; }
  }
  const plan = planRedTeamStatusLabels({ ...state, repo, pr, head, evidence, env, comments: thread, standingRuling: scope, headFiles, headVerified });
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
