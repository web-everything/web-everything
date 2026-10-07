---
bornAs: xx2u8th
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/builder-prepare-stale-stamp-livelock.mjs", "we:scripts/conveyor/prepare-failure-policy.mjs", "we:scripts/conveyor/health-builder-ticks.mjs", "we:scripts/conveyor/soak/breaks/__tests__/builder-prepare-stale-stamp-livelock.test.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs", "we:scripts/conveyor/__tests__/health-builder-ticks.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Have the break-file lint require fixPresent to match a code token rather than a tag that also app… (from web-everything/web-everything#4307 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/builder-prepare-stale-stamp-livelock.mjs:28` — Have the break-file lint require `fixPresent` to match a code token rather than a tag that also appears in comments, or run `run()` against the pre-fix source.
2. `we:scripts/conveyor/prepare-failure-policy.mjs:21` — Add a classifier test asserting that the terminal text alone cannot override stronger harness-set evidence flags such as sessionAbsent or resultDiscarded. Better still, have the lane-pool failure set a structured evidence flag instead of matching prose.
3. `we:scripts/conveyor/prepare-failure-policy.mjs:163` — Require a boundary test (at-budget and over-budget) for each new retry or release rule. This could be a review-lens checklist item for any change that touches a retry budget.
4. `we:scripts/conveyor/health-builder-ticks.mjs:51` — Add a deterministic regression test named `does not report prepare starvation immediately when demand resumes`, covering ongoing builds, more than the threshold without prepare demand, and newly arriving demand; track the start of the eligible waiting interval.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4307@3ad2f0ac13077d091a9fd2ac500ff1c7582c5e43

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
