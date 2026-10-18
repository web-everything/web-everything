---
bornAs: x9w3ufk
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5404 (head e1448174e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5404 (reviewed head `e1448174ea9568890a1557b13148dc4195707ceb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:1007` — (failing-input, degraded) An authoritative empty policy becomes an unnecessary CI recovery
   - Scenario: Start without a cache. Return [] from the rules endpoint and a classic branch body containing protected:true, protection.enabled:true, and required_status_checks:{contexts:[],checks:[]}. The former direct protection reader returned []. The real shared reader instead selects declared policy for WE, or fallback for an undeclared repo, without preserving classic:[]. This consumer consequently returns null. For a mergeable PR with an empty rollup, an overdue head and no previous attempts, the candidate builder and recovery planner now produce trigger-ci; previously [] produced no candidate. Read-o
   - Claude's re-check: Empty rules plus empty classic makes 'readRequiredStatusChecksDetailed' throw 'noRequiredChecks'. That selects declared or fallback, so 'source' is declared or fallback and 'defaultReadRequiredContexts' returns null where the old direct read returned []. The shown docstring says null falls back to the name-free 'no CI check at all' test, which fires on an empty rollup. The new test's 'live' with empty checks is unreachable, because 'getRequiredStatusChecks' never returns live with empty checks.

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
