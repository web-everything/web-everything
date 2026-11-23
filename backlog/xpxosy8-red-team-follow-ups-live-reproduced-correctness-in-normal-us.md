---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7343 (head 5685d1466)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7343 (reviewed head `5685d1466787ddeb48fcc037cf8e3b45b14ba595`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:412` — (edge-case, degraded) Valid authored octopus merges lose their independent refresh attempt
   - Scenario: An earlier head of a PR has spent its refresh. The author pushes a new octopus merge commit with three valid parents, and its first merge-group attempt suffers an infrastructure failure. Although the new head is unspent, CLEAN, approved and green, successor recovery rejects its parent count, reports 'refresh ledger unreadable', selects fixer inspection and sends zero updates. A valid authored three-parent commit should retain its own refresh attempt.
   - Class: live-reproduced (basis: Executed the checked-out guard with an in-memory prior-head claim and valid commit responses. The one-parent authored-head control issued one update; changing only the parent count to three produced zero updates and the unreadable-ledger diagnosis.)
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
