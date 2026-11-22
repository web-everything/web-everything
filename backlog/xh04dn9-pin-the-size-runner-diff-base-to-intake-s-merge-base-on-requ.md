---
kind: story
size: 2
status: active
scaffoldedBy: "fix-7313"
dateScaffolded: "2026-11-22"
scope: ["we:scripts/lib/pr-size-admission.mjs", "we:scripts/lib/review-loop/round-end-gates.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Pin the size-runner diff base to intake's merge-base on requested splits

Review intake measures merge-base..head from pr.baseRefSha or the local origin tracking ref; the size runner re-resolves the base from baseRefName and diffs base...head with binary recovery. A requested split sends the head sha but not intake's baseSha, so a stale or different local base ref can give the runner different evidence; zero counted lines then returns ok without cardPublished and reconcile aborts the effects child. Carry intake's merge-base into the split request and have the runner diff that exact base (or refuse a mismatch as unknown). Found by the self-review on PR 7313.

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
