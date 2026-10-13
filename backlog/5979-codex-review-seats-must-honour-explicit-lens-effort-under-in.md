---
bornAs: x3mdu9q
kind: story
size: 1
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-10-12"
tags: []
---

# Codex review seats must honour explicit lens effort under inherited provider routing

From the PR #5068 post-accept red team (confirmed, degraded; operator approved #5068 with this as a follow-up, 2026-10-12): we:scripts/operations/review-dispatch.mjs:259 — Codex review seats silently discard an explicit per-lens effort setting when provider routing is inherited, so those seats run at the default effort. Apply the lens effort on top of the inherited route (validated against the model's supported levels) and log it; add a test.

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
