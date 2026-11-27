---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7567 (head 51ec16055)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7567 (reviewed head `51ec16055eae888af6f7c34c780c650b9524aec7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/rearm-review.mjs:297` — (edge-case, degraded) A duplicate operator answer revives an already consumed resume
   - Scenario: Start with a valid no-code operator answer, its matching resume claim, and a trusted no-code-rearm receipt consuming that answer. Append another trusted answer naming the same already answered stand-down and head. rearmWindow ignores the duplicate, but findLastIndex selects it and scans for consumption only after it. The CLI consequently hands off to the label writer despite the earlier receipt. It should keep refusing until a new eligible authorization exists.
   - Class: live-reproduced (basis: Executed the checked-out guard and CLI block with mocked forge I/O: the receipted ruling exited 1 without handoff; appending the duplicate answer produced exit 0 and a head-pinned label handoff. This requires duplicate trusted-author delivery, not an untrusted commenter or concurrency.)
   - Also class: theoretical-race
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
