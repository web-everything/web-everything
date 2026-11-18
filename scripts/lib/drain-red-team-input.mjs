/** Admission normalization leaf: loading queue policy must not load the review/recovery IO graph. */
import { readRedTeamDisposition, redTeamHoldPendingOnly, redTeamResultCommentForHead, RED_TEAM_SETTINGS_FILE, resolveRedTeamProbes } from './red-team-gate.mjs';

import { readFileSync } from 'node:fs';
import { readPlatformPreferences, PLATFORM_PREFERENCES_ENV, operatorPreferencesPath } from './policy-cascade.mjs';

// Unlike the scheduler's permissive fallback, admission needs a readable, valid cascade.
function admissionSettings({ env, settingsPath, readSettings }) {
  try {
    const file = JSON.parse(readSettings(settingsPath, 'utf8'));
    const configured = String(env?.[PLATFORM_PREFERENCES_ENV] ?? '').trim();
    let configuredRead = !configured;
    const { prefs, errors } = readPlatformPreferences({ env, readFile: (path, ...args) => {
      const data = readSettings(path, ...args);
      if (path === operatorPreferencesPath(env)) configuredRead = true;
      return data;
    } });
    const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    if (!configuredRead || !object(file) || (Object.hasOwn(file, 'redTeam') && !object(file.redTeam))
      || (Object.hasOwn(prefs, 'redTeam') && !object(prefs.redTeam)) || errors.length) return null;
    const resolved = resolveRedTeamProbes({ file, platform: prefs.redTeam, env });
    return resolved.invalid.length ? null : resolved.value;
  } catch { return null; }
}

export function drainRedTeamDecisionInput({ evidence: raw, comments, head, pr, repo, env = process.env,
  standingRuling, confirmedBreaks, settingsPath = RED_TEAM_SETTINGS_FILE, readSettings = readFileSync, readSource = raw?.decisionInput?.readSource } = {}) {
  const disposition = readRedTeamDisposition({ comments, pr, head, repo, env, standingRuling, setting: confirmedBreaks });
  const hit = redTeamResultCommentForHead(comments, pr, head);
  const fromRev = hit?.carriedFrom ?? raw.carry?.loopPayload?.carriedFrom;
  let carry = raw.carry == null ? raw.carry : Object.hasOwn(raw.carry, 'fromRev') ? raw.carry : undefined;
  if (fromRev && !carry) {
    try {
      carry = { fromRev, proof: readSource({ head: fromRev, comments: hit ? comments.slice(0, hit.commentIndex) : [] }) };
    } catch { /* unreadable source is a carry conflict, never payment */ }
  }
  const settings = admissionSettings({ env, settingsPath, readSettings });
  const status = raw.status, resultStatus = typeof status?.result === 'string' ? status.result : status?.result?.status;
  const noExecution = status === null || (status?.head === head && status.status === 'finished'
    && (resultStatus === 'not-owed' || (resultStatus === 'skipped'
      && (typeof status.result === 'string' || status.result.policy === 'card-only'))));
  const sealClear = status === null || (noExecution && ['sealedBreaks', 'sealedPosted'].every(key =>
    !Object.hasOwn(status, key) || (Array.isArray(status[key]) && status[key].length === 0))
    && !Object.hasOwn(status, 'storedFindings')
    && (!Object.hasOwn(status, 'legacyHoldPublished') || status.legacyHoldPublished === false));
  const pendingPublish = redTeamHoldPendingOnly(disposition);
  return { head, read: raw.loopPayload?.findings?.read, seats: raw.seats, result: hit?.parsed ?? null, carry,
    ok: raw.ok, reason: raw.reason, carryConflict: raw.carryConflict !== undefined && raw.carryConflict !== false ? raw.carryConflict : !!(fromRev && !carry),
    hasBreak: !pendingPublish && !!(disposition.sendBack.length || disposition.held.length), pendingPublish,
    scheduling: { inFlight: raw.inFlight, queued: raw.queued, scheduled: raw.scheduled, recorded: raw.recorded,
      execution: noExecution ? 'none' : 'unknown', sealClear, commentsReadable: Array.isArray(comments) && comments.every(comment => typeof comment?.body === 'string'),
      settingsReadable: settings !== null, skipCardOnly: settings?.skipCardOnly === true && raw.skipCardOnly === true } };
}
