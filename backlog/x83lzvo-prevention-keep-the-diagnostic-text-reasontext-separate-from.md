---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-dispatch-queue.mjs", "we:scripts/lib/red-team-queue-state.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs", "we:scripts/lib/__tests__/red-team-queue-state.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Keep the diagnostic text (reasonText) separate from the stored blockedReason, and use reasonText… (from web-everything/web-everything#7401 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-dispatch-queue.mjs:345` — Keep the diagnostic text (`reasonText`) separate from the stored `blockedReason`, and use `reasonText` in every log line. Add a test that exercises requeue with a missing `why`.
2. `we:scripts/lib/red-team-queue-state.mjs:23` — For each guard in a reader, add a table-driven test row that makes only that guard fail. Review should check each prose guarantee against such a row.
3. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:1373` — Add `we:scripts/lib/__tests__/red-team-queue-state.test.mjs`. It should be a table test over wrong repo, wrong head, wrong key, duplicates, non-array JSON, corrupt JSON and a missing reason, each asserting `null`. File it as a backlog card. A review-lens rule would also help: a negative test must assert absence of the guarded output, not just an unchanged outcome.
4. `we:scripts/lib/red-team-dispatch-queue.mjs:370` — Route every `changed()` interpolation of `failure.reason` through `boundedReason`, and add a test with an ESC and a very long reason on the requeue path. File it as a backlog item. A lint rule that flags raw `failure.reason` in log templates would catch the whole class.
5. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:747` — Add a deterministic named test asserting sanitization of control characters inside an untruncated reason.
6. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:1373` — Add table-driven reader tests for wrong repo, PR, head, key, and duplicate identities, asserting null; assert no annotation in the corresponding drain outcomes.
7. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:720` — Extend the named persistence test to assert exactly one log for each changed reason, and add a named requeue test asserting the emitted reason.
8. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:746` — Add a deterministic short-input sanitization test with embedded control characters and an exact expected result; removing the replacement must make that named test fail.
9. `we:scripts/lib/red-team-queue-state.mjs:22` — Add a table-driven reader test that independently violates each predicate and asserts null.
10. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:720` — Add named tests asserting the reason in requeue and post-load daemon logs, and map Acceptance guarantees to those tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7401@2e3485f9626681a41f6163e6a4472f3c839a14d8

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
