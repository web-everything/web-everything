---
bornAs: xjfbl9j
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/operations/__tests__/red-team-gate-apply.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a drain test that asserts a bounded gh/GraphQL call count per N non-ready open rows, or cap t… (from web-everything/web-everything#5439 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-merge-strategy.mjs:268` — Add a drain test that asserts a bounded gh/GraphQL call count per N non-ready open rows, or cap the sweep to PRs that carry a queue-related signal.
2. `we:scripts/operations/red-team-gate-apply.mjs:163` — Add a gate test where io.dequeueSentBack throws and assert the SENT_BACK record is still written. Wrap the dequeue so its failure is logged and left to the drain backstop.
3. `we:scripts/lib/drain-queue-safety.mjs:33` — Add a parity test over a label and env matrix comparing postAcceptRedTeamOwed with redTeamOwedFor, or import the single source.
4. `we:scripts/operations/__tests__/red-team-gate-apply.test.mjs:326` — Assert on the number of dequeueSentBack invocations per path (first send-back versus already-acted retry) instead of on side-effect state inside the fake.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5439@6359fd1ad8405d14b7b1e5c1bba98ceeac894278

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
