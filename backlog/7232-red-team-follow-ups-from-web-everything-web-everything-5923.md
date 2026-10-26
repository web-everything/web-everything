---
bornAs: xfkmmkx
kind: story
size: 2
status: open
scope: ["we:scripts/operations/record-red-team-ruling-io.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5923 (head 90df9e891)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5923 (reviewed head `90df9e8917cd400fdbe9a564d7943d1b013d04c0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/record-red-team-ruling-io.mjs:390` — (edge-case, degraded) A stale label snapshot can report a send-back that never happened
   - Scenario: Start a block with review:changes present. During the reason-comment POST, another writer replaces it with review:accepted on the same head/result. proveHeld reads the updated thread, but the subsequent alreadyUnderChanges decision uses labels captured before both POSTs. A read-only injected-IO probe returned sentBack:true and alreadyUnderChanges:true while labels remained review:accepted and runSetLabel was called zero times. The red-team hold persists without returning the PR to the fixer. Use the fresh read-back labels and restore review:changes, or report an incomplete send-back.
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
