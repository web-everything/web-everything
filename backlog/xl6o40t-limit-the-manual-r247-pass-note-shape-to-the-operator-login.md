---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Limit the manual R247 pass note shape to the operator login only

Reinforce #6713: the 'Manual R247 pass — daemon: X; reason: EMERGENCY (labelled): …' shape in we:scripts/lib/accept-carry-forward.mjs is exempt from supersede-accept for ANY trusted marker author (bot included) and its free-text tail is guarded only by a hold-word list (audit residual, ruled R895+R903: a trusted comment such as 'approval revoked; further review required' still passes). Restrict that shape to OPERATOR_LOGINS (we:scripts/lib/marker-authorship.mjs) and keep the whole-body anchor; add a red-first test that a bot-authored copy and a revocation tail both still hold.

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
