---
kind: story
size: 5
parent: "xhwmyig"
status: open
blockedBy: ["x8a6951"]
scope: ["we:scripts/operations/incident-guards.mjs", "we:scripts/lib/quiet-hours.mjs", "we:scripts/settings/incident-coroner.json"]
dateOpened: "2026-10-17"
tags: []
---

# Guards, quiet hours, P0 budget and enforce switch

Add the daily P0 and total filing budgets (at most 3 auto P0 filings per day; the 4th becomes escalate with the reason budget; at most 10 auto filings per day overall; 1 per key per cooldown). Add the never-weaken-a-gate path check: any proposed scope under we:.github/, we:scripts/check-standards-*, we:scripts/guard-*, or a settings threshold change becomes escalate. Add quiet-hours routing (consume the isQuiet window from backlog 5614 once it lands): inside the window only main red and a daemon down for more than 30 min break through; everything else goes to the morning digest. Add the shadow or enforce switch and an audit completeness check on the ledger. Acceptance: tests for the 4th P0 becoming escalate, quiet-hours suppression with the main-red breakthrough, and gate-path escalation; the 7-day shadow report shows decisions; flipping to enforce is one setting. Operator decision 2026-10-17 (a): auto-queue a P0 fix only when a fixed rule matched the cause; LLM-proposed fixes wait for one-click operator approval.

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
