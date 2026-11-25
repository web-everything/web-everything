---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/repo-health.test.mjs", "we:scripts/conveyor/repo-health.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Give each negative case a mock where only the targeted defect is bad (a valid merge response foll… (from web-everything/web-everything#7470 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/conveyor/__tests__/repo-health.test.mjs:162` — Give each negative case a mock where only the targeted defect is bad (a valid merge response follows) and assert the specific error message. A lint rule forbidding argument-less `toThrow()` in fail-closed tests would gate the class. File it with card 8706.
2. `we:scripts/conveyor/repo-health.mjs:140` — Assert the full search string and GraphQL variables and filters in the 'fetches exactly two lists' test, and add a noMergeHours below 24 case. A mutation-check step for new readers would gate the class.
3. `we:scripts/conveyor/repo-health.mjs:37` — Apply the same skew tolerance to PR and merge timestamps, with a reader-level test whose injected fetch returns a PR created after `now`. Add a review-checklist line: time guards must be tested with data fetched after the clock snapshot.
4. `we:scripts/conveyor/repo-health.mjs:161` — A check:standards rule requiring a shared main-module helper that applies realpath to argv[1].
5. `we:scripts/conveyor/__tests__/repo-health.test.mjs:172` — Make each negative case supply valid responses for all other calls and assert the specific error, e.g. `toThrow(/incomplete GraphQL response/)` and `toThrow(/incomplete PR labels/)`. As a deterministic gate, lint against argument-less `toThrow()` in tests of fail-closed readers. Card 8706 asks for a test per catch but does not cover this masking.
6. `we:scripts/conveyor/repo-health.mjs:112` — Add one isolated negative case per guard, each asserting its own error message, and assert `mergeWindowStart` in the two-call `fetchFacts` test. A mutation-testing gate scoped to fail-closed readers would catch this class deterministically.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 7 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7470@77e93c899fad5c4aa11d29fefce1417b002a5aa6

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
