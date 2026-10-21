---
bornAs: xqyxlul
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-context-pack.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5369 (head 9efb3ce64)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5369 (reviewed head `9efb3ce64110bd258edaecb0400d89fb743c77b8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-context-pack.mjs:221` — (failing-input, degraded) The context-pack command fails from supported sibling-repository lanes.
   - Scenario: Dispatch a fix for Frontier UI, acquire its lane, and follow the new 'node we:scripts/operations/run.mjs revert-red-check ...' instruction after 'cd "$LANE"'. Frontier UI has no such runner. A read-only probe from a Frontier UI checkout exited 1 with MODULE_NOT_FOUND for that exact path. Qualify the command with {{WE_ROOT}}, as the main brief does, so it works from sibling checkouts.
   - Claude's re-check: The diff adds a cwd-relative 'node we:scripts/operations/run.mjs' in the fix-brief red-proof text. The brief's own version of the same command uses '{{WE_ROOT}}', which shows the runner lives in the web-everything checkout and not in sibling-repo lanes. Run from a non-WE lane, the relative path would fail to resolve.

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
