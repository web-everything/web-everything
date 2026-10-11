---
bornAs: xl45qo0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add to card 5796: the reader must require a live enqueue entry or a recent stamp timestamp. Al… (from web-everything/web-everything#4717 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-merge-strategy.mjs:196` — Add to card 5796: the reader must require a live enqueue entry or a recent stamp timestamp. Alternatively, stamp only after a successful enqueue and add a test that a failed enqueue leaves no trusted marker. Pin it in we:drain-merge-strategy.test.mjs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4717@a90273dcdc861c90f0130d50cea790db0925b0a8

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
