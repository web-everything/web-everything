---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/hotpatch-readers.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7361 (head 20f0d672b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7361 (reviewed head `20f0d672b6011c1e0f4fbce5ed1ba7ff7dba04ca`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/hotpatch-readers.mjs:80` — (failing-input, degraded) Full-suite verification rejects legitimate logs showing zero quarantine exclusions
   - Scenario: Run the complete suite with quarantine mode enabled during workflow_dispatch, or with an empty quarantine list. The existing quarantine helper reports main runs every test or no live quarantine entry, with no exclusion arguments. fullSuite nevertheless returns false because those messages lack the literal running everything. These complete executions should remain valid receipts.
   - Class: live-reproduced (basis: The actual quarantine decision function produced both zero-exclusion messages. Evaluating the checked-in production reader with injected transport returned true for the baseline log and false for either legitimate replacement message, with successful jobs unchanged.)
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
