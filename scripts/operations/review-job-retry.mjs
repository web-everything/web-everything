/** Head-bound job admission. Unlike session cool-offs, exhaustion parks until a head change or re-arm. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJobRecord, jobRecordPath } from './review-job-store.mjs';
import { writeReviewJobDone } from './review-job-envelope.mjs';

const CLEAN = new Set(['auto-cleared', 'bounced', 'parked', 'carried']);
export const completionFingerprint = rec => createHash('sha256').update(JSON.stringify(rec ?? null)).digest('hex');

export function readReviewJobRetry(slug, dir) {
  try {
    const state = JSON.parse(readFileSync(jobRecordPath(slug, join(dir, '.retry')), 'utf8'));
    if (state?.slug !== slug || !/^[a-f0-9]{40}$/i.test(state.head ?? '') || typeof state.repo !== 'string'
      || !Number.isSafeInteger(state.attempts) || state.attempts < 0 || typeof state.parked !== 'boolean' || typeof state.notified !== 'boolean'
      || (state.pending && (!Number.isFinite(state.pending.at) || typeof state.pending.baseline !== 'string')))
      throw Error('invalid retry state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('review retry evidence unreadable; inspect or explicitly re-arm before dispatch', { cause: error });
  }
}
export const writeReviewJobRetry = (state, dir) => writeJobRecord(state, join(dir, '.retry'));

export function rearmReviewJobRetry({ slug, repo, head, dir }) {
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) throw Error('re-arm requires a readable pinned head');
  return writeReviewJobRetry({ slug, repo, head: head.toLowerCase(), attempts: 0, parked: false, notified: false }, dir);
}

/** Called under the dispatch lock, after proving no live job owns this PR. Missing done counts as failure. */
export function settleReviewJobRetry({ slug, repo, head, dir, completion, cap, terminal = writeReviewJobDone }) {
  let state = readReviewJobRetry(slug, dir);
  const knownHead = state?.head;
  if (state?.repo !== undefined && state.repo !== repo) throw Error('review retry repository mismatch');
  if (state?.pending) {
    const ownDone = completion?.status === 'done'
      && completionFingerprint(completion) !== state.pending.baseline
      && Date.parse(completion.updatedAt) >= state.pending.at
      && (completion.pid == null || completion.pid === state.pending.pid);
    if (!ownDone) terminal({ session: slug, pr: state.pending.pr, repo,
      ...(state.pending.pid ? { pid: state.pending.pid } : {}),
      classified: { outcome: 'blocked-on-infra', label: 'review-job process exited without a done record' } });
    if (!state.parked && ownDone && CLEAN.has(completion.outcome)) state.attempts = 0;
    delete state.pending;
  }
  if (state && state.head !== head.toLowerCase()) state = null;
  if (!state) {
    // Old jobs did not pin a head in their completion. Fail closed on an already exhausted historical
    // streak; the operator can re-arm after inspection. Once migrated, every budget is head-specific.
    const legacy = !knownHead && completion?.status === 'done' && completion.outcome === 'blocked-on-infra'
      && Number.isSafeInteger(completion.infraStreak) && completion.infraStreak > 0;
    state = { slug, repo, head: head.toLowerCase(), attempts: legacy ? completion.infraStreak : 0, parked: false, notified: false };
  }
  state.parked ||= state.attempts >= cap;
  writeReviewJobRetry(state, dir);
  return state;
}
