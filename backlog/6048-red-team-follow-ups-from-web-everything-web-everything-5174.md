---
bornAs: xwsvfv8
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-ledger-shadow.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5174 (head 56e0064f5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5174 (reviewed head `56e0064f5394df4e40d744eee584f27bb9a78a47`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-ledger-shadow.mjs:204` — (failing-input, degraded) The readiness timeout does not bound synchronous work, including the default history reader.
   - Scenario: Call runLedgerShadow with verdicts:[], timeoutMs:5 and a readiness callback that synchronously waits 80ms before returning {ok:true}. The probe took 80ms and returned readiness.ok:true instead of timing out. Promise.race cannot fire its timer while that callback blocks the event loop. defaultReadiness likewise performs synchronous history reads and measurement, so slow or sufficiently large history can exceed the timeout and stall the drain. Perform readiness work in an interruptible execution context or implement a bounded read/measurement strategy.
   - Claude's re-check: The readiness callback runs inside Promise.resolve().then(...) and the default reader is synchronous. A blocking callback or large history read holds the event loop, so the timeout timer can't fire and the race doesn't bound the work.

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
