---
bornAs: x26on9m
kind: story
size: 1
status: active
scaffoldedBy: "fix-6795"
dateScaffolded: "2026-11-14"
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-14"
tags: []
related: ["6795"]
---

# drain-queue-safety: accept the ref-qualified CI workflow path (exact match rejects a valid run)

drain-queue-safety: accept the ref-qualified CI workflow path (exact match rejects a valid run). Context from the finding: same defect class as red-team round 2 on PR 6795 (lane-verify ciWorkflowPathKind).

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

## Duplicate admission

same defect class as red-team round 2 on PR 6795 (lane-verify ciWorkflowPathKind)
