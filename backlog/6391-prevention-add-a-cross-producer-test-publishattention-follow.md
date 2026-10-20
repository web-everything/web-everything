---
bornAs: xai0274
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a cross-producer test: publishAttention followed by runOnce over a needsPerson report must em… (from web-everything/web-everything#5463 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/needs-you-feed.mjs:66` — Add a cross-producer test: publishAttention followed by runOnce over a needsPerson report must emit no CLEARED line. Alternatively, drop head from the key for at-round-limit events.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1458` — Gate the repeat-plan routing on planned.repairKind !== 'ci-heal'. Add a dispatchFix test with repairKind 'ci-heal' and a repeated-finding history that asserts the ordinary executor choice.
3. `we:scripts/operations/fix-run.mjs:774` — Filter scope entries to the lane's own repo prefix before stripping it, and add a unit test for multi-repo scope strings.
4. `we:scripts/operations/__tests__/fix-run.test.mjs:1547` — Add a runFixCli integration test for the reset and stand-down branches, and a lint rule that requires a test per new launcher branch.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5463@bce3433575f2af6150a7b1bd3684470776d2930c

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
