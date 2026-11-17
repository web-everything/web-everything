---
kind: task
status: open
dateOpened: "2026-11-17"
tags: [daemon, probation, testing]
related: ["8409", "8558"]
scope: ["we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs"]
---

# Separate unreadable-state promotion coverage from rollback-marker refusal

Filed for PR #6882's 2026-11-17 later-round card suggestion (simplicity).
The existing `unreadable rebuild state refuses promotion and rollback: %s` case
in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs:709` installs a
pending rollback marker before its promotion assertion. That marker returns
before the promotion guard, so the assertion does not prove the guard rejects
unreadable rebuild state. This is a coverage gap, not a demonstrated guard bug.

## Acceptance

- A1: Planned `unreadable rebuild state refuses promotion without a rollback marker: %s`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must separately
  cover corrupt JSON, directory, missing file, array and null. With matching
  current PID/head, timely healthy tick evidence and no rollback marker, assert
  refusal reason `rebuild-state-unreadable`, unchanged proven-good and probation
  bytes, no reset, and one deduplicated needs-you alert after repeated checks.
- A2: Planned `readable rebuild state promotes through the same healthy evidence path`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert pass,
  proven-good promotion and probation deletion with the same inputs except a
  readable state, proving the negative case reaches promotion eligibility.
- A3: Keep rollback refusal separate. Existing case
  `unreadable rebuild state refuses promotion and rollback: %s` in
  `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must continue to
  assert refused recovery and a retained rollback marker. A1 separately asserts
  promotion refusal and preservation of proven-good and probation bytes.

## Proof plan

Demonstrate the new negative cases discriminate a promotion-guard regression
through the normal mutation check; do not manually remove a guard to get red.
Filing this card does not claim the planned cases are implemented or executed.

## Non-goals

No promotion-policy or rollback-policy change in this coverage repair.
