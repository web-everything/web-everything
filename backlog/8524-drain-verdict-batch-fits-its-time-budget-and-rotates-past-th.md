---
bornAs: xu2yj2h
kind: story
size: 3
status: active
scaffoldedBy: "fix-6595"
dateScaffolded: "2026-11-10"
scope: ["we:scripts/drain-classify-only.mjs", "we:.github/workflows/drain-verdict.yml"]
dateOpened: "2026-11-10"
tags: []
related: ["6595"]
---

# drain-verdict batch fits its time budget and rotates past the first 10 labelled PRs

drain-classify-only --batch classifies up to 10 PRs, each child allowed 10 min, inside a 30-min job on a 10-min cron, so a full batch cannot finish. The fixed slice(0,10) means labelled PRs past the first 10 never get a verdict. Bound the batch by remaining job time and rotate or prioritise the slice; test an oversized batch.

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

found by the PR 6595 fix self-review
