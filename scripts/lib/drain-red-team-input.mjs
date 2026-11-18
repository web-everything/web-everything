/** Admission normalization leaf: loading queue policy must not load the review/recovery IO graph. */
import { parseRedTeamComment, readRedTeamDisposition, redTeamHoldPendingOnly, redTeamResultCommentForHead, RED_TEAM_SETTINGS_FILE, resolveRedTeamProbes } from './red-team-gate.mjs';

import { readFileSync } from 'node:fs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
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

/** Preserve append order, never wall-clock order. Legacy evidence without identity/order stays unknown.
 * Scorecard positions are the shared run ordering spine; comments and statuses name that same call.
 * Explicit persisted order is supported for snapshots carrying the store's append sequence.
 */
export function normalizeRedTeamRuns({ raw, comments, head, pr, carry, noExecution, hit }) {
  const id = record => {
    const ids = [record?.runId, record?.callId, record?.result?.runId, record?.result?.callId].filter(value => value !== undefined);
    const value = ids[0];
    return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value)
      && ids.every(id => id === value) ? value : null;
  };
  const seats = Array.isArray(raw.seats) ? Array.from(raw.seats) : [];
  const positions = new Map();
  for (const row of seats) {
    const runId = id(row), order = row && Object.hasOwn(row, 'order') ? row.order : row?.appendIndex;
    if (runId && !positions.has(runId)) positions.set(runId, order);
    else if (runId && positions.get(runId) !== order) positions.set(runId, null);
  }
  const record = (value, outcome) => ({ runId: id(value),
    order: value && Object.hasOwn(value, 'order') ? value.order
      : value && Object.hasOwn(value, 'appendIndex') ? value.appendIndex : positions.get(id(value)), outcome });
  const executionOutcome = value => {
    const status = typeof value?.result === 'string' ? value.result : value?.result?.status ?? value?.status;
    return ['failed', 'error', 'timeout', 'partial'].includes(status) ? 'break'
      : ['ran', 'resumed', 'ok'].includes(status) ? 'complete'
        : ['queued', 'running'].includes(status) ? 'pending' : 'unknown';
  };
  const seatOutcome = row => row?.status === 'ok'
    ? row.seatStatus !== undefined && row.seatStatus !== 'ok' ? 'break' : row.foldedVerdict === 'changes' ? 'changes' : 'complete'
    : ['failed', 'error', 'timeout', 'partial'].includes(row?.status) ? 'break' : 'unknown';
  const verdictOutcome = value => value?.foldedVerdict === 'changes' ? 'changes'
    : value?.foldedVerdict === 'accept' ? 'complete' : 'unknown';
  // Optional histories supplement the current persisted record; they cannot hide a newer status/verdict.
  const history = (key, current) => {
    if (!Object.hasOwn(raw, key)) return current == null ? [] : [current];
    if (!Array.isArray(raw[key])) return null;
    const values = [...raw[key]];
    if (current != null && values.at(-1) !== current) values.push(current);
    return values;
  };
  const execution = history('executionRecords', noExecution ? null : raw.status);
  const verdict = history('verdictRecords', raw.status?.result?.foldedVerdict !== undefined ? raw.status.result
    : raw.status?.foldedVerdict !== undefined ? raw.status : null);
  const comment = [];
  const commentMeta = value => {
    const marks = [...String(value?.body ?? '').matchAll(/^<!-- we:red-team-run id=([A-Za-z0-9._:-]+)(?: order=(\d+))? -->$/gm)];
    return marks.length === 1 ? { runId: marks[0][1], ...(marks[0][2] !== undefined ? { order: Number(marks[0][2]) } : {}) } : {};
  };
  if (Array.isArray(comments)) for (const value of comments) {
    if (!isTrustedMarkerAuthor(value)) continue;
    const parsed = parseRedTeamComment(value.body);
    if (parsed?.pr !== Number(pr) || parsed.rev !== head) continue;
    const meta = commentMeta(value);
    comment.push(record(meta, parsed.completedReview ? 'complete' : 'unknown'));
  }
  let carryRecord = carry;
  if (carry && hit?.carriedFrom && !id(carry)) {
    const meta = commentMeta(hit.comment), source = carry.proof?.runs?.result?.at(-1);
    carryRecord = { ...meta, order: Object.hasOwn(meta, 'order') ? meta.order
      : meta.runId === source?.runId ? source.order : undefined };
  }
  if (hit?.carriedFrom) comment.push(record(carryRecord, hit.parsed.completedReview ? 'complete' : 'unknown'));
  return { result: hit ? [record(hit.carriedFrom ? carryRecord : commentMeta(hit.comment), hit.parsed.completedReview ? 'complete' : 'unknown')] : [], comment, seats: seats.map(row => record(row, seatOutcome(row))),
    execution: Array.isArray(execution) ? execution.map(value => record(value, executionOutcome(value))) : null,
    verdict: Array.isArray(verdict) ? verdict.map(value => record(value, verdictOutcome(value))) : null,
    carry: carry ? [record(carryRecord, 'complete')] : [] };
}

