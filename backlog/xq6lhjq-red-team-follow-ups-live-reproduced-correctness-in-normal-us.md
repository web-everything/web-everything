---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/check-scope.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7256 (head 89feae7b7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7256 (reviewed head `89feae7b74a5ac802abfdfe605268f84e9a7d223`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/check-scope.mjs:21` — (failing-input, degraded) Empty --files values falsely return a clear scope
   - Scenario: Run check-scope with --files=, as happens when an automation's file-list variable is unset. The parser accepts it, checkScope returns ok:true without collecting evidence, and the operation exits 0. Whitespace/comma-only strings and an empty declaredFiles array also pass. Reject an empty input scope with exit 2 before applying prose exemptions; valid prose-only scopes can still return clear.
   - Class: live-reproduced (basis: Executed the actual resolved operation through runOperationCli with an in-memory store and its finish handler: --files= returned code 0 and ok:true. A separate collector-spy probe confirmed whitespace/comma-only input performs zero evidence reads. The existing assessor rejects empty scopes.)
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
