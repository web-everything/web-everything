---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/operator-send-backs.mjs", "we:scripts/lib/ruling-ledger.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Infra-stalled fix-ends must not spend operator send-back rounds (reconcile-core, operator-send-backs)

Same defect class as PR 6820 review finding: we:scripts/conveyor/reconcile-core.mjs operatorSendBackRound (fix-end count after latest send-back) and we:scripts/lib/operator-send-backs.mjs sendBackNotAddressed count any trusted fix-end comment, including ones marked blocked-on-infra, so an outage spends the extra operator-ruling round or raises a ruling-not-addressed notice. Fix: one shared helper (e.g. countsAsFixerRound in we:scripts/lib/ruling-ledger.mjs: trusted author, fix-end prefix, no FIX_END_INFRA_STALL_PREFIX) used by every reader, plus a test pinning that no direct fix-end counter bypasses it.

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
