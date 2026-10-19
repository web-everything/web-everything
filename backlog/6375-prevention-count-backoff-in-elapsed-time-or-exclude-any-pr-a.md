---
bornAs: xcmm1za
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Count backoff in elapsed time, or exclude any PR attempted this round from the busy check. Add a… (from web-everything/web-everything#5316 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:660` — Count backoff in elapsed time, or exclude any PR attempted this round from the busy check. Add a scheduler test that pairs the busy interval with a PR that is skipped each round.
2. `we:scripts/merge-ai-prs.mjs:2459` — Add a planner-level test matrix over RECONCILE on/off crossed with numeric and hash blockers. Have the production proof builder also look up numeric ids on main.
3. `we:scripts/lib/enqueue-on-event.mjs:455` — Add a lint or standards rule that flags string accumulation from a child stream (`+= d` on a `child.stderr` or `child.stdout` data handler) without a cap. Alternatively, add a test that pushes several MB of stderr through `runChild` and asserts the retained buffer stays under a bound.
4. `we:scripts/lib/enqueue-on-event.mjs:652` — Add a deterministic deferred-read regression test and check stopped immediately before spawning for both event and catch-up work.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5316@5c4219a70694993bdd0983713dce9e087bae6ffe

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
