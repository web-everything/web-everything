---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5331 (head 94566b220)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5331 (reviewed head `94566b220d1c8172471f4c9350e4ac6b03af1036`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:396` — (failing-input, degraded) Unrelated timeout failures are classified as the same main defect
   - Scenario: Let the PR's test job fail because a new component deadlocks, logging 'Test timed out in 5000ms'. Let a recent main run have test passing but an unrelated soak-shard failure logging 'Test timed out in 600000ms'. The actual reader returned matched:true with signature:test-timeout, and classifyMainDefect returned mainDefect:true despite attribution:own-failure. Matching ignores failingCheckName, job identity and the failing test. These unrelated failures should retain own-failure attribution; sharing a generic timeout category does not establish a shared defect.
   - Claude's re-check: defaultReadMainFailureSignature takes failingCheckName but never uses it. It matches any shared generic signature (test-timeout) in any failed job of any recent failed main run, so an unrelated main failure yields matched:true and classifyMainDefect gives mainDefect via main-failure-signature over own-failure.

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
