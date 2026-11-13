---
kind: story
size: 1
status: open
dateOpened: "2026-11-13"
tags: []
related: ["6745"]
---

# forge-exec-run: test that the three-command maximum forced termination is defended by a named command-count test

Judge advisory on PR 6745 (we:scripts/readiness/forge-exec-run.mjs:750): the three-command maximum underlying forced termination has no named test defending the actual command count. Add a named test in we:scripts/readiness/__tests__/forge-exec-run-reap.test.mjs that asserts the count. Not a regression vs main (R903).

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

#6745 judge advisory finding, carded under R903

capability-search found no existing card for this command-count test
