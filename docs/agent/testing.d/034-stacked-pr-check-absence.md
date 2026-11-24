## Stacked PR check absence

`scripts/conveyor/reconcile-pass.mjs` treats complete required-check absence on a non-default base
as waiting for that base PR; an unowned base surfaces `stacked-base-orphaned`. Partial or truncated
rollups still hydrate. `WE_STACKED_PR_CHECK_POLICY=strict` restores the prior hydration behavior.
Replay #3915 with `scripts/conveyor/soak/breaks/stacked-pr-missing-checks-refused.soak.test.mjs`.
The review daemon tags stacks surfaced only in notes, and promotion clears `awaiting-base` via
`applyReviewStatus`'s shared status matcher.

