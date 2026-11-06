---
bornAs: xg29lbb
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# A workflow-file change is merged by break-glass without ever running on a branch

HIGH priority hint. 388. (coroner-1029, held) A workflow-file change is merged by break-glass without ever running on a branch. #6064 (Forge CI) put the runner context in job-level env and broke all CI at start-up; #6067 undid it; operator at 16:28 ET: "surprised we didn't do a test run before merging". The actionlint card (HIGH, 10-29) catches invalid expression context only, not registration (ghost workflow), permissions or shared-/tmp failures.     Fix idea: a PR that touches we:.github/workflows/ gets an automatic workflow_dispatch of the changed workflow on the PR head (or a scratch branch) and the result becomes a required check before break-glass is offered; this is the "careful tests outside main" of R227.     Evidence: #6064, #6067, #6074; R225-R227. Scope: we:scripts/ci, we:.github/workflows. Size 4.

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
