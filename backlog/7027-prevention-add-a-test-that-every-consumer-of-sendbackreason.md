---
bornAs: xy0elyx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/conveyor/draft-promotion-rule.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs", "we:scripts/conveyor/__tests__/draft-promotion-rule.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a test that every consumer of sendBackReason (enqueue, prestage, dequeueSendBacks, gate-apply… (from web-everything/web-everything#5877 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-queue-safety.mjs:31` — Add a test that every consumer of `sendBackReason` (enqueue, prestage, `dequeueSendBacks`, gate-apply) is exercised for each hold label. Alternatively, split an enqueue-only hold list from the dequeue list, so that widening one is a deliberate choice.
2. `we:scripts/lib/drain-queue-safety.mjs:31` — Add a check:standards rule or shared test that every merge-landing path (enqueue and direct) calls one common label-hold predicate. Alternatively, use a soak break that replays a blocked label through each strategy.
3. `we:scripts/conveyor/draft-promotion-rule.mjs:85` — Table-drive the draft-promotion label tests over all three red-team:* statuses so each has an explicit expected outcome.
4. `we:scripts/conveyor/draft-promotion-rule.mjs:85` — Add a parameterized regression gate covering both hold labels across promotion eligibility and enqueue admission; this guard needs a future backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5877@26640b06fe6ee2da0d0b4beb1b963fd893d498ac

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
