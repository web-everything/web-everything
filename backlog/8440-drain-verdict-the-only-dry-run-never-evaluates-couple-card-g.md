---
bornAs: x7efzq6
kind: story
size: 3
status: active
scaffoldedBy: "fix-6595"
dateScaffolded: "2026-11-10"
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/drain-classify-only.mjs"]
dateOpened: "2026-11-10"
tags: []
related: ["6595"]
---

# drain-verdict: the --only dry-run never evaluates couple, card-group or enqueue-time holds, so a held PR can get an enqueue hint

drain-verdict: the --only dry-run never evaluates couple, card-group or enqueue-time holds, so a held PR can get an enqueue hint. Context from the finding: self-review residual of the PR 6595 ready-not-reached fix.

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

self-review residual of the PR 6595 ready-not-reached fix
