/**
 * @file scripts/lib/standards-status.mjs
 * @description Pure core of the Studio-run Standards gate for plateau-app (VERIFIER-STANDARDS-STATUS). plateau-app CI
 *   cannot run the Standards validator, so the Studio verifier runs the real harness on the exact PR head and posts the
 *   commit status `standards/validate` as the WE App bot. This file holds the shared, side-effect-free rules: what a
 *   passing run looks like, the status payload, and how a head's status history is read (shared with the drain slice).
 *   Every uncertain read returns a hold, never a pass.
 */

export const STANDARDS_CONTEXT = 'standards/validate';
/** The only producer the gate trusts: the WE App's bot user (statuses carry a creator user, never an app id). */
export const TRUSTED_BOT = Object.freeze({ id: 332649731, type: 'Bot', login: 'web-everything[bot]' });
export const STANDARDS_PAGE_CAP = 10;
const SHA = /^[0-9a-f]{40}$/;
export const validHead = value => typeof value === 'string' && SHA.test(value);

const PASS_LINE = /^Standards validator exit status: 0\s*$/m;
const SKIP_LINE = /^\s*SKIP:|NOT RUN/m;

/**
 * Success only for the exact pass shape: harness exit 0 with no signal, no timeout and no spawn error, the
 * `Standards validator exit status: 0` line, and no `SKIP:` or `NOT RUN` text.
 * @param {{status?:number|null, signal?:string|null, timedOut?:boolean, error?:unknown, stdout?:string}} result
 * @returns {{state:'success'|'failure', reason:string}}
 */
export function runVerdict(result) {
  const fail = reason => ({ state: 'failure', reason });
  if (!result || typeof result !== 'object') return fail('no run result');
  if (result.error) return fail('harness could not start');
  if (result.timedOut) return fail('harness timed out');
  if (result.signal) return fail(`harness killed by ${String(result.signal)}`);
  if (result.status !== 0) return fail(`harness exit ${String(result.status)}`);
  const out = typeof result.stdout === 'string' ? result.stdout : '';
  if (SKIP_LINE.test(out)) return fail('validator skipped or not run');
  if (!PASS_LINE.test(out)) return fail('missing "Standards validator exit status: 0" line');
  return { state: 'success', reason: 'validator passed' };
}

/** Status body. The description binds the status to the run and the validator hash (140-char GitHub limit). */
export function statusPayload({ state, runId, validatorHash = 'unknown', reason = '' } = {}) {
  if (!['pending', 'success', 'failure', 'error'].includes(state)) throw Error('invalid standards status state');
  const text = state === 'pending' ? `run ${runId} started` : `run ${runId} · validator ${validatorHash} · ${reason}`;
  return { state, context: STANDARDS_CONTEXT, description: text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140) };
}

export const isTrustedCreator = creator => Boolean(creator) && creator.id === TRUSTED_BOT.id
  && creator.type === TRUSTED_BOT.type && creator.login === TRUSTED_BOT.login;

/**
 * Read one head's `standards/validate` state. `history` is every status on the head (any order; sorted here by id,
 * never by created_at); `combined` is the per-context summary. Hold unless the newest status on the context by id is a
 * `success` posted by the trusted bot. A success by anyone else is ignored; a newer non-success from anyone holds.
 * @returns {{hold:boolean, reason:string, latestTrusted?:object, newestId?:number}} `latestTrusted` is the newest
 *   trusted terminal (success or failure) status and `newestId` the newest status id on the context, for the
 *   verifier's dedupe (a terminal that is not the newest status means a run is in flight or crashed).
 */
export function evaluateStandardsStatus({ combined, history, historyComplete = true, head } = {}) {
  const hold = reason => ({ hold: true, reason });
  try {
    if (!validHead(head)) return hold('invalid head sha');
    if (!combined || typeof combined !== 'object' || !Array.isArray(combined.statuses)
      || !Number.isSafeInteger(combined.total_count)) return hold('combined status unreadable');
    if (combined.sha !== head) return hold('combined status is for a different sha');
    if (combined.statuses.length < combined.total_count) return hold('combined status incomplete');
    if (!Array.isArray(history) || history.some(s => !Number.isSafeInteger(s?.id))) return hold('status history unreadable');
    if (!historyComplete) return hold('status history incomplete (page cap)');
    const mine = history.filter(s => s.context === STANDARDS_CONTEXT).sort((a, b) => b.id - a.id);
    const summary = combined.statuses.find(s => s?.context === STANDARDS_CONTEXT);
    if (!mine.length) return summary ? hold('summary lists a status the history lacks') : hold('no standards/validate status');
    if (!summary) return hold('history has a status the summary lacks');
    if (summary.id !== mine[0].id) return hold('summary and history disagree on the newest status');
    const newestId = mine[0].id;
    const latestTrusted = mine.find(s => isTrustedCreator(s.creator) && (s.state === 'success' || s.state === 'failure'));
    for (const status of mine) {
      if (status.state === 'success' && !isTrustedCreator(status.creator)) continue; // untrusted success: ignored
      if (status.state === 'success') return { hold: false, reason: 'trusted standards/validate success', latestTrusted, newestId };
      return { hold: true, reason: `newest standards/validate status is ${String(status.state)}`, latestTrusted, newestId };
    }
    return { hold: true, reason: 'no trusted standards/validate success', latestTrusted, newestId };
  } catch (error) { return hold(`standards status unreadable: ${error?.message ?? error}`); }
}
