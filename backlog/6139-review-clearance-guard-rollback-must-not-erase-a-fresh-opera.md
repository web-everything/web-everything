---
bornAs: xpd9gqp
kind: task
status: open
scope: ["we:scripts/lib/review-clearance-guard.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-14"
tags: []
---

# Review clearance guard: rollback must not erase a fresh operator clearance on an unchanged head

Operator ruling 'card' on PR #5237 red-team break #2 (2026-10-14 ~20:20 ET). we:scripts/lib/review-clearance-guard.mjs ~280: the newerAcceptanceOnHead shield is gated on 'moved &&', so on an unchanged head a fresh operator clear-human inside the guard's post-write window counts as a revocation (revokedSinceValidation) and the rollback swaps review:accepted back to review:pending. Narrow and fail-closed. Fix: apply the newer-acceptance shield regardless of head movement; test with a real buildVerdictComment clear-human body inside the window.

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
