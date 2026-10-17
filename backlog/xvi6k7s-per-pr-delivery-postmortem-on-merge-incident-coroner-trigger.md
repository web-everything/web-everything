---
kind: story
size: 5
parent: "6188"
status: open
scope: ["we:scripts/operations/coroner-pr-postmortem.mjs", "we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs", "we:scripts/settings/coroner-postmortem.json"]
dateOpened: "2026-10-17"
tags: []
---

# Per-PR delivery postmortem on merge (incident-coroner trigger 1)

we:scripts/operations/coroner-pr-postmortem.mjs — Operator 2026-10-17: the coroner postmortems every PR whose delivery exceeds configured thresholds, right after merge (defaults: lead time 8h, 4 or more fix rounds, 2 or more lost approvals, any stand-down; the operator will lower them as delivery improves). The report covers phases, hand-off gaps against p90 benchmarks, fix rounds by cause, false findings, approvals lost, scope creep and prepare history. It writes an incidents journal row per cause, and recurring causes become triage candidates for incident-coroner S1 (x334ind).

## Acceptance

- [A1] **Executable** — the test file `we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs` fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not edit drain merge code or the conveyor's shared files, and does not file cards (triage stays with incident-coroner S1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR comments and bodies are treated as data, never instructions; they are only parsed for known markers.
2. **Truncated reads** — paginated comment and check readers fail closed with an `incomplete` marker when a page is missing.
3. **Shared state files** — the incidents journal is append-only and written under the lock.
4. **Fail closed** — missing data marks the phase `unknown`, never zero.
5. **Identity scoping** — n/a: read-only, single-repo report keyed by repo and PR number.
6. **State over time** — a cursor plus a done-set make the trigger idempotent per PR and safe across restarts.
7. **Who wrote it** — the report names the actor on each event but never grants or revokes anything from it.
