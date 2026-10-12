---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Split the reconcile core into one module per planReconcile rule (pure move)

Held finding 238 (2026-10-11; operator: start only after open PRs have cleaned). we:scripts/conveyor/reconcile-core.mjs is 2,922 lines, 123 commits/30d, 8 open PRs touched it (#4757 #4770 #4779 #4797 #4880 #4912 #4914 #4916). Hotspot: planReconcile (~1,350 lines); every fixer/review rule edits it. Plan: pure move, no behavior change; one module per rule composed from an ordered list; session-health markers to their own file; freeze other edits to the file while it lands. Later: we:scripts/merge-ai-prs.mjs, we:scripts/conveyor/reconcile-pass.mjs, we:scripts/conveyor/reconcile-fix-dispatch.mjs. Not queued: operator gate (open PRs on the file first).

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
