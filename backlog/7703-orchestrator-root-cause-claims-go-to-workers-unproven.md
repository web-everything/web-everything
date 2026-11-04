---
bornAs: x785s31
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Orchestrator root-cause claims go to workers unproven

MED priority hint. ## (held 2026-10-25 coroner night) Orchestrator root-cause claims go to workers unproven Three orchestrator diagnoses were later proven wrong (the reused process ID, the command path form, and "#5912 is a loop" when it was waiting on one test shard). Each wrong guess cost a worker round. Fix: a worker brief that names a cause must carry the check that shows it (command and output) or label it "hypothesis"; the worker's first step is to confirm or refute it. A hook or the worker-brief skill can require the field. Evidence: coroner assistant section 2026-10-25 (17:30, 18:00, 20:19 ET). Scope: we:skills-src/worker-brief, brief lint. Size 2.

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
