---
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/red-main-remediation.mjs", "we:scripts/merge-gate-check.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# merge-gate: publish the red-main freeze marker to a shared source CI can read

The required merge-gate CI check (we:scripts/merge-gate-check.mjs, strategy github-merge-queue) FAILS CLOSED on the red-main-freeze gate because the freeze marker (we:.conveyor/red-main-freeze.json, written by freezeDispatch/unfreezeDispatch in we:scripts/readiness/red-main-remediation.mjs) lives only on the drain host. Publish every freeze/unfreeze to a shared ops/* git branch (same transport as ops/review-requests), make we:scripts/merge-gate-check.mjs read it (facts.redMain = {source, frozen, reason}), and keep fail-closed on an unreadable branch. Blocked on #4624 (red-main hold, review:changes/human) which edits we:scripts/readiness/red-main-remediation.mjs. Until this lands every PR's merge-gate is red, so the operator must not require merge-gate yet.

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
