---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/record-red-team-ruling.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5923 (head c41e4039a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5923 (reviewed head `c41e4039ae57a79fffe8743d242813c9e319c957`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/record-red-team-ruling.mjs:128` — (edge-case, degraded) A failed reason POST makes an incomplete block ruling unretryable
   - Scenario: Start with confirmed finding #1, a trusted round-cap record, review:changes already present, and anyState=false. Invoke --ruling=block --break=1 with a valid operator, channel and reason. Let the operator-block POST succeed, then fail the reason POST at we:record-red-team-ruling-io.mjs:388. The invocation throws before recording any ledger event. After posting recovers, retrying the same command is refused because the persisted block plus review:changes is considered complete. An in-memory probe of the changed modules confirmed one posted hold record, no persisted reason, zero ledger events, and
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
