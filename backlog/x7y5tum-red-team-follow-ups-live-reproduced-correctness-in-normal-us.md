---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/host-load.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7505 (head cd56cf884)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7505 (reviewed head `cd56cf8848ea8463492dfdcef47049732a3cc719`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/host-load.mjs:132` — (edge-case, degraded) Warn admission ignores the caller's coordination root
   - Scenario: Call hostLoadAdmission with env.WE_COORDINATION_ROOT pointing to root B and a live warn reading. Give B a fresh snapshot with freePct=5, availableMb=512 and swapGrowthMb=0, while the process-default root A has a fresh clean snapshot with freePct=40 and availableMb=30000. The default readSnap reads A and admits. It should read B and hold for corroborated memory scarcity. Conversely, a missing snapshot at A unnecessarily holds work even when B has clean evidence.
   - Class: live-reproduced (basis: Executed hostLoadAdmission in Node using its default readSnap and real readSnapshot, with readFileSync instrumented in memory to supply distinct snapshots for two roots. The recorded read used the process-default root despite the supplied env override, and admission returned true; evaluating B's snapshot returned false.)
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
