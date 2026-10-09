---
kind: story
size: 2
status: open
blockedBy: ["xx7ckd6"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/red-main-remediation.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# drain: red-main freeze reader prefers the shared ops branch copy

Follow-up to xyd06qo. The freeze is now published to the shared ops/red-main-freeze branch (mergeDelivery.redMainFreezeBranch) by we:scripts/readiness/red-main-remediation.mjs freeze/unfreeze, and CI's merge-gate reads it; the drain's own reader (isDispatchFrozen/readFreeze in we:scripts/merge-ai-prs.mjs) still reads only the local marker. Make the drain prefer the shared copy (readSharedFreeze in we:scripts/lib/red-main-freeze-shared.mjs), falling back to the local marker, and treat frozen-in-either as frozen (never fail open). Blocked on PR #4624 (card xx7ckd6), which holds both files and moves the local marker to the coordination root.

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
