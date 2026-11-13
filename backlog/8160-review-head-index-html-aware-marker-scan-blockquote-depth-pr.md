---
bornAs: xtt0fti
kind: story
size: 3
status: active
scaffoldedBy: "card-ruling-non-regression"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/lib/review-head-index.mjs"]
dateOpened: "2026-11-11"
tags: []
---

# review-head-index: HTML-aware marker scan (blockquote depth, </pre> in attribute)

Red-team break on PR #6378 (we:scripts/lib/review-head-index.mjs:306): the marker scan is not HTML-aware, so a marker inside a blockquote of nested depth, or a closing pre tag inside an attribute value, is mis-read. Carded under R903: the module is new in the PR, absent on main and has no callers, so the break cannot regress main. Make the scan HTML-aware (blockquote depth, pre close in an attribute) with tests.

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
