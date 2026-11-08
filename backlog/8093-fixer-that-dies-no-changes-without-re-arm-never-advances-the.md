---
bornAs: xzeoyze
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/fix-loop-ledger.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# fixer that dies/no-changes without re-arm never advances the round counter or the loop ledger

Flow-sim gap E-G2, class K14 (progress counter counts only successes). Failing input: PR review:changes, attempts < cap, no stand-down; Claude fixer session dies before step 0b fix-begin (auth/crash/context) or ends with outcome no-change/no-change-unproven and no stand-down' 'claim lapses/released, next tick re-plans Cited: we:scripts/conveyor/reconcile-pass.mjs:647-652, we:scripts/conveyor/reconcile-core.mjs:1868-1876, we:scripts/operations/fix-run.mjs:1175-1188, we:scripts/conveyor/orphan-fix-round.mjs:127-128, we:scripts/conveyor/fix-loop-ledger.mjs. Soak-break sketch: a fresh fixer session per tick on the same head with the counter stuck, until an external stop. Codex-routed runs are bounded (ROUTED_CODEX_MAX_UNPRODUCTIVE=2, we:fix-run.mjs:679); Claude-routed runs are not by anything I read.

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
