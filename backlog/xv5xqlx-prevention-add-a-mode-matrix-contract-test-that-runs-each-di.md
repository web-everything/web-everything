---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/fix-executor-chain.mjs", "we:scripts/settings/fix-executor.json", "we:scripts/conveyor/soak/breaks/critical-fix-never-forces-claude.soak.test.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/lib/__tests__/fix-executor-chain.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a mode-matrix contract test that runs each dispatcher (fix, ci-heal, borrowed) under both dir… (from web-everything/web-everything#7384 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/fix-slot-borrow.mjs:123` — Add a mode-matrix contract test that runs each dispatcher (fix, ci-heal, borrowed) under both `direct` and `wrapped` and asserts which launcher runs and what the prompt says.
2. `we:scripts/lib/fix-slot-borrow.mjs:143` — Add a `createRoutedCiHealDispatch` test that asserts the claim meta `fixExecutor` (provider, rung, mode) after a Claude-path sink call. Longer term, a write-gate could require a named test for each recorded-field guarantee.
3. `we:scripts/lib/fix-executor-chain.mjs:130` — Land the consumer card first, or add a check:standards rule that fails on a producer-only stamped flag with no reader. Otherwise file the PRIORITY card as a blocking dependency.
4. `we:scripts/lib/fix-slot-borrow.mjs:96` — Add a check:standards rule or contract test asserting that every field stamped into `fixExecutor` claim meta has at least one non-test reader. Or land the consumer in the same PR as the flag.
5. `we:scripts/settings/fix-executor.json:4` — Add a unit test that asserts `resolveFixCriticalGlobs()` matches we:scripts/settings/fix-executor.json and the other settings readers it depends on. Sync the roster with the canonical critical-work roster, which is already carded.
6. `we:scripts/lib/fix-slot-borrow.mjs:93` — Have the formatter print `mode=unknown` when the decision lacks it, and add a test that a decision with no mode does not log `direct`.
7. `we:scripts/conveyor/soak/breaks/critical-fix-never-forces-claude.soak.test.mjs:7` — Add a deterministic acceptance gate requiring a named live-dispatch check and attached records asserting the actual provider, invocation mode, and absence of a Claude session.
8. `we:scripts/lib/fix-executor-chain.mjs:123` — Add a deterministic parameterized test asserting that unavailable terminal executors produce a capacity hold across critical takeover and send-back triggers, including legacy two-rung chains.
9. `(no file cited)` — Add a named live smoke check, 'critical-and-escalated-dispatch-use-direct-codex', that correlates daemon dispatch records with actual launched processes and asserts no Claude session; attach its evidence to the PR.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7384@82eb671e10dc2d86d33915eaf8480c6b008b5828

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
