## Antigravity advisory seating and unavailable-provider evidence

`external-juror-liveness.test.mjs` pins `advisorySeats.antigravityReview=probation` to the
old unset-env model-probation check, forced on/off and environment precedence. Antigravity
graceful skips require an existing explicit `fallbackDecision` skip decision; absent, unknown
or `none` evidence must propagate validation and tool-denial errors. The #3481 replay in
`review-pr-io.test.mjs` checks that unset-env probation retains unruled referral holds.

