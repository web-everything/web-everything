---
bornAs: xgexyhj
kind: story
size: 2
status: active
scaffoldedBy: "fix-4825"
dateScaffolded: "2026-10-11"
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# reconcile-core rebase-cap read should pass main state so it agrees with the ci-red sweep after main goes green

PR #4825 round 4: reconcile-core's rebaseCapExhausted calls countRebaseOntoMainComments with no options, so it never applies the green-sha reset the sweep applies. After main goes green on a new sha, reconcile reads the cap as spent (plans a ci-heal) while the sweep refunds red-era/stale markers and rebases. Not a stall (the ci-heal claim makes the sweep defer), but the two disagree. Fix: pass mainRedWindows and a mainGreen (currentMainGreen of main's runs) into the counter.

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
