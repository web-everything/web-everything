/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { readFileSync } from 'node:fs';
import { redTeamCardOnly, redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { RED_TEAM_SETTINGS_FILE, readRedTeamDisposition, readRedTeamProbes, redTeamHoldPendingOnly } from './red-team-gate.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

/** readRedTeamProbes swallows an unreadable settings file into the permissive default, which is never proof of the policy. */
function settingsReadable(path) {
  try { JSON.parse(readFileSync(path, 'utf8')); return true; } catch { return false; }
}

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, standingRuling = null, headFiles = null, headVerified = true, settingsPath = RED_TEAM_SETTINGS_FILE } = {}) {
  // The shared hold decision (PR #6622): the sealed stored evidence holds the head unless the posted comment shows the same
  // confirmed breaks. The PERSISTED status is read fresh (never the caller's snapshot, which may predate a publish), so one
  // pass never plans clear for a conflict it just recorded.
  const disposition = readRedTeamDisposition({ comments, pr, head, env, repo, standingRuling });
  // A hold that is only "publication pending" (stored evidence not sealed yet) is no break: pending, never clear.
  const pendingOnly = redTeamHoldPendingOnly(disposition);
  const broken = !pendingOnly && (disposition.sendBack.length || disposition.held.length);
  // A card-only CURRENT head with the skip on and no pass started owes no red team (the bypass writes no status, so a
  // `pending` set earlier would never clear): pending is a false hold. `headFiles` are the CURRENT head's live PR files (never
  // the stored status's read, which may be an older head's); unreadable or empty = unclassifiable = pending stays.
  const cardOnlyNotOwed = headVerified && !broken && !pendingOnly && !disposition.result && !evidence.inFlight && !evidence.recorded && !evidence.scheduled && !evidence.carryConflict
    && evidence.ok !== false && typeof evidence.skipCardOnly === 'boolean' && !(evidence.status?.status === 'finished' && evidence.status.result?.foldedVerdict) && readRedTeamProbes({ env, path: settingsPath }).value.skipCardOnly !== false
    && settingsReadable(settingsPath)
    && evidence.skipCardOnly
    && evidence.status?.status === 'finished' && evidence.status.result?.status === 'skipped' && evidence.status.result.policy === 'card-only'
    && Array.isArray(headFiles) && headFiles.length > 0 && isCardOnlyDiff(headFiles);
  if (cardOnlyNotOwed) {
    return { add: null, remove: labels.map(l => typeof l === 'string' ? l : l?.name).filter(n => n === 'red-team:pending' || n === 'red-team:clear') };
  }
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
  const cardOnlyBypass = desired === null && headVerified
    // Live head files, when read, must also prove card-only (the stored read alone never overrides them).
    && (headFiles == null || (headFiles.length > 0 && isCardOnlyDiff(headFiles))) && evidence.ok !== false && skipCardOnly === true
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
