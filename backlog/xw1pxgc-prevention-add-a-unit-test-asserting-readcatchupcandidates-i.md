---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a unit test asserting readCatchUpCandidates issues at most K comment reads, or reads them wit… (from web-everything/web-everything#5241 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:330` — Add a unit test asserting readCatchUpCandidates issues at most K comment reads, or reads them with bounded concurrency, plus a lint against sync exec calls inside async daemon handles. File this as a backlog item.
2. `we:scripts/lib/enqueue-on-event.mjs:300` — Filter verdict comments to the review bot's login before they feed any priority or ordering decision. Add a unit test that a verdict-looking comment from a non-bot author is ignored. A lint or write-gate on `parseVerdictComment` callers that lack an author check would catch the whole class.
3. `we:scripts/lib/enqueue-on-event.mjs` — Add a deterministic unit regression with one due event PR, one catch-up candidate, and capacity one, asserting that a successful event enqueue prevents the catch-up spawn; include it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5241@a68cb19fb55ea02f6d1ac70769c667204cde4efd

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
