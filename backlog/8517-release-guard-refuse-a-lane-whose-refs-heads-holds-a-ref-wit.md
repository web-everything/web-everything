---
bornAs: xsp5311
kind: story
size: 2
status: active
scaffoldedBy: "fix-6319"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-release-unpushed-guard.test.mjs"]
dateOpened: "2026-11-09"
tags: []
related: ["6319"]
---

# Release guard: refuse a lane whose refs/heads holds a ref with an invalid name

Release guard: refuse a lane whose refs/heads holds a ref with an invalid name. Context from the finding: PR 6319 self-review: for-each-ref and rev-list skip a badly named branch (bad..name) with only a warning, so its unpushed commit is not counted; pre-existing, not a regression.

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

PR 6319 self-review: for-each-ref and rev-list skip a badly named branch (bad..name) with only a warning, so its unpushed commit is not counted; pre-existing, not a regression
