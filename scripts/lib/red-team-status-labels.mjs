/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { redTeamCardOnly, redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { readFileSync } from 'node:fs';
import { RED_TEAM_SETTINGS_FILE, readRedTeamDisposition, readRedTeamProbes, redTeamHoldPendingOnly } from './red-team-gate.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, standingRuling = null, settingsPath = RED_TEAM_SETTINGS_FILE } = {}) {
  // The shared hold decision (PR #6622): the sealed stored evidence holds the head unless the posted comment shows the same
  // confirmed breaks. The PERSISTED status is read fresh (never the caller's snapshot, which may predate a publish), so one
  // pass never plans clear for a conflict it just recorded.
  const disposition = readRedTeamDisposition({ comments, pr, head, env, repo, standingRuling });
  // A hold that is only "publication pending" (stored evidence not sealed yet) is no break: pending, never clear.
  const pendingOnly = redTeamHoldPendingOnly(disposition);
  const broken = !pendingOnly && (disposition.sendBack.length || disposition.held.length);
  // Unknown run evidence holds, but after the break check: a recorded break still marks the PR blocked.
  if (evidence.ok === false && !broken) {
    const names = labels.map(label => typeof label === 'string' ? label : label?.name);
    return { add: names.includes('red-team:pending') || names.includes('red-team:blocked') ? null : 'red-team:pending',
      remove: names.filter(name => name === 'red-team:clear') };
  }
  const verdict = evidence.status?.status === 'finished' ? evidence.status.result?.foldedVerdict : null;
  const finished = verdict === 'changes' ? 'red-team:blocked' : verdict === 'accept' ? 'red-team:clear' : null;
  const desired = broken ? 'red-team:blocked'
    : pendingOnly ? 'red-team:pending'
    : disposition.result ? 'red-team:clear'
      : finished ? finished
      : redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read, evidence, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly }) ? 'red-team:pending' : null;
  const names = labels.map(l => typeof l === 'string' ? l : l?.name);
  // A head PROVEN card-only (readable net files, skip policy on) with no pass in flight, scheduled or recorded bypasses the
  // red-team pass and never gets an outcome, so its stale pending label would stay forever (#6733). Only pending is dropped:
  // blocked stays, and unreadable evidence or a missing/unknown read never counts as proof.
  // The skip policy must be EXPLICIT: the recorded status says so, or the probe resolves it from a real source (platform/
  // tool/env), or the standard default stands over a settings file that actually read. readRedTeamProbes swallows a read
  // failure into the permissive default, which is never proof (audit probe).
  const probes = readRedTeamProbes({ env, path: settingsPath });
  let fileReadable = false;
  try { JSON.parse(readFileSync(settingsPath, 'utf8')); fileReadable = true; } catch { /* unreadable policy */ }
  const skipCardOnly = typeof evidence.skipCardOnly === 'boolean' ? evidence.skipCardOnly
    : probes.value.skipCardOnly === true && (probes.sources?.skipCardOnly !== 'standard' || fileReadable);
  const cardOnlyBypass = desired === null && evidence.ok !== false && skipCardOnly === true
    && !evidence.inFlight && !evidence.scheduled && !evidence.recorded && !evidence.carryConflict
    // The read must be bound to THIS head: the historical fallback returns an older head's card-only read.
    && String(evidence.loopPayload?.findings?.read?.netBasis?.rev ?? '').toLowerCase() === String(head).toLowerCase()
    // Rename evidence must be present (an array): a missing list could hide a code-to-backlog rename.
    && Array.isArray(evidence.loopPayload?.findings?.read?.netRenameSources)
    && redTeamCardOnly(evidence.loopPayload?.findings?.read);
  return { add: desired && !names.includes(desired) ? desired : null,
    // With nothing owed and no result (`desired` null) a hold label (pending or blocked) must not be dropped on
    // unreadable or missing local evidence: only a recorded outcome replaces it.
    remove: names.filter(l => RED_TEAM_STATUS_LABELS.includes(l) && l !== desired
      && !(desired === null && (l === 'red-team:blocked' || (l === 'red-team:pending' && !cardOnlyBypass)))) };
}

/** Uses the existing label provider/writer, including the known-label metadata provisioning path. */
export function syncRedTeamStatusLabels({ repo, pr, head, evidence = {}, env = process.env,
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
  const plan = planRedTeamStatusLabels({ ...state, repo, pr, head, evidence, env, comments: thread, standingRuling: scope });
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
