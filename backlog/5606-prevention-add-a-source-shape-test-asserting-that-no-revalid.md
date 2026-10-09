---
bornAs: xisfc8d
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-revalidation-unknown-mergeability.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a source-shape test asserting that no revalidateForMerge(await fetchFreshPrForRevalidation ca… (from web-everything/web-everything#4611 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:4095` — Add a source-shape test asserting that no `revalidateForMerge(await fetchFreshPrForRevalidation` call remains in runCli. A check:standards rule for the same pattern would also work.
2. `we:scripts/__tests__/merge-ai-prs-revalidation-unknown-mergeability.test.mjs:96` — Add a deterministic parameterized retry test for each eligibility guard, asserting immediate refusal and no subsequent read, and include it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4611@fbf9fec64d557abee84f4c0e30e6956228bd7ff8

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
