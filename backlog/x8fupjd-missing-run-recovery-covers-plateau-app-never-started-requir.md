---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/"]
dateOpened: "2026-10-08"
tags: []
---

# Missing-run recovery covers plateau-app: never-started required checks get re-triggered, not read as failures

plateauapp/plateau-app PRs whose required test and e2e never start sit forever (#217). Extend ci-red-recovery-watch missing-run to plateau-app (repo list, required-check source, per-org gh shim) and make review hydration treat never-started required checks as owed a re-trigger, not check-read-failed.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
