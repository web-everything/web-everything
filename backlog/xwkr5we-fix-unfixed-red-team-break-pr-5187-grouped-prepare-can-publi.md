---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/probation-build-run.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Fix unfixed red-team break (PR 5187): grouped prepare can publish edits outside its card-only scope

Operator 2026-10-17: Ok. Real confirmed red-team break (broken, security) never fixed on PR 5187, which merged 2026-10-15. we:scripts/operations/probation-build-run.mjs:518 - A grouped prepare can publish edits outside its card-only scope by declining the unchanged lead. Scenario: dispatch prepare for lead #7101 with members #7102 and #7103, leasing only their backlog cards; the worker leaves the lead unchanged, edits an unrelated file, and returns could-not-prepare; line 518 treats the unchanged lead as no worker change despite the unrelated diff; the blocked-report branch breaks before the scope, envelope and checker guards; members are restored but the unrelated edit survives and couldNotPrepare skips the final scope guard; with a green gate the runner commits that file. Confirmed by the Claude re-check. Source: red-team-analysis quality sample (20 breaks: 3 real never fixed).

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
