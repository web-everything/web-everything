---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/review-hold-ledger-shadow.mjs", "we:scripts/conveyor/__tests__/review-hold-ledger-shadow.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Commit deduplication signatures only after a successful append, and add a deterministic regressio… (from web-everything/web-everything#4495 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/review-hold-ledger-shadow.mjs` — Commit deduplication signatures only after a successful append, and add a deterministic regression test that fails the first append, succeeds the next, and asserts the unchanged disagreement is persisted exactly once.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4495@970a956194464cda9eae7e3bc5d8507153ca9d56

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
