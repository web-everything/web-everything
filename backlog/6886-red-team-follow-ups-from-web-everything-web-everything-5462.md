---
bornAs: xydwopc
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-gate.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/fix-push-ci.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5462 (head 9e20c5e5c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5462 (reviewed head `9e20c5e5c0217cc978e8ea190ce8c48194026f73`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-gate.mjs:318` — (edge-case, degraded) CI-heal overflow consumes the slot reserved for send-backs
   - Scenario: Set effective cap=2 and sendBackReservedSlots=1, with one live fix and no live CI-heals. The throttle refuses CI-heal with reserved:'send-back', but we:ci-heal-pr-dispatch.mjs:555 passes that refusal to ciHealReserve, which admits it. On the next pass, both claims count toward the cap and a review:changes fix is refused. A read-only probe reproduced this sequence. The overflow allowance must preserve the send-back reservation rather than fill it.
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/fix-procedure.mjs:759` — (edge-case, degraded) Harness-owned fixer pushes bypass the new CI hand-off
   - Scenario: With the default pushBeforeGate policy, we:await-verify-pass.mjs pushes a fixer commit through defaultAwaitVerifyIo.push while local verification remains running. That push uses pushShaFromScratch directly, bypassing both newly instrumented pushers. A probe of the actual function bodies with process/filesystem effects replaced in memory returned {ok:true}, issuing only the existing PR read and Git commands; neither labels nor a push record were written. The fix-end fallback runs only later, leaving the claimed immediate hand-off gap open. Instrument the harness push itself.
   - Claude's re-check: demonstrated break
3. `we:scripts/conveyor/fix-push-ci.mjs:60` — (failing-input, degraded) A rejected stale-head hand-off overwrites the current push record
   - Scenario: Record a successful push of head B, then let a delayed hand-off for older head A execute while GitHub still reports B. markFixPushAwaitingCi records A before checking the live head, then returns false. A probe using the actual recordFixPush/readFixPush implementations with an in-memory filesystem showed readFixPush(B) changing from the valid record to null. The watchdog consequently falls back to B's commit date: an hour-old commit pushed one minute ago can trigger recovery nine minutes early. Reject stale heads before replacing the current push record.
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
