---
kind: story
size: 2
status: open
scope: ["we:protocols/tools/validate-protocols.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from plateauapp/plateau-app#238 (head 3989dfc9f)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#238 (reviewed head `3989dfc9fff6bff67a76a186aa04e5da9f985242`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:protocols/tools/validate-protocols.mjs:59` — (edge-case, degraded) Large finite schedule durations cause a BigInt conversion exception.
   - Scenario: Use we:fixtures/registry.json with only its first row, set schedule to {"after":"PT72057594037929S"}, and retain expiresAt="2026-11-23T15:00:00Z" and nextExpectedAt=null. Running rule:inventory throws because duration milliseconds divided by 1000 becomes 72057594037928.98, which BigInt rejects. This registry should pass: the supported whole-second duration exceeds expiry, so nextExpectedAt must be null. The previous comparison handled this case without throwing.
   - Class: live-reproduced (basis: An in-memory vector using the actual validator reproduced the exception and changed watch-inventory from 40/40 passing to 40/41. This requires an unusually large duration, but the contract imposes no duration maximum.)
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
