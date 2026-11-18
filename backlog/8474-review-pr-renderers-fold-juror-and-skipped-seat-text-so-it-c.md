---
bornAs: xfhuuqp
kind: story
size: 2
status: active
scaffoldedBy: "fix-4770"
dateScaffolded: "2026-10-11"
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/lib/review-render.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# review-pr renderers: fold juror and skipped-seat text so it cannot start a structured footer line

Found fixing PR #4770 (mechanical-round-cap reader). we:scripts/operations/review-pr.mjs#renderVerdictWriteUp writes skippedSeats k.lens/k.reason unfolded AFTER its --- separator, and we:scripts/lib/review-render.mjs#renderFindingLine writes juror summary/failure_scenario/prevention unfolded; renderAdvisoryNote is posted without review-set-label's <!-- escaping. A newline in those fields can start a column-0 Net basis or reviewed-sha line. The reader in PR #4770 now ignores basis lines above the last --- and stamps on advisory notes, but a degraded write-up whose skipped-seat reason carries a full-shape Net basis line still names that head. Fix: fold those fields (foldUntrusted) at the producer.

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
