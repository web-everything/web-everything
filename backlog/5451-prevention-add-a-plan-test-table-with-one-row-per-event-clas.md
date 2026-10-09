---
bornAs: xgm0cd1
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/fixer-stuck-reclaim.mjs", "we:scripts/conveyor/__tests__/fixer-stuck-reclaim.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a plan test table with one row per event classification. Each row asserts that a recovered se… (from web-everything/web-everything#4468 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4468's review (reviewed head `75b0f8a7304e4f62130ce29cb2f9e3427b28f3e1`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/fixer-stuck-reclaim.mjs:98` — Add a plan test table with one row per event classification. Each row asserts that a recovered session (head moved or activity newer than the event) yields `hold`. Reviewing every classification branch in the planner for a recovery check would catch this class of gap.
2. `we:scripts/conveyor/fixer-stuck-reclaim.mjs:196` — In planOne, derive the stop handle from the claim holder's sessionId (or require `sessionId.startsWith(id)`), and add a unit test with a mismatched id.
3. `we:scripts/conveyor/fixer-stuck-reclaim.mjs:109` — Treat a record whose age is NaN as "hold", the same way unknown activity is handled. Add a test with `requestedAt: 'garbage'`.
4. `we:scripts/conveyor/fixer-stuck-reclaim.mjs:236` — Add a deterministic parameterized test requiring ownership, dispatch claims, await records, and acknowledgements to remain untouched for undefined, null, and empty stop results; accept only the adapter's documented affirmative stopped or already-gone result.

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
