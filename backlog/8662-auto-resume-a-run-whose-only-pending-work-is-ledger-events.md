---
bornAs: xe208qx
kind: task
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/run-ledger-resume.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Auto-resume a run whose only pending work is ledger events

A run with only ledger-events pending should resume automatically. Source: build-queue 22:45 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `auto resumes ledger-only pending work` in `we:scripts/operations/__tests__/run-ledger-resume.test.mjs`: Persist a run with only ledger events pending; assert resume occurs automatically.
- [A2] **Executable** — Planned `retains hold for any non-ledger pending work` in `we:scripts/operations/__tests__/run-ledger-resume.test.mjs`: Parameterize non-ledger pending work alone and mixed with ledger events; assert both retain the hold and launch no resumed work.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No automatic bypass of other pending work.

## Edge cases this change must handle

1. **Untrusted text** — Ledger payloads remain data.
2. **Truncated reads** — An incomplete pending-work read cannot authorize resume.
3. **Shared state files** — Avoid duplicate resume when ledger state is shared.
4. **Fail closed** — Unreadable ledger state holds resume with a visible reason.
5. **Identity scoping** — Resume only the matching run.
6. **State over time** — Cover repeated ticks and restart without duplicate work.
7. **Who wrote it** — Only recorded run state establishes pending work.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
