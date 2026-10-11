---
bornAs: xgzgz8u
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/takeover-review.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4759 (head 6b11cff44)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4759 (reviewed head `6b11cff4469201d780b114121a760f3a65e9e648`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:1363` — (failing-input, degraded) Setting takeoverReviewAttempts to zero does not disable reviews beyond the cap
   - Scenario: Reproduced with roundCap=5, takeoverReviewAttempts=0, a trusted automatic takeover marker recording attempts=5, six re-arm comments, review:pending, a new head, green required CI, and no live agents. planReconcile emits kind:'review' at attempts=6 with no refusal. takeoverReviewCap unconditionally raises the ordinary review cap to 6, so the disabled grant is never consulted. The documented zero setting should preserve the cap and refuse this beyond-cap review.
   - Claude's re-check: In 'dispatchReviewRow', 'reviewCap = takeoverReviewCap(comments, roundCap)' never reads 'takeoverReviewAttempts'. A trusted marker with attempts=5 raises the cap to 6, so a review at attempts=6 dispatches even with the setting at 0. That contradicts the documented '0 turns it off'.
2. `we:scripts/conveyor/takeover-review.mjs:57` — (failing-input, degraded) An unchanged pre-takeover head can receive the takeover review grant
   - Scenario: Reproduced at 5/5 with review:changes, green CI, a trusted changes-requested comment containing findings but no full head SHA, and an automatic takeover marker naming the current head A. The takeover crashes before pushing; its claim expires and no agent remains live. takeoverReviewGrant returns ok:true and planReconcile dispatches a review of unchanged A. The implementation discards the marker's head and treats absence of A's full SHA in verdict prose as evidence of a new head. An automatic takeover grant should require head movement; this failed takeover should instead reach the spent-takeov
   - Claude's re-check: 'takeoverReviewGrant' uses only the marker's timestamp and discards its head. Its only guard against an unchanged head is a verdict body containing the full 40-char SHA. This diff's own fixtures ('cappedPr') have changes-requested verdicts with no SHA. A takeover that crashes before pushing then returns ok:true, and a review of the unchanged head is dispatched.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
