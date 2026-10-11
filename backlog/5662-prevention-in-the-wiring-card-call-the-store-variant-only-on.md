---
bornAs: xjqp78f
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-facts-source.mjs", "we:scripts/lib/__tests__/drain-facts-source.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — In the wiring card, call the store variant only on the listing path, never inside fetchFreshPrFor… (from web-everything/web-everything#4690 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-facts-source.mjs:98` — In the wiring card, call the store variant only on the listing path, never inside `fetchFreshPrForRevalidation`. Add a test where an in-progress rollup row for the same head must win, or force GitHub, over a completed store run. Add a card-level test that the revalidation path never reads the store.
2. `we:scripts/lib/drain-facts-source.mjs:88` — Add a test that uses `defaultReadRepoFacts` with a fixture mirror dir (the `dir`, `url` and `token` overrides, or `WE_PR_FACTS_DIR` plus a seeded mirror file) and asserts the reason strings for fresh, ttl-expired and feed-stale cases. A pr-facts contract test would also catch return-shape drift.
3. `we:scripts/lib/drain-facts-source.mjs:98` — In storeCheckRow, collect all completed rows named `test` and return null unless exactly one exists or all agree on SUCCESS. Add a test with a mixed-app failure. The wiring card (5736) can also add a rule that the pass-start source never answers green when the store cannot show the absence of an in-progress run.
4. `we:scripts/lib/drain-facts-source.mjs:86` — Add deterministic tests in we:scripts/lib/__tests__/drain-facts-source.test.mjs that invoke readPassFacts without readRepoFacts, mock the pr-facts module, and assert stale mirrors produce GitHub fallback without requesting facts; verify that removing the freshness guard reddens those tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4690@d88a8fd232365a5ec92278f3b71b88570511ad6e

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
