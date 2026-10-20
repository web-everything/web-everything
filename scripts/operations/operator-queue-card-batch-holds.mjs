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
 *   - `done`    — the seal finished, yet the hold is still on the PR. Unexpected, so it stays in NEEDS YOU.
 * A PR the state does not name, or state that cannot be read, keeps the old NEEDS YOU row (fail loud).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Extra time past the batch's own age limit before an unsealed hold counts as overdue (one hour). */
export const SEAL_GRACE_MS = 60 * 60_000;
/** Time a started seal may run before it counts as overdue. Matches the seal job's own 3-hour lease. */
export const SEAL_RUN_MS = 3 * 60 * 60_000;
const DEFAULT_MAX_AGE_MINUTES = 60;

const toMs = value => (typeof value === 'number' ? value : Date.parse(value));
const keyOf = (repo, number) => `${repo}#${Number(number)}`;

/**
 * Pure: classify one batch state for the PR it names.
 * @returns {{status:'owned'|'failed'|'overdue'|'done', kind:string|null, batchRef:string|null, members:number,
 *   dueAt:string|null, reason:string|null}}
 */
export function classifyCardBatchHold(state, { now = Date.now(), policy = {} } = {}) {
  const kind = state.kind ?? null;
  const base = { kind, batchRef: state.batchRef ?? null, members: Array.isArray(state.members) ? state.members.length : 0 };
  if (state.sealFailure) return { ...base, status: 'failed', dueAt: null, reason: String(state.sealFailure.reason ?? 'seal failed') };
  if (state.seal?.step === 'label-on-green') return { ...base, status: 'done', dueAt: null, reason: 'seal finished but the hold is still on the PR' };
  const maxAgeMinutes = Number(policy?.[kind]?.maxAgeMinutes) > 0 ? Number(policy[kind].maxAgeMinutes) : DEFAULT_MAX_AGE_MINUTES;
  const sealedAt = toMs(state.sealedAt);
  const openedAt = toMs(state.openedAt);
  const due = Number.isFinite(sealedAt) ? sealedAt + SEAL_RUN_MS
    : Number.isFinite(openedAt) ? openedAt + maxAgeMinutes * 60_000 + SEAL_GRACE_MS : NaN;
  // No usable time means the job's progress cannot be judged: keep the operator informed.
  if (!Number.isFinite(due)) return { ...base, status: 'overdue', dueAt: null, reason: 'batch state has no open or seal time' };
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
  const scan = dir => {
    let files;
    try { files = list(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      let state;
      try { state = JSON.parse(read(join(dir, file), 'utf8')); } catch (error) { errors.push(`${file}: ${error.message}`); continue; }
      if (!state?.pr || !state.repo && !state.members?.[0]?.source?.repo) continue;
      const repo = state.repo ?? state.members[0].source.repo;
      const hold = classifyCardBatchHold(state, { now, policy });
      const key = keyOf(repo, state.pr);
      if (!holds.has(key) || rank[hold.status] > rank[holds.get(key).status]) holds.set(key, hold);
    }
  };
  scan(stateDir);
  scan(join(stateDir, 'sealed'));
  return { holds, errors };
}

export const cardBatchHoldKey = keyOf;
