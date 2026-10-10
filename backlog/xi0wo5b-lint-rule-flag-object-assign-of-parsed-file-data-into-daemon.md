---
kind: story
size: 3
parent: "4131"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/conveyor/health-watch.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Lint rule: flag Object.assign of parsed-file data into daemon tick state

Review of PR 4691 (the health-daemon gh-probe job) found a job result sidecar merged into the tick with Object.assign and no key allowlist, no sampledAt bound and no size cap. A check:standards rule that flags Object.assign(<state>, <data parsed from a file>) inside we:scripts/conveyor/ ticks would catch the general class before review. Prevention item owed by the advisory comment.

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
