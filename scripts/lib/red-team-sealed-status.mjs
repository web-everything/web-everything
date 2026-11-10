/**
 * The sealed red-team evidence for ONE exact head (PR #6622): the per-head status file carries `sealedBreaks`, the
 * normalized list of confirmed breaks the stored evidence (seat row or result) holds. That list is the single authority
 * for "is this head held": a posted comment can only add holds, never lift one. IO only; the decision is
 * `redTeamHoldDecision` in red-team-gate.mjs, which every disposition caller reaches through `readRedTeamDisposition`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sharedRunsDir } from '../operations/run-store.mjs';

/** The status file the publisher and the drain evidence writer share (same grammar as drain-red-team-evidence). */
export const sealedStatusPath = ({ repo, pr, head }, env = process.env) =>
  join(dirname(sharedRunsDir(env)), 'red-team-status', `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

/**
 * PURE: a stored status object as the hold decision's `sealed` input, or null when it holds nothing.
 * `legacyHold`: the unposted bare `ran` result's evidence was unreadable (publisher alert flag).
 * A malformed seal is `unreadable` (fail closed), never "no breaks".
 */
export function sealedFromStatus(status, head) {
  if (!status || typeof status !== 'object') return null;
  if (status.head !== undefined && String(status.head).toLowerCase() !== String(head ?? '').toLowerCase()) return null;
  const seal = status.sealedBreaks;
  if (seal !== undefined && (!Array.isArray(seal) || seal.some(k => typeof k !== 'string'))) return { unreadable: true };
  const legacyHold = status.legacyHoldPublished === true && status.status === 'finished' && status.result === 'ran';
  if (seal === undefined && !legacyHold) return null;
  return { breaks: seal ?? [], legacyHold };
}

/** The persisted seal for this head: null when nothing is sealed, `{unreadable:true}` when the file cannot be trusted. */
export function readSealedStatus({ repo, pr, head, env = process.env, read = readFileSync } = {}) {
  if (typeof repo !== 'string' || !repo || !Number.isInteger(Number(pr)) || Number(pr) <= 0
    || !/^[0-9a-f]{40}$/i.test(String(head ?? ''))) return null;
  let status;
  try { status = JSON.parse(read(sealedStatusPath({ repo, pr, head }, env), 'utf8')); }
  catch (e) { return e?.code === 'ENOENT' ? null : { unreadable: true }; }
  if (!status || status.repo !== repo || Number(status.pr) !== Number(pr) || status.head !== head) return { unreadable: true };
  return sealedFromStatus(status, head);
}
