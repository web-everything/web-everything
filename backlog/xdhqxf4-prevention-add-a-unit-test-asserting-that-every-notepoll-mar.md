---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/enqueue-catchup-dedupe.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a unit test asserting that every notePoll mark shape (numbered, '*', other repo) either clear… (from web-everything/web-everything#7146 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:1337` — Add a unit test asserting that every notePoll mark shape (numbered, '*', other repo) either clears the relevant memo or is on an explicit documented retain list. A lint that flags parseMarkKey null-returns left unhandled in feed consumers would also catch it.
2. `we:scripts/lib/__tests__/enqueue-catchup-dedupe.test.mjs:44` — Run the existing fail-open and TTL tests through describe.each over CATCH_UP_DECLINE_DEDUPE_KINDS, so every dedupe kind is exercised on every axis.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7146@3e860335db158eda5d8c7c26616fa18bbeee63e0

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
