---
bornAs: x9etehg
kind: story
size: 3
status: open
scope: ["we:scripts/lib/__tests__/red-team-gate.test.mjs", "we:scripts/lib/__tests__/red-team-gate-operator-rulings.test.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs"]
dateOpened: "2026-11-16"
tags: [prevention, testing]
---

# Prevention — Pin operator-card release boundaries with mutation checks

PR #6933's review requested a durable guard for strict snippet fingerprints and every operator-release sink. The repair adds parameterized punctuation regressions, a release-sink table and the named same-head repost regression below. Add mutation verification for the punctuation and release-sink guards and retain the repost regression. This card records the remaining prevention work; it does not change the approved carry policy.

## Acceptance

- [A1] Mutation verification proves that erasing commas, semicolons, colons or periods from summary snippets makes the corresponding fingerprint and retained-hold regression fail.
- [A2] Mutation verification proves that removing republishing from any of card-existing, card-queued or not-real makes the corresponding release-sink table case fail. A queued job without validated completion must still publish nothing.
- [A3] Retain `same-head repost cannot inherit an earlier result card; cross-head matching findings can` in `we:scripts/lib/__tests__/red-team-gate-operator-rulings.test.mjs`: a different result with identical finding evidence on the same head stays blocked, a matching finding on a new head carries the card, and a fresh result-bound ruling releases the repost.
- [A4] Run the affected tests through the admitted unit-test command and record the mutation results without leaving mutated production files behind.

## Non-goals

Do not change operator authorization, the approved cross-head carry behavior, ledger trust, or check publication policy.

## Edge cases

- Punctuation changes include punctuation before spaces and adjacent operator tokens; whitespace and explicit file:line drift remain supported normalization.
- A failed or unreadable card receipt must stay held; an existing-card reference must not stand in for queued-card coverage.
- Publisher refusal and exceptions must preserve the recorded release and expose an unsuccessful check result.
- A different result on the same head must not be confused with cited-line drift on a new head.

Source: web-everything/web-everything#6933, review dated 2026-11-16; correctness/security prevention requests and the simplicity card suggestion.
