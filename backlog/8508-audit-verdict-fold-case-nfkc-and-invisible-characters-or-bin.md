---
bornAs: xonjsh5
kind: story
size: 3
status: active
scaffoldedBy: "fix-6381"
dateScaffolded: "2026-11-05"
scope: ["we:scripts/operations/audit-verdict.mjs", "we:scripts/operations/__tests__/audit-verdict.test.mjs"]
dateOpened: "2026-11-05"
tags: []
---

# Audit verdict: fold case, NFKC and invisible characters (or bind to the diff's path list) before matching a reported finding path against guard and race globs

Found by the PR #6381 fixer's self-review. computeVerdict in we:scripts/operations/audit-verdict.mjs compares the model-reported finding file case-sensitively and without NFKC or invisible-character folding. So a reported merge-queue path spelled with a capital M misses the glob for merge files, and an E2 ships. On a case-insensitive checkout that is the same file. A fullwidth letter gets through the same way. Fix: bind the reported file to the diff's changed paths, or fold both sides the same way the audit-settings foldKey does, failing closed when they differ.

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
