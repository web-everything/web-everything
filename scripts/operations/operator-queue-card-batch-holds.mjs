/**
 * Card-batch holds for the operator queue.
 *
 * The card-batch seal job (we:scripts/operations/card-batch-seal-io.mjs) opens each rolling card-only PR as a
 * draft and puts `review-status:draft-withdrawn` on it ON PURPOSE: the hold keeps a green draft from being
 * promoted while cards are still being added. The same job removes the hold itself once the batch is sealed and
 * verified. So a hold the seal job still owns is not a question for the operator. Before this module, the queue
 * listed every withdrawn draft under NEEDS YOU and the needs-you feed told the operator to release it by hand
 * (#5766, #5773).
 *
 * This module reads the shared batch state and says, per PR, whether its hold is still owned by the seal job.
 * It never removes a hold. It only decides which queue section shows the PR:
 *   - `owned`   — the seal job will release the hold itself. Shown under PARKED, never in NEEDS YOU.
 *   - `failed`  — the seal recorded a failure (verify red or never ran). A person is needed. Stays in NEEDS YOU.
 *   - `overdue` — the seal job should have released it by now and has not. Stays in NEEDS YOU.
 *   - `done`    — the seal job already let go of its hold, so a withdrawal still on the PR is someone else's.
 *                 Stays in NEEDS YOU. The same goes for a PR whose head moved off the batch head (the caller checks).
 * A PR the state does not name, or state that cannot be read, keeps the old NEEDS YOU row (fail loud).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Time the scheduler gets to launch (or relaunch) a seal worker once one is owed, before the hold is overdue. */
export const SEAL_GRACE_MS = 30 * 60_000;
const DEFAULT_MAX_AGE_MINUTES = 60;
const DEFAULT_MAX_CARDS = 10;
/** Seal steps at or past which the seal job has already let go of the hold (card-batch-seal-io.mjs `holdReleased`). */
const RELEASED_STEPS = new Set(['remove-hold', 'ready', 'label-on-green']);

const toMs = value => (typeof value === 'number' ? value : Date.parse(value));
const keyOf = (repo, number) => `${repo}#${Number(number)}`;

/**
 * Pure: classify one batch state for the PR it names.
 * `lockExpiresAt` is the expiry of the batch's on-disk lease lock (`<state>.lock`), when one exists: a live lock
 * means a worker is on the batch right now.
 * @returns {{status:'owned'|'failed'|'overdue'|'done', kind:string|null, batchRef:string|null, headSha:string|null,
 *   members:number, dueAt:string|null, reason:string|null}}
 */
export function classifyCardBatchHold(state, { now = Date.now(), policy = {}, lockExpiresAt = null } = {}) {
  const kind = state.kind ?? null;
  const members = Array.isArray(state.members) ? state.members : [];
  const base = { kind, batchRef: state.batchRef ?? null, headSha: state.headSha ?? null, members: members.length,
    pr: Number(state.pr) || null, terminalPrState: state.sealFailure?.terminalPrState ?? null };
  if (state.sealFailure) return { ...base, status: 'failed', dueAt: null, reason: String(state.sealFailure.reason ?? 'seal failed') };
  if (RELEASED_STEPS.has(state.seal?.step)) {
    return { ...base, status: 'done', dueAt: null, reason: `the seal job already released its hold (step ${state.seal.step}); this withdrawal is not the batch's` };
  }
  if (state.holdApplied !== true) return { ...base, status: 'overdue', dueAt: null, reason: 'batch state does not record its hold' };
  const live = Number.isFinite(toMs(lockExpiresAt)) && toMs(lockExpiresAt) > now;
  const lastLease = Math.max(...[lockExpiresAt, state.lease?.expiresAt].map(toMs).filter(Number.isFinite), -Infinity);
  const kindPolicy = policy?.[kind] ?? {};
  const maxAgeMinutes = Number(kindPolicy.maxAgeMinutes) > 0 ? Number(kindPolicy.maxAgeMinutes) : DEFAULT_MAX_AGE_MINUTES;
  const maxCards = Number(kindPolicy.maxCards) > 0 ? Number(kindPolicy.maxCards) : DEFAULT_MAX_CARDS;
  const sealedAt = toMs(state.sealedAt);
  const openedAt = toMs(state.openedAt);
  const lastAdmitted = Math.max(...members.map(m => toMs(m?.admittedAt)).filter(Number.isFinite), -Infinity);
  // When a seal became owed: already started, full (count beats age), or old enough.
  const owedAt = Number.isFinite(sealedAt) ? sealedAt
    : members.length >= maxCards ? (Number.isFinite(lastAdmitted) ? lastAdmitted : openedAt)
      : openedAt + maxAgeMinutes * 60_000;
  // No usable time means the job's progress cannot be judged: keep the operator informed.
  if (!Number.isFinite(owedAt)) return { ...base, status: 'overdue', dueAt: null, reason: 'batch state has no open or seal time' };
  // A live worker owns it until its lease ends; otherwise the scheduler has a grace period after the seal became
  // owed, or after the last worker's lease ended, to (re)launch one.
  const due = live ? toMs(lockExpiresAt) : Math.max(owedAt, lastLease) + SEAL_GRACE_MS;
  const dueAt = new Date(due).toISOString();
  if (now > due) return { ...base, status: 'overdue', dueAt, reason: `the seal job has not released the hold (due by ${dueAt})` };
  return { ...base, status: 'owned', dueAt, reason: null };
}

