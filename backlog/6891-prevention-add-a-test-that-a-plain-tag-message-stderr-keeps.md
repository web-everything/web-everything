---
bornAs: xyui2xf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pending-launches.mjs", "we:scripts/conveyor/build-dispatch-failures.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs", "we:scripts/conveyor/__tests__/pending-launches.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-failures.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a test that a plain '[tag] message' stderr keeps its text in the launch-died reason. Better,… (from web-everything/web-everything#5472 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pending-launches.mjs:52` — Add a test that a plain '[tag] message' stderr keeps its text in the launch-died reason. Better, scrub undecodable text with redactSpawnText plus a quote-unescape pass instead of replacing it wholesale.
2. `we:scripts/conveyor/build-dispatch-failures.mjs:124` — Add a deterministic regression test using a cooldown shorter than the ordinary backoff and assert the resulting retryAfter retains the longer deadline.
3. `we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs` — Extend the named test with threshold 3, asserting no cooldown after the second same-base failure and cooldown after the third; run it as a deterministic test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5472@4a3207d3142511079f14ffb51b2ed6f6a5864fdd

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
