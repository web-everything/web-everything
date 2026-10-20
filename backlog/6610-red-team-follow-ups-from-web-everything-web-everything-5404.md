---
bornAs: xqdbohs
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5404 (head 21c7bd69a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5404 (reviewed head `21c7bd69a07ed5fc9d0809b3508e9fbf1021836c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:1006` — (failing-input, degraded) A successfully read empty policy triggers unnecessary CI recovery.
   - Scenario: With no cache, rules return [] and the branch returns {protected:true,protection:{enabled:true,required_status_checks:null}}. For example/no-required, the real shared reader returns {checks:[],source:'fallback'}, and defaultReadRequiredContexts converts this to null. Executing the production candidate builder and recovery planner for an overdue, mergeable PR with an empty rollup produces a trigger-ci dispatch. The previous reader returned [] for this successful empty protection response, producing no dispatch. Preserve authoritative emptiness through the shared reader so a repository requiring
   - Claude's re-check: A truly empty policy makes readRequiredStatusChecksDetailed throw noRequiredChecks. With no declared policy and no cache, getRequiredStatusChecks returns {checks:[],source:'fallback'}, and the new defaultReadRequiredContexts maps 'fallback' to null. The old reader returned [] for this case. null sends buildMissingRunCandidates to its name-free 'no CI check' test, so an overdue mergeable PR with an empty rollup gets a recovery dispatch. The test that preserves [] uses source 'live' with empty checks, which the real reader never produces.

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
