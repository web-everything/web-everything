---
bornAs: xltj53i
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a test where gh pr comment throws after a confirmed dequeue and assert the comment is retried… (from web-everything/web-everything#5439 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-queue-safety.mjs:118` — Add a test where `gh pr comment` throws after a confirmed dequeue and assert the comment is retried. Alternatively, catch and log the comment failure so the dequeue result is never reported as failed.
2. `we:scripts/lib/drain-merge-strategy.mjs:341` — Prune redTeamPending entries for PRs that are no longer open candidates, or cap the map the way followedUp is capped. Add a test that a closed PR's entry is dropped.
3. `we:scripts/lib/drain-merge-strategy.mjs:356` — Add a strategy-level test that replays a `running` status with a dead pid past `redTeamPendingMaxMin` and asserts the intended outcome. Optionally have the evidence reader return a distinct `crashed` flag so the policy is explicit.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5439@d3be41a84e65877dc6ca203ddcee9af727c6a3d8

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
