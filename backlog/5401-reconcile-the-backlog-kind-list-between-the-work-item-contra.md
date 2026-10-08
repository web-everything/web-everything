---
bornAs: x1qlf66
kind: story
size: 1
parent: "5407"
status: open
scope: ["we:contracts/backlog.ts", "we:scripts/check-standards-rules.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-08"
tags: []
---

# Reconcile the backlog kind list between the work-item contract, the gate and the workflow doc

Source: AI Delivery Landscape research brief, 2026-10-08, section 'What you already have' (work item row: 'kind list drifts between code and docs'). Verified 2026-10-08: the Kind type in we:contracts/backlog.ts is program|epic|story|task|decision; BACKLOG_KINDS in we:scripts/check-standards-rules.mjs is story|epic|task|decision|feature|investigation; we:docs/agent/backlog-workflow.md matches the gate. The work-item contract is the first candidate for the delivery standard's Work Item protocol, so it must state the real kind set. Make one source of truth and have the others derive from it or be checked against it.

## Done when

1. **Executable** — a unit test (or check:standards rule) that asserts the contract's Kind values equal BACKLOG_KINDS fails today (program vs feature/investigation) and passes after.
2. we:docs/agent/backlog-workflow.md lists the same kinds, or points at the single source.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: compares two constant lists in repo code.
2. **Truncated reads** — n/a: no file is read at runtime beyond module imports.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — a mismatch fails the test; it never silently passes.
5. **Identity scoping** — n/a: no actors.
6. **State over time** — existing cards using `program` (if any) must still validate; check the backlog before dropping it.
7. **Who wrote it** — n/a: no authored input.
