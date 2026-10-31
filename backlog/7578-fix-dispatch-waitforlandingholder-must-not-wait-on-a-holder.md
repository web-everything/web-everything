---
bornAs: xgpwf6v
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-scope-policy.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# fix-dispatch waitForLandingHolder must not wait on a holder that cannot land

Live 2026-10-31 16:20 ET: fix-dispatch waitForLandingHolder treats a holder with review:accepted + ready-to-merge as 'landing' even when it is red-team:blocked or judge NON-CONVERGING (holder #6056 since 04:00 ET), so dependent #6132 waits forever. Fix: exclude red-team:blocked and judge-non-converging holders from holderStates and emit a 'holder-cannot-land' event instead. Evidence: we fix-dispatch-daemon.log 20:14:59Z.

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
