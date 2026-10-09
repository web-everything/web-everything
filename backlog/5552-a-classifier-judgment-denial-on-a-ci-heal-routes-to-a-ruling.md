---
bornAs: xt3m1fw
kind: story
size: 3
status: open
scope: ["we:scripts/operations/completion-cli.mjs", "we:scripts/operations/worker-result-router.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# A classifier judgment denial on a ci-heal routes to a ruling at once, never a slow retry

PR #4502 burned 3 ci-heal sessions (02:28Z, 03:11Z, 03:47Z) on head 5965af3: each was denied by the auto-mode classifier as 'Security Test Removal' when flipping we:scripts/conveyor/__tests__/review-hold-ledger-shadow.test.mjs 'raw finding key never closes the hashed referral (ruling-key-unhashed)' to expect agree:true (a semantic conflict between the PR's raw-key compat in deriveReferrals and main's slice-H shadow #4495). The completion record maps this to permission-wall, retryable:true, alsoSlowRetry, and the note asks for an 'allow rule' - wrong for a classifier judgment denial: no allow rule should be added and a retry hits the same wall; only fix-loop-hold stopped it. Fix: we:scripts/operations/completion-cli.mjs takes --denied-reason; we:scripts/operations/worker-result-router.mjs classes a classifier judgment denial (reason present, e.g. Security Test Removal) as needs-ruling (retryable:false); we:scripts/conveyor/reconcile-core.mjs caps such a streak at 1 and surfaces a ruling note naming the denied assertion change. Setting to disable; fixture replaying #4502's record. Proof: replay #4502's three records -> one session then needs-ruling, not three.

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
