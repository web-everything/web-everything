import { createHash } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { NEGOTIATION_ROUND_CAP } from '../lib/jury-core.mjs';

/** Stable identity of a planned launch, never recomputed from the later live charged count. */
export function redTeamFixLaunchId({ repo, pr, head, resultId, attempts }) {
  if (!repo || !pr || !head || !resultId || !Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error('red-team repair dispatch evidence unreadable; retry with a fresh reconciliation or ask an operator');
  }
  return createHash('sha256').update(JSON.stringify([repo, Number(pr), head, resultId, attempts])).digest('hex');
}

/** All receipt writers share this PR mutex across lanes and repair kinds. No timeout takeover of a live
 * transaction: a crashed holder requires operator inspection/removal before retrying (fail closed).
 * Return a release callback so async complete-thread reads stay inside the same critical section.
 */
export function lockRedTeamFixCharge(repo, pr) {
  if (!repo || !pr) throw new Error('red-team charge repository/PR unreadable; ask an operator');
  const root = join(resolveCoordinationRoot(), 'red-team-fix-charge');
  mkdirSync(root, { recursive: true });
  const lock = join(root, createHash('sha256').update(JSON.stringify([repo, Number(pr)])).digest('hex'));
  try { mkdirSync(lock); }
  catch { throw new Error('red-team charge locked or unreadable; retry after the active dispatch or ask an operator to inspect the charge lock'); }
  return () => rmdirSync(lock);
}

import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { redTeamFact } from './dispatch-eligibility-facts.mjs';

// Separate from rearm/conflict markers: counted before the repair executor starts.
export const RED_TEAM_FIX_COMMENT_MARKER = '<!-- conveyor-red-team-sent-back-fix-round -->';
export const RED_TEAM_REARM_COMMENT_MARKER = '<!-- conveyor-red-team-fix-rearmed -->';

function leadingMarker(comment) {
  return isTrustedMarkerAuthor(comment) && typeof comment?.body === 'string'
    ? comment.body.trimStart().split('\n')[0].trimEnd() : null;
}

/** Launch identity survives new heads and gate results. Legacy marker-only receipts still count. */
function receiptLaunchId(comment) {
  if (leadingMarker(comment) !== RED_TEAM_FIX_COMMENT_MARKER) return null;
  return /^Red-team repair dispatched: head=\S+ result=\S+ attempt=([\w-]{1,128})$/m.exec(comment.body)?.[1] ?? null;
}

/** Durable spent rounds, pairing dispatch receipts with their later hand-back, never charging both.
 * Marker-only historical receipts and orphan hand-backs retain their charge. Duplicate launch IDs
 * are one round even if the head/result changed. Failed launches need no hand-back to count.
 */
export function countRedTeamFixComments(comments) {
  if (!Array.isArray(comments)) return 0;
  let count = 0, awaitingHandBack = false;
  const launches = new Set();
  for (const comment of comments) {
    const marker = leadingMarker(comment);
    if (marker === RED_TEAM_FIX_COMMENT_MARKER) {
      const launchId = receiptLaunchId(comment);
      awaitingHandBack = true;
      if (launchId && launches.has(launchId)) continue;
      if (launchId) launches.add(launchId);
      count++;
    } else if (marker === RED_TEAM_REARM_COMMENT_MARKER) {
      if (!awaitingHandBack) count++;
      awaitingHandBack = false;
    }
  }
  return count;
}

/** One receipt per launch, including failed/no-change repairs and all executor fallbacks within it. */
export function publishRedTeamFixLaunch({ comments, pr, head, attemptId, publish, chargedRounds, cap = NEGOTIATION_ROUND_CAP }) {
  const result = redTeamFact(comments, pr, head)?.value;
  if (result?.state !== 'send-back' || !/^[\w-]{1,128}(?![\s\S])/.test(String(attemptId ?? ''))) {
    throw new Error('red-team repair dispatch evidence unreadable; retry with a fresh reconciliation or ask an operator');
  }
  const body = `${RED_TEAM_FIX_COMMENT_MARKER}\n\nRed-team repair dispatched: head=${head} result=${result.resultId} attempt=${attemptId}`;
  if (comments.some(c => receiptLaunchId(c) === String(attemptId))) return false;
  if (!Number.isSafeInteger(chargedRounds) || chargedRounds < 0 || !Number.isSafeInteger(cap) || cap < 0) {
    throw new Error('red-team repair round bound unreadable; reconcile again or ask an operator');
  }
  if (chargedRounds >= cap) throw new Error('red-team repair cap exhausted; ask an operator to inspect the full thread');
  publish(body); // Publication failure must prevent execution.
  return true;
}
