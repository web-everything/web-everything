---
kind: task
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:.claude/skills/coroner"]
dateOpened: "2026-10-25"
tags: []
---

# Coroner: coroner skill fixes cursor order and retires dead probe handles

2026-10-23 coroner: the skill runs the false-findings pass after the extractor has moved the cursor, so --since=last returns an empty window (seen with coroner-false-findings returning 0 events; likely related to the nightly probe failing on 10-17). Fix idea: both scripts read the cursor and only the last step writes it, via one coroner-run wrapper that fixes the window once. Also the coroner probe re-reports long-dead coroner job handles (10-15..10-17) as a fresh coroner-failed needs-you every night: retire a handle once reported and attempts are exhausted, and capture why we:scripts/operations/coroner-false-findings.mjs failed on 10-17.

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
