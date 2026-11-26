---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a deterministic CI test exercising the actual lock implementation with a proven-dead owner, a… (from web-everything/web-everything#7514 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/promote-draft-pr-dispatch.mjs:192` — Add a deterministic CI test exercising the actual lock implementation with a proven-dead owner, alongside live-owner and unknown-owner refusal controls.
2. `we:scripts/operations/promote-draft-pr-dispatch.mjs:533` — Add a two-tick assertion to the receipt-author test that `postComment` is called once and no further receipts appear. Longer term, have the executor treat an untrusted readback as a sticky hold.
3. `we:scripts/operations/promote-draft-pr-dispatch.mjs:505` — In the same test, assert the post-rearm label set still contains the injected `red-team:*` label, or record that the writer removes it and that merge-gate re-derives it. This is a reinforce-later card.
4. `we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs:887` — Extend the crash test to call `run()` a second time with the recorded receipt in the thread and assert that the post and rearm counts stay at 1.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7514@26769910f46a202dcccf11769567fc480d330727

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