/**
 * Read every batch state (active slot and `sealed/` archive) and map `repo#pr` to its classification.
 * A state file that cannot be parsed is skipped and reported in `errors`; a missing directory is empty.
 * When two states name the same PR, the one that needs a person wins, so a failure is never hidden.
 */
export function readCardBatchHolds({ stateDir, now = Date.now(), policy = {}, read = readFileSync, list = readdirSync } = {}) {
  const holds = new Map();
  const errors = [];
  const rank = { owned: 0, done: 1, overdue: 2, failed: 3 };
  const scan = (dir, slot) => {
    let files;
    try { files = list(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      let state;
      try { state = JSON.parse(read(join(dir, file), 'utf8')); } catch (error) { errors.push(`${file}: ${error.message}`); continue; }
      if (!state?.pr || !state.repo && !state.members?.[0]?.source?.repo) continue;
      const repo = state.repo ?? state.members[0].source.repo;
      let lockExpiresAt = null;
      try { lockExpiresAt = JSON.parse(read(join(dir, `${file}.lock`), 'utf8'))?.expiresAt ?? null; } catch { /* no lock */ }
      const hold = { ...classifyCardBatchHold(state, { now, policy, lockExpiresAt }), repo, slot };
      const key = keyOf(repo, state.pr);
      if (!holds.has(key) || rank[hold.status] > rank[holds.get(key).status]) holds.set(key, hold);
    }
  };
  scan(stateDir, 'active');
  scan(join(stateDir, 'sealed'), 'sealed');
  return { holds, errors };
}

export const cardBatchHoldKey = keyOf;

/** The leading line of every `fix-begin` claim comment (we:scripts/conveyor/fix-procedure.mjs FIX_BEGIN_MARKER). */
export const FIX_BEGIN_COMMENT_LEAD = '🔒 conveyor fix-begin — fix claim held';

/**
 * Pure: is there any sign that someone other than the seal job withdrew this PR? A fixer may run
 * `fix-begin --draft --reason=withdrawn` on a batch PR without moving its head, so the seal job's ownership of the
 * batch is not enough to park it. Any sign, or any input that could not be read, returns a reason: the PR then
 * stays in NEEDS YOU. Only a clean read with no sign returns null.
 * @param {{claims: Array<{kind:string, entry:object|'unreadable'|null}>|null, comments: Array<{body?:string}>|null,
 *   labelEvents: Array<{event:string, label:string, actor:string|null}>|null, sealActors: string[], label: string}} input
 */
export function fixerWithdrawalEvidence({ claims, comments, labelEvents, sealActors, label }) {
  if (!Array.isArray(claims)) return 'fix claim state unreadable';
  for (const { kind, entry } of claims) {
    if (entry === 'unreadable') return `fix claim state unreadable (${kind})`;
    if (entry) return `a fix claim (${kind}) exists for this PR, held by ${entry.meta?.who ?? entry.owner ?? 'unknown'}`;
  }
  if (!Array.isArray(comments)) return 'PR comments unreadable';
  if (comments.some(c => typeof c?.body === 'string' && c.body.trimStart().startsWith(FIX_BEGIN_COMMENT_LEAD))) {
    return 'a fix-begin claim comment is on this PR';
  }
  if (!Array.isArray(labelEvents)) return 'label history unreadable';
  const events = labelEvents.filter(e => e?.label === label);
  const added = events.filter(e => e.event === 'labeled');
  if (events.some(e => e.event === 'unlabeled')) return 'the withdrawal label was removed and re-added';
  if (added.length !== 1) return `the withdrawal label was added ${added.length} times`;
  if (!sealActors.includes(added[0].actor)) return `the withdrawal label was added by ${added[0].actor ?? 'an unknown actor'}, not the seal job`;
  return null;
}

/**
 * Pure: the CLOSED (unmerged) batches whose cards could not be re-spooled. The seal job and the reconcile both keep
 * such a batch in the active slot (held) until a re-spool verifies; while it sits there a person is needed, and its
 * PR is closed, so no open-PR row would ever show it.
 */
export function closedBatchesNotRespooled(holds) {
  return [...holds.values()].filter(h => h.slot === 'active' && h.status === 'failed' && h.terminalPrState === 'CLOSED');
}

/**
 * Read one fix claim from the claim ledger, telling "no claim" apart from "cannot tell".
 * The lock DIRECTORY is the claim (we:scripts/readiness/file-locks.mjs: mkdir wins, metadata is written after), so:
 *   - directory absent (ENOENT)                → `null` (no claim)
 *   - directory present, entry readable        → the entry
 *   - directory present, no `lock.json` yet    → a live claim with no metadata
 *   - any other stat error, or an unparseable `lock.json` → `'unreadable'`
 */
export function readFixClaimEntry(dir, { stat = statSync, readEntry }) {
  try { stat(dir); } catch (error) { return error?.code === 'ENOENT' ? null : 'unreadable'; }
  try { stat(join(dir, 'lock.json')); } catch (error) {
    return error?.code === 'ENOENT' ? { owner: '(claim being taken; no metadata yet)', meta: null } : 'unreadable';
  }
  let entry;
  try { entry = readEntry(); } catch { return 'unreadable'; }
  return entry ?? 'unreadable';
}
