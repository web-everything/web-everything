/**
 * we:scripts/conveyor/load-flake-hold.mjs — the load-flake hold readers production code uses (PR #3945 review).
 *
 * A legacy gate-red load-flake hold was a terminal stand-down before it was reclassified, so it must end the way
 * a stand-down ends: superseded by the parked-PR watch, by an addressed advisory finding, or by an operator
 * answer naming it. Without that a superseded hold came back to life, refused the PR in reconcile, and stayed the
 * oldest reverify candidate forever.
 *
 * Kept out of `stand-down.mjs` on purpose: that file is staged alone by the operator queue and must stay
 * import-light, while these rules pull in the advisory and operator-answer modules.
 */
import { loadFlakeHolds as readHolds, loadFlakeHoldState as readHoldState, isStandDownSuperseded, loadFlakeResults } from './stand-down.mjs';
import { isAdvisoryMechanismStandDownSuperseded } from './advisory-fix-mark.mjs';
import { isOperatorAnswerStandDownSuperseded, latestOperatorAnswerAt } from './stand-down-answer-core.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

export function isLegacyLoadFlakeHoldSuperseded(comments, index) {
  return isStandDownSuperseded(comments, index)
    || isAdvisoryMechanismStandDownSuperseded(comments, index)
    || isOperatorAnswerStandDownSuperseded(comments, index);
}

export const loadFlakeHolds = (comments) => readHolds(comments, isLegacyLoadFlakeHoldSuperseded);

export const loadFlakeHoldState = (args) => readHoldState({ ...args, isSuperseded: isLegacyLoadFlakeHoldSuperseded });

/**
 * The load-flake results that count toward the reverify retry cap: only those posted AFTER the latest operator
 * answer (`stand-down-answer-core.mjs#latestOperatorAnswerAt`). The cap's "exhausted" result asks a human to step
 * in; once one has answered, the count restarts (live plateau #220: the answered re-dispatch was declared exhausted
 * on attempts made before the answer). With no answer this is every result, exactly as before.
 */
export function loadFlakeAttemptResults(comments) {
  const at = Date.parse(latestOperatorAnswerAt(comments) ?? '');
  const all = loadFlakeResults(comments);
  return Number.isFinite(at) ? all.filter((r) => Date.parse(r.createdAt) > at) : all;
}

/** Leading lines that close a review round after a push: a re-arm, a bounce, an accept, or an advisory review. Literal
 *  copies (not imports) keep this file import-light; each is the stable first line its writer posts. */
const REVIEW_ROUND_MARKERS = Object.freeze([
  '🔧 conveyor fix — re-armed for re-review',
  '🔁 review — changes requested',
  '✅ review — accepted',
  '**⚠️ THIS IS AN ADVISORY REVIEW',
]);

/**
 * A fix the reverify pass PUSHED for a bounced PR, still waiting for its re-arm (live #4361, 2026-10-08). The fixer
 * stood down on a load-flake hold, so it never re-armed; the later push changed the head but left `review:changes`
 * on it. The PR then read as "owed a fix" at a head that already IS the fix, and nobody worked it.
 * Owed when: the PR still carries `review:changes`, its head is the latest `pushed` alt sha, and no trusted re-arm
 * or review verdict has been posted since that push. Pure. Returns `{ sha, pushedAt }` or `null`.
 */
export function pushedLoadFlakeFixOwedRearm({ comments, headRefOid, labels = [] }) {
  const names = (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name));
  if (!names.includes('review:changes') || typeof headRefOid !== 'string' || !headRefOid) return null;
  const pushed = loadFlakeResults(comments).filter((r) => !r.redispatch && r.result === 'pushed').at(-1);
  if (!pushed || !(headRefOid.startsWith(pushed.sha) || pushed.sha.startsWith(headRefOid))) return null;
  const pushedAt = Date.parse(pushed.createdAt);
  const closed = (Array.isArray(comments) ? comments : []).some((c) => isTrustedMarkerAuthor(c)
    && Date.parse(c?.createdAt) > pushedAt
    && REVIEW_ROUND_MARKERS.some((m) => String(c?.body ?? '').trimStart().startsWith(m)));
  return closed ? null : { sha: pushed.sha, pushedAt: pushed.createdAt };
}

/** Minutes a live hold may wait for the reverify pass before it counts as unattended. */
export const loadFlakeNoPickupMinutes = (env = process.env) => {
  const n = Number(env.WE_LOAD_FLAKE_NO_PICKUP_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

/**
 * Live holds nobody has worked: older than the limit and with no reverify result (pushed / red-again / ...) recorded
 * since. Reads the hold with the same `loadFlakeHoldState` that reconcile and the reverify pass use, so the three
 * can never disagree about what a hold is.
 */
export function loadFlakeHoldsWithoutPickup({ prs = [], now, limitMinutes = loadFlakeNoPickupMinutes() }) {
  return prs.flatMap((pr) => {
    const state = loadFlakeHoldState({ comments: pr.comments, headRefOid: pr.headRefOid, now });
    if (!state.live || state.results.length) return [];
    const ageMinutes = Math.floor((now - Date.parse(state.hold.createdAt)) / 60_000);
    return ageMinutes >= limitMinutes ? [{ pr, hold: state.hold, ageMinutes, limitMinutes }] : [];
  });
}
