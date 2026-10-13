---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ledger-promotion-readiness.mjs", "we:scripts/lib/drain-ledger-shadow.mjs", "we:scripts/lib/__tests__/ledger-promotion-readiness.test.mjs", "we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a maxTransientPct or transient readiness check (setting plus test) so transients must be boun… (from web-everything/web-everything#5174 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ledger-promotion-readiness.mjs:78` — Add a `maxTransientPct` or `transient` readiness check (setting plus test) so transients must be bounded, or count them in the denominator once the drain writes releases.
2. `we:scripts/lib/drain-ledger-shadow.mjs:219` — Move the history scan into a terminable worker or subprocess and add a deterministic integration test asserting that a stalled readiness worker returns a timeout within the configured deadline.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5174@56e0064f5394df4e40d744eee584f27bb9a78a47

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
