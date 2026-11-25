---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7469 (head 178d0b4ad)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7469 (reviewed head `178d0b4ad11ac45ff65237fa45acd3bf3ec273f5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-loop-cli.mjs:627` — (edge-case, degraded) Returned engine errors bypass fixed-class handling
   - Scenario: Invoke with --pr=1234 --repo=web-everything/web-everything --json and a readPr reader that throws Error('upstream request failed: Bearer abc123'). driveRun catches this as a step-refused outcome, so the executable boundary receives a successful return and never classifies the error. renderOutcome prints the message in the JSON error field, including abc123. This path should emit a fixed error class and send details only to the protected debug sink.
   - Class: correctness-in-normal-use (basis: Source tracing shows readPr exceptions become returned outcomes and reach renderOutcome unchanged. A direct probe of the actual redactSpawnText function confirmed this exact message survives unchanged. Full CLI reproduction was blocked by missing dependencies; this is not claimed as an end-to-end reproduction.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
