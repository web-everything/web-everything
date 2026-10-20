---
bornAs: x5t3otw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-context-pack.mjs", "we:scripts/conveyor/__tests__/fix-context-pack.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a test asserting that for every contextMaxBytes at or above a documented floor, the pack stil… (from web-everything/web-everything#5369 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-context-pack.mjs:221` — Add a test asserting that for every contextMaxBytes at or above a documented floor, the pack still contains the finding. Alternatively, clamp the effective budget at the floor, or move the long rule into the brief (we:fix-agent-brief.md already carries it) and keep the pack's tests section short.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5369@9efb3ce64110bd258edaecb0400d89fb743c77b8

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
