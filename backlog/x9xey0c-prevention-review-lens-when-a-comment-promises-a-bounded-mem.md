---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Review lens: when a comment promises a bounded-memory or streaming property, require a test that… (from web-everything/web-everything#4464 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1788` — Review lens: when a comment promises a bounded-memory or streaming property, require a test that observes retention (a spy on store.read lifetimes or a record-count high-water mark), not just output equality. Ship unrelated fixes as separate PRs, each with its own card.
2. `we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1791` — Add a deterministic subprocess regression test with a constrained heap and a synthetic store generating enough distinct large records to fail under bulk retention; require successful completion and the expected session map.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4464@94b5ffd504bc69d69d72de244d5440d2f633bc58

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
