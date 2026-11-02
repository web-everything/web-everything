---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# reconcile-dry-run smoke failure hides its real error

MED priority hint. ## (held 2026-10-25 23:37 ET) reconcile-dry-run smoke failure hides its real error The drain rebuild 03:36Z was smoke-rejected on reconcile-dry-run ("exited 1"), but the detail shows only the pr-snapshot info line, as in the review daemon at 22:51Z. The real error is swallowed, so nobody can tell a real defect from a load flake. Fix: smoke captures the failing command's stderr tail into the rejection detail; plus the re-smoke-on-load fix from #5942/#5952 belongs in the shared smoke used by every daemon.

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