/** The admission boundary requires explicit context and a complete snapshot; absence is never an empty read. */
export const RED_TEAM_ADMISSION_INPUTS = Object.freeze({
  repo: value => typeof value === 'string' && !!value.trim(),
  pr: value => ['number', 'string'].includes(typeof value) && Number.isSafeInteger(Number(value)) && Number(value) > 0,
  head: value => typeof value === 'string' && !!value,
  labels: value => Array.isArray(value) && Array.from(value).every(label => typeof label === 'string' || typeof label?.name === 'string'),
  comments: value => Array.isArray(value) && Array.from(value).every(comment => typeof comment?.body === 'string'),
  settings: value => value !== null && typeof value === 'object',
  'evidence.ok': value => typeof value === 'boolean',
  'evidence.status': value => value === null || (typeof value === 'object' && !Array.isArray(value)),
  'evidence.carry': value => value === null || (typeof value === 'object' && !Array.isArray(value)),
  'evidence.loopPayload': value => value === null || (typeof value === 'object' && !Array.isArray(value)),
  'evidence.seats': value => Array.isArray(value),
  ...Object.fromEntries(['inFlight', 'queued', 'scheduled', 'recorded', 'skipCardOnly']
    .map(key => [`evidence.${key}`, value => typeof value === 'boolean'])),
});

export function drainRedTeamDecisionInput({ evidence: raw, comments, head, pr, repo, env = process.env,
  labels, standingRuling, confirmedBreaks, settingsPath = RED_TEAM_SETTINGS_FILE, readSettings = readFileSync, readSource = raw?.decisionInput?.readSource } = {}) {
  raw = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const disposition = readRedTeamDisposition({ comments, pr, head, repo, env, standingRuling, setting: confirmedBreaks });
  const hit = redTeamResultCommentForHead(comments, pr, head);
  const fromRev = hit?.carriedFrom ?? raw.carry?.loopPayload?.carriedFrom;
  let carry = raw.carry == null ? raw.carry : Object.hasOwn(raw.carry, 'fromRev') ? raw.carry : undefined;
  if (fromRev && !carry) {
    try {
      carry = { fromRev, proof: readSource({ head: fromRev, comments: hit ? comments.slice(0, hit.commentIndex) : [] }) };
    } catch { /* unreadable source is a carry conflict, never payment */ }
  }
  const malformedCarry = raw.carry != null && !carry && !fromRev;
  const settings = admissionSettings({ env, settingsPath, readSettings });
  const values = { repo, pr, head, labels, comments, settings, evidence: raw };
  const missingInputs = Object.entries(RED_TEAM_ADMISSION_INPUTS).filter(([key, proven]) =>
    !proven(key.split('.').reduce((value, part) => value != null && Object.hasOwn(value, part) ? value[part] : undefined, values))).map(([key]) => key);
  const status = raw.status, resultStatus = typeof status?.result === 'string' ? status.result : status?.result?.status;
  const noExecution = status === null || (status?.head === head && status.status === 'finished'
    && (resultStatus === 'not-owed' || (resultStatus === 'skipped'
      && (typeof status.result === 'string' || status.result.policy === 'card-only'))));
  const sealClear = status === null || (noExecution && ['sealedBreaks', 'sealedPosted'].every(key =>
    !Object.hasOwn(status, key) || (Array.isArray(status[key]) && status[key].length === 0))
    && !Object.hasOwn(status, 'storedFindings')
    && (!Object.hasOwn(status, 'legacyHoldPublished') || status.legacyHoldPublished === false));
  const pendingPublish = redTeamHoldPendingOnly(disposition);
  const hasBreak = !pendingPublish && !!(disposition.sendBack.length || disposition.held.length);
  const storedVerdict = status?.status === 'finished' ? status.result?.foldedVerdict ?? status.foldedVerdict ?? null : null;
  // Reuse the shared disposition's verified releases, never an unverified marker or a skipped pass.
  const releases = [...disposition.dispositions.values()];
  const breakResolved = !hasBreak && releases.length > 0
    && releases.every(release => ['cleared', 'released carded', 'released not-real'].includes(release.state));
  const blocked = Array.isArray(labels) && labels.some(label => (typeof label === 'string' ? label : label?.name) === 'red-team:blocked');
  return { head, missingInputs, read: raw.loopPayload?.findings?.read, seats: raw.seats, result: hit?.parsed ?? null, carry,
    ok: raw.ok, reason: raw.reason, carryConflict: malformedCarry || (raw.carryConflict !== undefined && raw.carryConflict !== false ? raw.carryConflict : !!(fromRev && !carry)),
    hasBreak, blocked, storedVerdict, breakResolved, pendingPublish,
    runs: normalizeRedTeamRuns({ raw, comments, head, pr, carry, noExecution, hit }),
    scheduling: { inFlight: raw.inFlight, queued: raw.queued, scheduled: raw.scheduled, recorded: raw.recorded,
      execution: noExecution ? 'none' : 'unknown', sealClear, commentsReadable: Array.isArray(comments) && comments.every(comment => typeof comment?.body === 'string'),
      settingsReadable: settings !== null, skipCardOnly: settings?.skipCardOnly === true && raw.skipCardOnly === true } };
}
