---
bornAs: xdlqu2e
humanGate: { kind: setup, what: "operator creates and installs the reviewer GitHub App" }
kind: story
size: 3
status: resolved
dateResolved: "2026-10-10"
supersededBy: "x16g3q5"
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Reviewer GitHub App: reviews post as their own identity (native reviews, own API budget)

Operator 2026-10-10: will create a separate GitHub App for reviews. The review daemon posts reviews/advisories and swaps review labels as that App, enabling native GitHub reviews (an approval from a non-author identity) and giving reviews their own API budget (shared core limit exhausted 2026-10-10 20:25Z, 15,000/h). Identity is a setting (review.identity) via the cascade with fallback to the shared App. HUMAN GATE (setup): operator creates and installs the App; agents wire the review daemon and token shim. Done when: a live review on a real PR is posted by the reviewer App, and the shared App's call count drops accordingly (coroner GitHub-calls section).

**Merged into x16g3q5 (2026-10-10):** the operator moved to five per-role Apps (worker, reviewer, merger, ledger, observer); this card's App, its permissions, rulesets and cutover now live in that one migration card.

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
