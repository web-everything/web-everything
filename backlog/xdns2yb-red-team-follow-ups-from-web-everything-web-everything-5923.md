---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/record-red-team-ruling-io.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5923 (head 7548c7a48)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5923 (reviewed head `7548c7a4831fb0a5de17b625f65a150e3696365e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/record-red-team-ruling-io.mjs:381` — (edge-case, degraded) A stale label snapshot produces a false successful send-back
   - Scenario: Reproduced by starting block for confirmed #1 with review:changes present, then replacing that label with review:pending during the comment POSTs. The proof reads the updated thread, but the skip decision uses labels captured before posting. The sink returns sentBack=true and alreadyUnderChanges=true, writes a send-back ledger event, and never invokes the label writer; review:pending remains. It should verify the current labels before declaring the transition complete.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/record-red-team-ruling-io.mjs:379` — (edge-case, degraded) A failed block reason POST leaves an incomplete ruling that cannot be retried
   - Scenario: Reproduced with confirmed cap-held #1, anyState=true, and review:changes already present. Let the operator-block record POST succeed, then fail the reason POST. The operation throws before appending any ledger event. Replanning the identical block command refuses because #1 is already ruled block under review:changes. Thus a transient POST failure permanently skips the reason and ledger through the normal retry path. Retry should complete those outstanding writes.
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
