---
bornAs: xwasq40
kind: story
size: 2
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/open-pr.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Worker steps are skipped silently and nothing counts them

MED priority hint. - (coroner 2026-10-26, held) Worker steps are skipped silently and nothing counts them. Several builders and close-out workers skipped converge and the Codex weakening audit (6622/#5958, #5936 and #5964 close-outs, #5973) and the review daemon was assumed to cover it. Fix idea: the PR open step records which steps ran (converge, audit, scoped tests) in the worker result, and coroner-extract reports a skipped-step count per PR. Evidence: handoff entries 10-26 00:00, 01:41, 04:11 ET. Scope: we:scripts/operations/coroner-extract.mjs, we:scripts/open-pr.mjs. Size 3.

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
