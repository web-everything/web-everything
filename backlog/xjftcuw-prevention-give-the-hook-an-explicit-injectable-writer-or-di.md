---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/audit-on-ready.test.mjs", "we:scripts/conveyor/audit-on-ready.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Give the hook an explicit injectable writer or dispatch dependency now, and assert it is never ca… (from web-everything/web-everything#7325 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:78` — Give the hook an explicit injectable writer or dispatch dependency now, and assert it is never called. A lint could also flag test options that the function under test never reads.
2. `we:scripts/conveyor/audit-on-ready.mjs:29` — Render the state in the log line, and add a test that an owed-unknown head is not marked seen, or is retried after a cooldown.
3. `we:skills-src/conveyor/review-daemon.mjs:1502` — Cache ok and weakened results per head in `seen`, and enforce maxPerTick in the planner with a test that the checks stop at the cap.
4. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:79` — Add a lint or test-helper rule that spies passed in an options bag must be a declared parameter of the function under test. For this slice, assert no gh, git or fs writes via module mocks.
5. `we:scripts/conveyor/audit-on-ready.mjs:43` — Test per-message cases against the real gate's message constants, or have the gate return a structured reason code instead of matching free text.
6. `we:skills-src/conveyor/review-daemon.mjs:1508` — Add a gate or lint that daemon tick hooks using sync child processes must declare a per-tick budget. Memoize terminal check results in the seen set per head. Carded for S1.2 per the PR.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7325@719d654e1760566fd60d4d905a6f29f4f103fdce

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
