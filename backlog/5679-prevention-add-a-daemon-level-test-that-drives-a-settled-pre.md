---
bornAs: x22vp51
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/prepare-failure-policy.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a daemon-level test that drives a settled prepare-needs-you outcome after a release and asser… (from web-everything/web-everything#4663 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/prepare-failure-policy.mjs:284` — Add a daemon-level test that drives a settled `prepare-needs-you` outcome after a release and asserts what holds the card and what releases it on the next card edit.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:946` — Add a prepare-path tick test with a stale `dispatcherFresh`, and a test that `cliEffects().releaseDuePrepareRetries` passes a function `cardChange` (or a source-regex check like the one for `hasStaleRefusal`).

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4663@68b19f640c28e5970f8461b0c02d499901603bc8

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
