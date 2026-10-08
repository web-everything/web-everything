---
kind: story
size: 3
status: active
scaffoldedBy: "pre-pr-briefs"
dateScaffolded: "2026-10-08"
scope: ["we:skills-src/conveyor/delivery-agent-brief.md", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:scripts/operations/pre-pr-check.mjs", "we:scripts/lib/pre-pr-review.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Make the pre-PR review the normal path: briefs, pre-pr-check helper, open-pr hint

The pre-PR review gate (#4271) is in advise mode, but overnight every risky PR opened without a receipt because the fix and ci-heal briefs never mention it. This item adds the step to all three briefs (delivery, fix, ci-heal), adds a `pre-pr-check` helper that says gated or not and prints the exact converge and receipt commands, and prints that same command in open-pr's advise warning. Without agents running the review there is nothing to measure before enforce (#5319).

## Done when

1. **Executable** — `npx vitest run` on we:skills-src/conveyor/__tests__/pre-pr-review-step.test.mjs and we:scripts/operations/__tests__/pre-pr-check.test.mjs fails before this item lands (no step in the briefs, no helper) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the lane path is shell-quoted in the printed command; the only diff-derived text printed is the risk reasons (file counts, never file content) and a git error message cut to 300 characters.
2. **Truncated reads** — n/a: the helper reads the same bounded git output as open-pr and fails closed on an unreadable diff (reports gated).
3. **Shared state files** — n/a: read-only; it reads the receipt file and never writes it.
4. **Fail closed** — a check error prints gated with the error, never 'not gated'.
5. **Identity scoping** — n/a: the helper takes the lane path explicitly and works per checkout.
6. **State over time** — the receipt is keyed by tree and base; a stale or wrong-base receipt is not accepted, so the helper still says a review is needed (with its own reason, receipt-stale or receipt-base-mismatch).
7. **Who wrote it** — n/a: the helper makes no trust decision beyond the existing open-pr gate.
