---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/coroner-executors.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Codex tool-error rate rose to 22.6% (883 of 8762 commands) from 13.0% the night before, on 214 tasks and 480 M

MED priority hint. 386. (coroner-1029, held) Codex tool-error rate rose to 22.6% (883 of 8762 commands) from 13.0% the night before, on 214 tasks and 480 M tokens. Retries are the main Codex cost, and today's known causes (EACCES on a shared /tmp, Forge-only test failures) are only part of it.     Fix idea: the extractor groups Codex tool errors by command class and first error line, and the nightly report lists the top 3 classes with a count; the top class gets a product fix (not a brief note).     Evidence: coroner-extract executors.codex 2026-10-29 window. Scope: we:scripts/operations/coroner-executors.mjs. Size 3.

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
