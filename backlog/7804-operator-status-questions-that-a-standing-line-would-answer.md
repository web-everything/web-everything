---
bornAs: xhn23pu
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Operator status questions that a standing line would answer

MED priority hint. 392. (coroner-1030, held, MED) Operator status questions that a standing line would answer: about 14 "Progress?" / "How is forge doing" / "Is the drain working" / "is ci green" turns on 10-30, plus an explicit "Give me Forge updates every 10 minutes" (07:59 ET). Repeat of the 10-29 finding (f); still not carded, so it recurs.     Fix idea: a script-written status line (Forge slots busy and telemetry, drain alive, main CI state, merge queue depth, heavy queue) refreshed by a daemon on the event feed and the wip page, with no model turn; the orchestrator answers "Progress?" by quoting it.     Evidence: operator turns 07:11, 07:47, 07:59, 09:08, 11:11, 14:26, 15:11, 16:20, 16:50, 17:56 ET on 10-30. Scope: we:scripts/operations (wip, event feed). Size 3.

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
