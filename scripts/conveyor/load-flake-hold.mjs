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
import { loadFlakeHolds as readHolds, loadFlakeHoldState as readHoldState, isStandDownSuperseded } from './stand-down.mjs';
import { isAdvisoryMechanismStandDownSuperseded } from './advisory-fix-mark.mjs';
import { isOperatorAnswerStandDownSuperseded } from './stand-down-answer-core.mjs';

export function isLegacyLoadFlakeHoldSuperseded(comments, index) {
  return isStandDownSuperseded(comments, index)
    || isAdvisoryMechanismStandDownSuperseded(comments, index)
    || isOperatorAnswerStandDownSuperseded(comments, index);
}

export const loadFlakeHolds = (comments) => readHolds(comments, isLegacyLoadFlakeHoldSuperseded);

export const loadFlakeHoldState = (args) => readHoldState({ ...args, isSuperseded: isLegacyLoadFlakeHoldSuperseded });

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
