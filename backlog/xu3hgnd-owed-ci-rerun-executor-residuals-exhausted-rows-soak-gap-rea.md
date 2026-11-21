---
kind: task
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# owed-ci-rerun executor residuals: exhausted rows, soak gap, read timeouts, fallback

Residuals: a stale clone can scaffold a followup card on exhausted rows; the soak scenario passes with the old guard restored; per-read timeouts are not bounded by the remaining budget; exhausted-pass reads for green PRs; a failing ledger starves later PRs; log-unreadable fallback (we:scripts/conveyor/reconcile-pass.mjs:1033, we:scripts/conveyor/reconcile-pass.mjs:2159). Source: build-queue 03:13 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `executes owed rerun for exhausted rows on stale clone` in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: Use a stale real clone with an exhausted row; assert the owed rerun executes and the soak fails when the old guard is restored.
- [A2] **Executable** — Planned `bounds exhausted-row reads by remaining budget` in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: Supply more rows than the remaining read budget; assert reads never exceed that budget and deferred rows remain visible for a later pass.
- [A3] **Executable** — Planned `skips exhausted-pass reads for green PRs` in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: Supply a green PR; assert zero exhausted-pass reads.
- [A4] **Executable** — Planned `isolates ledger failure and reports unreadable log fallback` in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: Parameterize ledger-write failure and unreadable log; assert unrelated rows still progress and the unreadable case records its fallback reason without claiming successful log evidence.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unrelated rerun-policy expansion.

## Edge cases this change must handle

1. **Untrusted text** — Ledger and log text remain data.
2. **Truncated reads** — Unreadable logs take the explicit fallback without claiming success.
3. **Shared state files** — Do not duplicate exhausted-row followups from stale state.
4. **Fail closed** — Ledger/read failures stay visible and cannot authorize a rerun.
5. **Identity scoping** — Scope exhaustion and followups to the correct PR.
6. **State over time** — Test remaining-budget expiry and later PR progress after a ledger failure.
7. **Who wrote it** — Use current ledger evidence before creating followups.

## Duplicate admission

nd
