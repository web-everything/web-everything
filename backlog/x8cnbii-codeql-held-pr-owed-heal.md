---
kind: story
size: 5
status: open
scope: ["["we:scripts/conveyor/reconcile-core.mjs"", ""we:scripts/conveyor/reconcile-pass.mjs"", ""we:scripts/lib/codeql-gate.mjs"", ""we:scripts/operations/ci-heal-pr-dispatch.mjs"", ""we:scripts/merge-ai-prs.mjs"]"]
dateOpened: "2026-10-07"
tags: []
---

# Fix daemon owns a PR the drain holds for a failed CodeQL check

When the drain refuses to land a PR for a failed CodeQL check (drainBlocksOnCodeQL), nobody owned the repair (live: PR 4370, a high-severity alert). The reconcile plan now owes that PR a ci-heal whose brief names the alert (rule, file, line, message from the check-run annotations), bounded by the ci-heal cap, with the reason logged.

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
