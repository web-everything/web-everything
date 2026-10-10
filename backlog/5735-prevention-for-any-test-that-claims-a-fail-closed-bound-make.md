---
bornAs: xac603i
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/merge-queue-affected.test.mjs", "we:scripts/lib/merge-queue-hook.mjs", "we:scripts/lib/__tests__/merge-queue-hook.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — For any test that claims a fail-closed bound, make the budget an injectable parameter and assert… (from web-everything/web-everything#4689 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/merge-queue-affected.test.mjs:302` — For any test that claims a fail-closed bound, make the budget an injectable parameter and assert the verdict differs between a tiny and a huge budget on the same fixture.
2. `we:scripts/lib/merge-queue-hook.mjs:284` — Anchor the classifier on the parenthesised reason list and the action suffix, not substrings of the whole tail. Alternatively sanitise paths (strip control characters and `: `) when building `affected:` reasons. Add a classifier test using a hostile path. The classifier is not wired, so wire-time is the cheapest point to do this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4689@6e0d241dfe006057a98d5d3fd675253c2397c1a9

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
