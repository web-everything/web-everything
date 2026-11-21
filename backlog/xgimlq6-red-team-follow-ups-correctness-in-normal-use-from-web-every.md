---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/operator-override.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7253 (head 6840f9f3c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7253 (reviewed head `6840f9f3c81ac6fc351e13377df483058b8b46ec`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/operator-override.mjs:11` — (failing-input, degraded) operator-override-show omits successfully stored enum overrides
   - Scenario: Run operator-override-set --key=ciHeal.loop --value=on --reason=test --actor=operator, then operator-override-show. The setter stores the enum in we:operator-enum-overrides.json, but show uses readOperatorOverrides, which reads only the numeric file. Show therefore reports empty values when no numeric overrides exist, instead of displaying ciHeal.loop=on.
   - Class: correctness-in-normal-use (basis: An ordinary set-then-show sequence loses visibility of the new setting. An injected-filesystem probe executed the actual enum reader and show compute: the enum reader returned on while show returned readable:true with empty values.)
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
