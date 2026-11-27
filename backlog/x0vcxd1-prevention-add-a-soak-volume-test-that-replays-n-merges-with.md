---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch-main-red.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch-main-red.test.mjs", "we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a soak/volume test that replays N merges with no red and asserts the event count stays bounde… (from web-everything/web-everything#7553 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch-main-red.mjs:214` — Add a soak/volume test that replays N merges with no red and asserts the event count stays bounded and the report has no Unknown-observation warning. Alternatively, emit 'unknown' only while an episode is open.
2. `we:scripts/conveyor/health-watch.mjs:1427` — Add a write-gate rule: any sticky state flag documented as operator-cleared must have a named clear command and a test that sets the flag, clears it, and checks a tick then succeeds. Report metric warnings under their own probe name (e.g. mainRedMetrics) rather than mainRedAlert.
3. `we:scripts/conveyor/health-watch-main-red.mjs:299` — Add a check:standards rule for LOCK_HOLDERS: a 'wx' create of data that is read back must go through an atomic temp+link helper. Add a regression test that plants a torn file and checks recovery, or a clear operator diagnostic naming the file.
4. `we:scripts/conveyor/__tests__/health-watch-main-red.test.mjs:878` — Add a PR-template or lint check that every numbered Acceptance item names either a test or a recorded live-evidence artifact, with live items allowed to be explicitly deferred to a follow-up card.
5. `we:scripts/conveyor/main-ci-red-core.mjs` — Add a named fixed-vector test to we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs asserting the exact v1 digest and equivalence across property order, slash direction, and normalized whitespace; run it in the existing test gate.
6. `we:scripts/conveyor/health-watch-main-red.mjs` — Add the named test to we:scripts/conveyor/__tests__/health-watch-main-red.test.mjs, comparing journal membership, file contents, and alert-state contents before and after successful and refused reports in the existing test gate.
7. `we:scripts/conveyor/main-ci-red-core.mjs` — Add a deterministic regression test containing both a completed pre-range episode and a spanning episode, asserting only the spanning episode contributes ancillary metrics.
8. `we:scripts/conveyor/health-watch-main-red.mjs` — Serialize capacity checking and creation, and gate it with a deterministic interleaving test where two distinct-key writers compete for the final slot.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7553@05c2354ff1a499f3d6eefed5dc4606253374b0bd

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
