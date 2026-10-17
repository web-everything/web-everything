/**
 * @file scripts/operations/review-pr-constants.mjs
 * @description The three frozen constant tables `review-pr` declares and its consumers read — `CONFIRM_ACTORS`,
 * `CONFIRM_OPTIONS` and `REVIEW_EFFECTS` — in a module that does NOT import the whole review operation (#5725).
 *
 * `we:scripts/lib/review-loop-policy.mjs` and its test needed only these values yet imported the full operation
 * (jury core, step kinds, registry), paying that collection cost on every run. `we:scripts/operations/review-pr.mjs`
 * imports and RE-EXPORTS the very same objects, so every old import keeps working and the identities are equal
 * (`import { REVIEW_EFFECTS } from './review-pr.mjs' === import { REVIEW_EFFECTS } from './review-pr-constants.mjs'`).
 *
 * This module imports only `LEDGER_EFFECT_TYPE` from its existing owner (`effect-executor.mjs`); it must never
 * import `review-pr.mjs` back.
 */

import { LEDGER_EFFECT_TYPE } from './effect-executor.mjs';

/** What the `confirm` step records as the actor. `human` on a gate-self PR, `agent` otherwise. */
export const CONFIRM_ACTORS = Object.freeze({ HUMAN: 'human', AGENT: 'agent' });

/** The closed answer set for the `confirm` step. `abstain` is the non-mutating exit: it declares NO effects. */
export const CONFIRM_OPTIONS = Object.freeze(['accept', 'changes', 'abstain']);

/**
 * The effect types this operation declares. `WRITE_UP` belongs to `stageVerdict`; `LABEL`/`LEDGER`/`NOTICE`
 * belong to `record` (#3540 split the write-up out of `record`, ahead of the label swap); `verdict-ledger.append`
 * is #3032's reserved seam for #3007. `ADVISORY_NOTE` (#xlw02hw) belongs to `advise` and is deliberately its OWN
 * type, never `WRITE_UP`/`LABEL` — those two are the real ceremony's write and a caller (or a sink lookup keyed
 * by type) must never be able to confuse the two kinds of comment this operation can post.
 *
 * `AWAITING_ADVISORY_CLEAR` (mechanical-dispatcher lane) also belongs to `advise` — it is the mechanical flip of
 * `review:awaiting-advisory` → cleared, declared as a SECOND effect right after `ADVISORY_NOTE` so the two are
 * applied by the SAME executor, strictly in order: the note posts first, and only once it has genuinely landed
 * does the executor move on to clear the label. It is its own type (never `LABEL`, `record`'s own effect) for
 * the same reason `ADVISORY_NOTE` is not `WRITE_UP` — this is a plain label removal, not a verdict swap, and the
 * two must never be confusable by a sink lookup keyed on type.
 */
export const REVIEW_EFFECTS = Object.freeze({
  WRITE_UP: 'review.write-up',
  LABEL: 'review.label-swap',
  LEDGER: LEDGER_EFFECT_TYPE,
  NOTICE: 'review.notice',
  MANDATORY_REFERRALS: 'review.mandatory-referrals',
  ADVISORY_NOTE: 'review.advisory-note',
  // `advise`'s SECOND effect: the `advisory:accepted` / `advisory:changes` label. Its own type for the same reason
  // as `ADVISORY_NOTE` — never `LABEL`, which is the real ceremony's `review:*` swap.
  ADVISORY_LABEL: 'review.advisory-label',
  AWAITING_ADVISORY_CLEAR: 'review.awaiting-advisory-clear',
  // Ledger plan slice E2: the `referral` and `review-run` ledger events. ADDITIVE ONLY, never a decision.
  LEDGER_EVENTS: 'review.ledger-events',
  // Card 5469: the scoped re-review shadow (finding-identity ledger rows + would-block/would-card journal). SHADOW ONLY.
  SCOPED_REREVIEW_SHADOW: 'review.scoped-rereview-shadow',
  // Held item 177: an ACCEPT on a stacked top, recorded as a `reviewed-stack` marker instead of `review:accepted`.
  STACK_HOLD: 'review.stack-hold',
});
