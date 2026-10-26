/** Drain scheduling only. Remember refusals, never positive merge authority. */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { cascadePolicy, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

const defaults = { redMainSkipCatchUp: true, holdFirst: true, overlapFirst: true, priorityReservesFiles: true, catchUpSkipQueueOverlap: true, catchUpSkipUnchangedHolds: true, carryOverReadyFirst: true, catchUpSkipMaxMin: 15, priorityReserveMaxMin: 90 };
export function resolveDrainThroughput({ env = process.env, file, platform, log = line => process.stderr.write(`${line}\n`) } = {}) {
  const booleanEnv = key => env[key] === undefined ? undefined
    : /^(true|1|on)$/i.test(env[key]) ? true : /^(false|0|off)$/i.test(env[key]) ? false : env[key];
  const pick = v => Object.fromEntries(Object.keys(defaults).filter(k => v?.[k] !== undefined).map(k => [k, v[k]]));
  const out = cascadePolicy('drain', pick((file ?? readDeclaredSettings().settings)?.drain), {
    envValues: { priorityReservesFiles: booleanEnv('WE_DRAIN_PRIORITY_RESERVES_FILES'), overlapFirst: booleanEnv('WE_DRAIN_OVERLAP_FIRST'), catchUpSkipQueueOverlap: booleanEnv('WE_DRAIN_CATCH_UP_SKIP_QUEUE_OVERLAP') },
    standard: defaults, platform: pick(platform ?? platformPreference('drain', { env })), env,
    valid: Object.fromEntries(Object.keys(defaults).map(k => [k, ['priorityReserveMaxMin', 'catchUpSkipMaxMin'].includes(k) ? v => Number.isFinite(v) && v >= 0 : v => typeof v === 'boolean'])),
  });
  for (const key of ['redMainSkipCatchUp', 'priorityReservesFiles', 'overlapFirst', 'catchUpSkipQueueOverlap']) {
    if (out.sources[key] === 'standard') out.sources[key] = 'default';
  }
  log(formatCascadeSourcesLine('drain', out));
  return out;
}
const key = c => `${c.repo ?? ''}#${c.num}`;
export function createHoldMemo(enabled) {
  const held = new Map();
  return async (c, evaluate) => {
    const id = `${key(c)}@${c.listedHeadSha || c.headSha || ''}`;
    if (enabled && held.has(id)) return held.get(id);
    const out = await evaluate(c);
    if (enabled && out) held.set(id, out);
    return out;
  };
}
export const HOLD_KINDS = new Set(['red-team-pending', 'overlap-yield', 'review-hold', 'numbering']);
export function holdSignature(pr, evidence) {
  if (!pr?.headRefOid || !Array.isArray(pr.labels)) return null;
  const stableEntry = entry => {
    if (!entry?.redTeamPending) return entry;
    const { retryAt, checkedAt, ...redTeamPending } = entry.redTeamPending;
    return { ...entry, redTeamPending };
  };
  if (evidence?.scheduling) {
    const scheduling = stableEntry(evidence.scheduling);
    evidence = { ...evidence, scheduling: { ...scheduling,
      ...(scheduling.local ? { local: stableEntry(scheduling.local) } : {}) } };
  }
  return createHash('sha256').update(JSON.stringify({ head: pr.headRefOid,
    labels: pr.labels.map(l => typeof l === 'string' ? l : l.name).sort(),
    updatedAt: pr.updatedAt, comments: pr.comments, reviews: pr.reviews, evidence })).digest('hex');
}
export function unchangedHold(previous, pr, evidence, { now = Date.now(), maxMin = 15 } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(maxMin) || maxMin <= 0) return false;
  if (!Number.isFinite(previous?.recordedAt) || now < previous.recordedAt || now - previous.recordedAt >= maxMin * 60_000) return false;
  // Scheduling is evidence too: never let a memo outlive the earliest retry,
  // pending-health deadline, request cooldown, TTL, or overlap window. Unknowns run the drain.
  const scheduling = evidence?.scheduling;
  if (scheduling) {
    const { redTeamPendingMaxMin, redTeamRequestCooldownMin } = scheduling;
    for (const entry of [scheduling, scheduling.local].filter(Boolean)) {
      const { enqueueFailure, redTeamPending } = entry;
      if (enqueueFailure && (enqueueFailure.headSha !== pr?.headRefOid
        || !Number.isFinite(enqueueFailure.retryAt) || now >= enqueueFailure.retryAt)) return false;
      if (redTeamPending) {
        if (redTeamPending.headSha !== pr?.headRefOid
          || !Number.isFinite(redTeamPending.retryAt)
          || (redTeamPending.requestedAt != null && !Number.isFinite(redTeamPending.requestedAt))
          || (redTeamPending.requestAttemptedAt != null && !Number.isFinite(redTeamPending.requestAttemptedAt))
          || !Number.isFinite(redTeamPending.firstPendingAt) || !Number.isFinite(redTeamPendingMaxMin)
          || redTeamPendingMaxMin <= 0) return false;
        const pendingDeadline = redTeamPending.firstPendingAt + redTeamPendingMaxMin * 60_000;
        const checkedAt = Number.isFinite(redTeamPending.checkedAt) ? redTeamPending.checkedAt : redTeamPending.firstPendingAt;
        const deadlines = checkedAt < pendingDeadline ? [pendingDeadline] : [];
        if (redTeamPending.requestedAt == null && redTeamPending.requestAttemptedAt == null) {
          deadlines.push(redTeamPending.retryAt);
        }
        if (redTeamPending.requestedAt == null && redTeamPending.requestAttemptedAt != null) {
          if (!Number.isFinite(redTeamPending.requestAttemptedAt) || !Number.isFinite(redTeamRequestCooldownMin)
            || redTeamRequestCooldownMin <= 0) return false;
          deadlines.push(redTeamPending.requestAttemptedAt + redTeamRequestCooldownMin * 60_000);
        }
        if (deadlines.some(deadline => !Number.isFinite(deadline) || now >= deadline)) return false;
      }
    }
  }
  if (previous.kind === 'overlap-yield' && (!Number.isFinite(evidence?.overlap?.untilMs)
    || now >= evidence.overlap.untilMs || evidence.overlap.state !== 'OPEN' || !evidence.overlap.head)) return false;
  if (previous.kind === 'numbering' && evidence?.numberingOwed !== true) return false;
  const signature = holdSignature(pr, evidence);
  return !!signature && HOLD_KINDS.has(previous?.kind) && previous.signature === signature;
}
export function carryReady(rows) {
  return rows.filter(r => r.kind === 'ready-not-reached').slice(0, 100).map(r => ({ num: r.num, repo: r.repo ?? null }));
}
export function orderCarry(rows, carry, enabled = true) {
  if (!enabled) return rows;
  const keys = new Set(carry.map(key));
  return [...rows.filter(r => keys.has(key(r))), ...rows.filter(r => !keys.has(key(r)))];
}
export function readCarry(path) {
  try { const rows = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(rows) ? rows.filter(r => Number.isInteger(r?.num)).slice(0, 100) : []; }
  catch { return []; }
}
export function writeCarry(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, rows.slice(0, 100));
}
