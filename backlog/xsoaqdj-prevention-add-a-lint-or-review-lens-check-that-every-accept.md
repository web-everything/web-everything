---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-ready-record.mjs", "we:scripts/operations/ruled-weakened-store.mjs", "we:scripts/operations/__tests__/fix-ready-record.test.mjs", "we:scripts/operations/__tests__/ruled-weakened-store.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a lint or review-lens check that every Acceptance bullet naming a CLI or entry point has a te… (from web-everything/web-everything#7300 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-ready-record.mjs:288` — Add a lint or review-lens check that every Acceptance bullet naming a CLI or entry point has a test through that entry point, not only through the helper. Filing a card is the cheapest option.
2. `we:scripts/operations/ruled-weakened-store.mjs:61` — Boundary tests should be written as a pair (n and n+1) for each numeric bound named in the Acceptance. Add this to the test-plan review lens. A deterministic gate is not practical.
3. `we:scripts/operations/fix-ready-record.mjs:288` — Review lens: each Acceptance guarantee phrased in terms of a CLI or entry point (fix-ready-record refuses) must map to a test that enters through that entry point, not only through the helper it delegates to.
4. `we:scripts/operations/ruled-weakened-store.mjs:64` — Require a named boundary test in CI using a record that becomes parseable only beyond the allowed join limit.
5. `we:scripts/operations/fix-ready-record.mjs:307` — Require a named command integration test in CI that uses the default waiver-loading path rather than injected waivers.
6. `we:scripts/operations/ruled-weakened-store.mjs:64` — Add a deterministic boundary test using a record that becomes valid only after joining four following lines, asserting that it remains unattributable and triggers the blocking warning.
7. `we:scripts/operations/fix-ready-record.mjs:307` — Add a deterministic entry-point test using the default waiver-loading path, asserting successful recording with unrelated damage and refusal with target or unattributable damage.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7300@eee4e0ef0cb337f47780d5132e42d2cd05911613

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
