---
bornAs: xiatkbm
kind: task
status: open
scope: ["we:scripts/operations/judge-sweep-facts.mjs", "we:scripts/operations/judge-sweep-facts-io.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# judge-sweep-facts returns evidence for every PR (comment-read budget and paging)

2026-10-25 00:00 ET: judge-sweep-facts returns 'evidence-unavailable' for about 8-16 PRs every sweep (verdict or comment reads fail, possibly a comment-read budget), so sweeps leave PRs unjudged. Fix the bundle (budget/paging) so every PR gets evidence.

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
