---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7532 (head 98ddfcd40)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7532 (reviewed head `98ddfcd403d4c5719b7b370c143fa226495fd401`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:670` — (failing-input, degraded) Input-only CI-heal misses still trigger stronger-model escalation
   - Scenario: Run three no-change CI-heal attempts on one head with truncated CI context. Each receives cause=input, but settlement records its loop outcome with infra=false. With default maxSessions=3, after the 120-minute window fixLoopDisposition returns rearm with reason 're-arm window elapsed' and no strongerModel field. This expression treats the absent field as permission to escalate, even though modelCount is zero. Excluded input failures should not authorize stronger-model escalation; the independent raw session ceiling can still bound retries.
   - Class: live-reproduced (basis: An in-memory probe of the checkout's ledger functions and exact strongerModel expression produced count=3, modelCount=0, disposition=rearm, and strongerModel=true for three input-only no-change outcomes under the default thresholds.)
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
