---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a write-gate or review-lens rule that each numbered Acceptance clause maps to a named test ca… (from web-everything/web-everything#7247 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4480` — Add a write-gate or review-lens rule that each numbered Acceptance clause maps to a named test case in the PR's Tests section.
2. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4473` — Assert `tick.prepare.skippedInPlanning` in every fail-closed test case.
3. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4476` — Add a cross-check to the card/PR standards gate. Each guarantee named in Acceptance must map to a named test file and case, and the check flags any guarantee with no test reference. Until that gate exists, file a backlog item to add a build-side assertion for an expired list.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7247@23329491e0747c5e25c9cfbc9bf350019062e300

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
