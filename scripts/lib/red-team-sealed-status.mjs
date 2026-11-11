/**
 * The sealed red-team evidence for ONE exact head (PR #6622): the per-head status file carries `sealedBreaks`, the
 * normalized list of confirmed breaks the stored evidence (seat row or result) holds. That list is the single authority
 * for "is this head held": a posted comment can only add holds, never lift one. IO only; the decision is
 * `redTeamHoldDecision` in red-team-gate.mjs, which every disposition caller reaches through `readRedTeamDisposition`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolve } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

// Mirrors run-store's `sharedRunsDir` without its import graph (this leaf rides inside the gate, which staged partial
// copies of the operator queue must import); a test pins the path to the drain evidence writer's.
const SHARED_RUNS_DIR_ENV = 'WE_SHARED_RUNS_DIR';
const runsDir = env => env?.[SHARED_RUNS_DIR_ENV]?.trim() ? resolve(env[SHARED_RUNS_DIR_ENV].trim())
  : join(dirname(resolveCoordinationRoot({ env })), 'runs');

/** The status file the publisher and the drain evidence writer share (same grammar as drain-red-team-evidence). */
export const sealedStatusPath = ({ repo, pr, head }, env = process.env) =>
  join(dirname(runsDir(env)), 'red-team-status', `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

/**
 * PURE: a stored status object as the hold decision's `sealed` input, or null when it holds nothing.
 * `legacyHold`: the unposted bare `ran` result's evidence was unreadable (publisher alert flag).
 * A malformed seal is `unreadable` (fail closed), never "no breaks".
 */
export function sealedFromStatus(status, head) {
  if (!status || typeof status !== 'object') return null;
  if (status.head !== undefined && String(status.head).toLowerCase() !== String(head ?? '').toLowerCase()) return null;
  const seal = status.sealedBreaks;
  const keyList = v => Array.isArray(v) && v.every(k => typeof k === 'string');
  if (seal !== undefined && !keyList(seal)) return { unreadable: true };
  // `sealedPosted`: the publisher's own scrub-fallback body, sealed beside the breaks (see redTeamHoldDecision).
  const posted = status.sealedPosted;
  if (posted !== undefined && (seal === undefined || !keyList(posted))) return { unreadable: true };
  // Counted only on the finished bare `ran` the flag was raised for: the publisher, which alone lifts it, acts only there.
  // Counted at any other status it would outlive a failed retry with nothing able to clear it. The flag stays stored, so
  // a later finished bare `ran` re-raises it. (A conflict-raised flag is never retried: the retry guard refuses a head
  // that already carries a red-team comment.)
  const legacyHold = status.legacyHoldPublished === true && status.status === 'finished' && status.result === 'ran';
  // A status that still owes publication (same test as the publisher's `needsPublish`) and has no seal yet: nothing has
  // compared the stored evidence with the thread, so no posted comment may clear it. Hold until the publisher seals.
  const owesPublish = status.status === 'finished' && (status.result === 'ran'
    || (status.result?.status === 'ran' && ['withheld', 'error'].includes(status.result?.comment)));
  if (seal === undefined && owesPublish) return { unsealed: true, legacyHold };
  // A finished result the seat posted itself (`posted`, `deduped`, …) owes no publication and is never sealed, yet its
  // findings ARE the stored evidence: hand them over as they are, so a later comment cannot lift their breaks. Findings
  // that cannot be read hold (fail closed), never "no breaks".
  const r = status.result;
  if (seal === undefined && status.status === 'finished' && r && typeof r === 'object' && r.status === 'ran') {
    return Array.isArray(r.findings) ? { findings: r.findings, legacyHold } : { unreadable: true };
  }
  // The same evidence carried across a resume (which writes a bare `resumed` result): `storedFindings`.
  if (seal === undefined && status.storedFindings !== undefined) {
    return Array.isArray(status.storedFindings) ? { findings: status.storedFindings, legacyHold } : { unreadable: true };
  }
  if (seal === undefined && !legacyHold) return null;
  return { breaks: seal ?? [], legacyHold, ...(posted !== undefined ? { posted } : {}) };
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
