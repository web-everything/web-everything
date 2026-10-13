---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/github-app-identity.test.mjs", "we:scripts/lint-host-paths.mjs", "we:scripts/__tests__/lint-host-paths.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add an auth-env test with a named key and a missing file, asserting the loud fallback record. A r… (from web-everything/web-everything#5193 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/github-app-identity.test.mjs:139` — Add an auth-env test with a named key and a missing file, asserting the loud fallback record. A review lens that asks 'is each prose guarantee defended through the production caller, not just the CLI?' would also catch this class.
2. `we:scripts/lint-host-paths.mjs:43` — Add a deterministic CI comparison against the base revision that rejects new baseline entries and increased counts, with a regression test where both the document count and its baseline allowance increase together.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5193@9c72024172156f0f8b1b1c0c3f94b44d1031bdd3

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
