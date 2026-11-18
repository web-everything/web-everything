---
bornAs: xs15akf
kind: task
status: open
scope: ["we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Red-team recovery should age a record from its original startedAt, not the status-file mtime

we:scripts/lib/review-red-team-on-skip.mjs lines 58-70 (planRedTeamRecovery) use the status-file mtime as record age. The stale-abandon rewrite resets the mtime, so a foreign-host dead owner waits the 2h deadline twice (PR #6744, 2026-11-13). Use the original record's startedAt or the redispatch marker binding. A tweak exists on lane/redteam-dead-owner-unfinished-review-m2 at 83007a271c (not loaded).

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

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
