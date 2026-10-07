---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/retry-backoff.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/retry-backoff.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Have the ledger re-list exhausted card-refused records under needsYou on every tick, or clear the… (from web-everything/web-everything#4244 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:583` — Have the ledger re-list exhausted card-refused records under `needsYou` on every tick, or clear them when the card's spec hash or the dispatch-lane version changes. Add a test that ticks twice and asserts the second tick still reports the card.
2. `we:scripts/conveyor/retry-backoff.mjs:89` — Add a deterministic regression test asserting that prepare classification remains unknown for card refusals whose quoted values contain recognized backoff tokens, and suppress token matching for such refusals in the shared classifier.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4244@940551fcda62538d9a644894635476bed2035e77

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
