---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs", "we:scripts/lib/restack-equivalence.mjs", "we:scripts/lib/__tests__/ruling-ledger.test.mjs", "we:scripts/lib/__tests__/restack-equivalence.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add one integration test that calls ignoredRulings without an injected restackOf, against a real… (from web-everything/web-everything#4921 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ruling-ledger.mjs:180` — Add one integration test that calls `ignoredRulings` without an injected `restackOf`, against a real temp git repo, and asserts that a restack-only head returns null. A lint rule against file-wide `vi.mock` of a module that is also the default dependency would catch the same pattern.
2. `we:scripts/lib/restack-equivalence.mjs:58` — Add a test fixture in we:restack-equivalence.test.mjs with a non-base side-branch merge. Longer term, pass the expected base SHA from reconcile (the PR's baseRefOid) and require the tip merge's second parent to be an ancestor of it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4921@61e71849e86771b8fcde989b1f9fed6df643f4aa

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
