---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7343 (head 5b6813797)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7343 (reviewed head `5b681379794a4c95331ab5f51d38fad4c2c7acd3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:357` — (failing-input, degraded) Captured test output falsely proves a real failure and suppresses refresh
   - Scenario: A failed job log contains a passing test's captured block: 'stdout | we:tests/parser.test.mjs &gt; prints an error fixture', then 'AssertionError: expected true', a blank line, and 'The runner has lost communication with the server.' The whole-log regex selects fixer and performs zero refreshes. The existing evidence collector correctly ignores the captured assertion and reports only infrastructure failure. When the routing helper is invoked, forceFixer nevertheless publishes a fixer-only recovery. This infrastructure failure should receive its one refresh; captured stdout should not prove an assert
   - Class: live-reproduced (basis: A Node probe exercised the checked-out guard, evidence collector and recovery adapter with mocked gh responses, an in-memory ledger and unrelated dependency stubs. The infrastructure-only control issued one update-branch request; adding captured assertion output issued no refresh and published a recovery comment and label.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/drain-queue-safety.mjs:406` — (edge-case, degraded) Author-created merge commits incorrectly inherit a spent refresh
   - Scenario: Head H0 has a spent refresh entry. The author merges a fix branch into the PR, creating H1 with parents H0 and the fix-branch tip. On H1's first infrastructure-only MQ failure, successor recovery treats any two-parent commit whose first parent is spent as a generated refresh commit. It claims H1 without issuing update-branch and selects fixer. H1 contains new authored changes and should receive its own refresh allowance; its second parent need not even be main.
   - Class: live-reproduced (basis: A Node probe of the checked-out guard used a spent H0 entry, CLEAN green H1 and one bound failed_checks event. A single-parent authored successor received a refresh; the two-parent authored successor was marked spent with zero refresh requests. GitHub responses and ledger storage were mocked.)
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
