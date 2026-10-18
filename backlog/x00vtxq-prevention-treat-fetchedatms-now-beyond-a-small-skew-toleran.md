---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/required-status-checks.mjs", "we:scripts/lib/pr-state-io.mjs", "we:scripts/lib/__tests__/required-status-checks.test.mjs", "we:scripts/lib/__tests__/pr-state-io.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Treat fetchedAtMs now (beyond a small skew tolerance) as invalid or stale in validEntry and cache… (from web-everything/web-everything#5404 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/required-status-checks.mjs:340` — Treat `fetchedAtMs > now` (beyond a small skew tolerance) as invalid or stale in `validEntry` and `cacheEntryOutranks`, and add a regression test. Longer term, a lint or standards rule could require any shared-state reader to bound timestamps.
2. `we:scripts/lib/pr-state-io.mjs:107` — Add a review lens or standards check: when a direct reader is replaced by a degrading shared reader, every degraded source must be mapped to an explicit visible/silent decision with a stated justification. A cheap guard is a test that enumerates all `source` values for each caller.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5404@21c7bd69a07ed5fc9d0809b3508e9fbf1021836c

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
