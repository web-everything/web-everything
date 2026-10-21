---
bornAs: x3ziifp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/operator-controls-io.mjs", "we:scripts/operations/__tests__/operator-controls-io.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a unit test for retry-prepare with a ledger of {} and a live prepare hold. Better, share one… (from web-everything/web-everything#5169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/operator-controls-io.mjs:143` — Add a unit test for retry-prepare with a ledger of `{}` and a live prepare hold. Better, share one ledger-normalising helper between the reader and the apply path.
2. `we:scripts/operations/operator-controls-io.mjs:166` — Have the sink compare the `gh api user` login (or the credential that will post) with the claimed actor before any mutation, as extend-rounds-io does. Add a test that a mismatched credential is refused for each op. Longer term, land the unforgeable-actor fix tracked in #2946.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5169@2d68944e3d9a0b61154124fdf560cfdb6f62e517

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
