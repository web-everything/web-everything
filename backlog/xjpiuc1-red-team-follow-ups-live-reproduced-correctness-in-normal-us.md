---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/test-timeout-policy.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7374 (head 7cf216c9c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7374 (reviewed head `7cf216c9cad0d7d325b7dd31b649b5eb3799e5fd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/test-timeout-policy.mjs:72` — (edge-case, degraded) Duplicate test names prevent immediate soft-timeout quarantine.
   - Scenario: With the shipped policy, pass a test-shard (1) log containing two repetitions of 'FAIL we:a.test.mjs &gt; case' followed by 'Error: Test timed out in 5000ms.', then 'Test Files 1 failed' and 'Tests 2 failed'. Both outcomes classify as soft, but allSoft returns false because each name matches two outcomes. Without flake proof, planSafetyNet returns action none instead of add. Distinct names sharing their first 200 characters also fail after parser truncation. Match occurrence counts so two corresponding soft timeouts qualify.
   - Class: live-reproduced (basis: Read-only Node probes against the checked-out modules reproduced both collisions. The unique-name control returned action add; duplicate names and distinct names sharing a 200-character prefix returned action none despite complete parses and two soft outcomes.)
   - Also class: correctness-in-normal-use
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
