---
bornAs: xpyvd8n
kind: story
size: 2
status: open
scope: ["we:scripts/operations/record-red-team-ruling-io.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5923 (head 62863380f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5923 (reviewed head `62863380f100c89bbbf7f82172a0344d2d44f469`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/record-red-team-ruling-io.mjs:379` — (edge-case, degraded) A failed block reason post permanently prevents completing the ruling.
   - Scenario: Start with a confirmed cap-held break and review:changes already present. Invoke ruling=block; let the operator-block record POST succeed, then fail the reason-comment POST. The sink throws before recording any ledger event. Replanning the same ruling refuses because the persisted block plus review:changes counts as complete, so the operator's reason and ledger event cannot be recovered through retry. Reproduced in both any-state and default cap-only modes. Completion must remain retryable until the reason and remaining required writes are persisted.
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
