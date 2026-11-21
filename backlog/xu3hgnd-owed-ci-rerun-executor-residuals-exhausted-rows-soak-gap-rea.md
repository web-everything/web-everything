---
kind: task
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# owed-ci-rerun executor residuals: exhausted rows, soak gap, read timeouts, fallback

Residuals: a stale clone can scaffold a followup card on exhausted rows; the soak scenario passes with the old guard restored; per-read timeouts are not bounded by the remaining budget; exhausted-pass reads for green PRs; a failing ledger starves later PRs; log-unreadable fallback (we:scripts/conveyor/reconcile-pass.mjs:1033, we:scripts/conveyor/reconcile-pass.mjs:2159). Source: build-queue 03:13 ET 2026-11-21.

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

## Duplicate admission

nd
