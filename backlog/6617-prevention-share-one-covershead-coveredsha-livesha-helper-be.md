---
bornAs: xrm2mar
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-ledger-facts.mjs", "we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs", "we:scripts/lib/__tests__/drain-ledger-facts.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Share one coversHead(coveredSha, liveSha) helper between drain-ledger-facts, pr-state and pr-merg… (from web-everything/web-everything#5195 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-ledger-facts.mjs:47` — Share one `coversHead(coveredSha, liveSha)` helper between drain-ledger-facts, pr-state and pr-merge-gate, and add a table test that runs both on the same abbreviated, equal and different-sha inputs.
2. `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs:441` — Gate on the net diff against current main: a PR that deletes an existing handler in a shared test helper must name that in its description. Add a check that lists files in the net set unrelated to the declared goal.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5195@e78c2001470d30be1f154d8abbb27f9418443883

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
