---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5404 (head 80df15a5c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5404 (reviewed head `80df15a5c183685014ee759635069d3ed9f75d04`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:1007` — (failing-input, degraded) An authoritative empty required-check set now triggers missing-run recovery.
   - Scenario: Return [] from the rules endpoint and {protected:true,protection:{enabled:true,required_status_checks:null}} from the branch endpoint. For an undeclared repo with no cache, the real shared reader returns {checks:[],source:'fallback'}, and defaultReadRequiredContexts converts this to null. A mergeable PR with an empty rollup, an overdue head and no previous attempts consequently receives a trigger-ci dispatch. The read-only probe reproduced that dispatch; passing the previous reader's authoritative [] produced no candidates. Preserve the successfully observed empty policy so recovery does nothi
   - Claude's re-check: The old reader returned [] for a null required_status_checks. The new one maps declared/fallback/unavailable to null, and an authoritative empty set can only come back as one of those. Live saves require a non-empty set, so the '[]' preservation in the new tests is unreachable through the real reader. Null drops to the name-free no-CI-check test, which can dispatch for an empty rollup where the old [] did nothing.

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
