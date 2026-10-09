---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-policy.mjs", "we:scripts/lib/build-queue.mjs", "we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs", "we:scripts/lib/__tests__/build-queue.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Make the key per-row, not pairwise: sort by (priority, hasClass ? 0 : (pinned ? 0 : 1), i), or pa… (from web-everything/web-everything#4657 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-policy.mjs:379` — Make the key per-row, not pairwise: sort by (priority, hasClass ? 0 : (pinned ? 0 : 1), i), or partition into classed and unclassed first. Add a property or permutation test that sorting is order-independent.
2. `we:scripts/lib/build-queue.mjs:285` — Make requestsFirstInClass a required argument of classOrder and formatBuildQueuePriorityShadowLine, or have them read it from the detailed rows or settings. Add a CLI test for shadow with requests-first off.
3. `we:scripts/lib/build-queue.mjs:217` — Add a provenance rule: an escalating override (`now`, `urgent`) is honoured only when the card's priority is attested by the Plateau/operator write path (a signed or sidecar-recorded field, or an actor check). Enforce it in a `check:standards` or write-gate rule that rejects `priority: now` in a card PR not authored by the operator actor. File it as a backlog item.
4. `we:scripts/conveyor/build-dispatch-policy.mjs:380` — Add a deterministic comparator-law regression covering transitivity across classified/unclassified and pinned/unpinned rows, then use a consistent queue-wide fallback policy or total ordering.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4657@8677573b1e81dd3705266bc8b032780a5c8065b9

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
