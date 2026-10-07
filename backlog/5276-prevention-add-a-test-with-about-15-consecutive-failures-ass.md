---
bornAs: xo3zx48
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/pass-daemon.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a test with about 15 consecutive failures asserting alert counts [2, 14]. A review lens that… (from web-everything/web-everything#4263 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/pass-daemon.test.mjs:346` — Add a test with about 15 consecutive failures asserting alert counts `[2, 14]`. A review lens that asks for a test of each prose guarantee would also catch this class.
2. `we:scripts/conveyor/health-watch.mjs:240` — Return or log a `truncated` indicator from the probe. Derive the look-back from `max(config windows) + margin`. A test could assert that the look-back is at least `DEFAULT_HEALTH_CONFIG.sameHeadReviewWindowMs`.
3. `we:scripts/conveyor/health-watch.mjs` — Add a deterministic test that supplies more than maxRecords malformed files and asserts that read attempts stop at maxRecords; track attempts separately from returned records.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4263@0afbb6c19abbfd157e01637a7e4a9c0971406981

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
