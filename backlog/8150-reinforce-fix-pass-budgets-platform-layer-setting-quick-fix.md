---
bornAs: xfkytxs
kind: story
size: 3
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# Reinforce fix-pass budgets: platform-layer setting, quick fix-only pass between full passes

Reinforce the fix-pass budget change (R825 residuals). (1) The platform layer of the policy cascade is not read for `fixPassBudget`. (2) The optional light fix-only quick pass between full passes (quickPassEveryMs, sharing the claim ledger) was not built. (3) The stuck-fixers budget cannot interrupt in-flight discovery or release IO; that needs a change in `we:scripts/conveyor/fixer-stuck-reclaim.mjs`.

## Acceptance

- [A1] **Executable** — a test in `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs` that a platform-layer `fixPassBudget` value is honoured and clamped; fails before, passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing excluded beyond the three residuals above.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.
2. **Truncated reads** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.
3. **Shared state files** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.
4. **Fail closed** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.
5. **Identity scoping** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.
6. **State over time** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.
7. **Who wrote it** — n/a: settings-only reinforcement; behaviour inherited from the fix-pass-budget PR.

## Duplicate admission

6135 is a different topic; this card is the R825 reinforce-later for the fix-pass budget PR
