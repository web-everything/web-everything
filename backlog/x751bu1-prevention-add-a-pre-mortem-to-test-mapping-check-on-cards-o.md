---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-loop-ticks.mjs", "we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs", "we:scripts/conveyor/__tests__/health-loop-ticks.test.mjs", "we:scripts/conveyor/__tests__/health-watch-core.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a pre-mortem-to-test mapping check on cards, or a review-lens rule that each pre-mortem bulle… (from web-everything/web-everything#7417 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-loop-ticks.mjs:131` — Add a pre-mortem-to-test mapping check on cards, or a review-lens rule that each pre-mortem bullet names a test file and case.
2. `we:scripts/conveyor/health-watch-core.mjs:937` — Smell test-template gate: each smell test file must include a missing-probe case.
3. `we:scripts/conveyor/health-loop-ticks.mjs:62` — Name the slack as a constant and reference it in the comment.
4. `we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs:14` — A table-driven boundary test for every verdict clause, with one case per clause that is only wrong when that clause is removed.
5. `we:scripts/conveyor/health-loop-ticks.mjs:131` — A standards rule or review lens that every pre-mortem bullet in a PREP maps to a named test, checked at PR time.
6. `we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs:22` — Add CI-enforced tests in this file named 'rejects too few ticks spanning the full window' and 'rejects enough ticks spanning less than the required duration', with independent no-alarm assertions.
7. `we:scripts/conveyor/health-loop-ticks.mjs:140` — Add CI-enforced tests in we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs named 'expires records beyond the retention boundary' and 'caps each loop without evicting another loop', asserting retained timestamps, per-loop counts, and preservation of the quiet loop's records.
8. `we:scripts/conveyor/health-watch-core.mjs:938` — Add a CI-enforced test in we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs named 'preserves evidence and an open alarm when the loop probe is absent'; advance beyond retention with no probe and assert unchanged records, an open episode, and no close transition.
9. `we:scripts/conveyor/health-loop-ticks.mjs:65` — Add a deterministic regression test named 'keeps an outage open through aged evidence until an observed success', advancing beyond the retention window with idle samples and asserting the original episode remains open.
10. `we:scripts/conveyor/health-loop-ticks.mjs:131` — Add named tests in we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs: 'drops records outside retention', asserting retained timestamps; 'caps each loop independently', asserting counts and preservation of a second loop; and 'missing probe preserves memory and open episodes', asserting unchanged memory and no closure. Run these as a deterministic test gate.
11. `we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs:61` — Commit sanitized production fixtures and add named tests 'replays captured builder outage' and 'replays captured healthy drain loop' in we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs, asserting exactly one alarm and no alarms respectively, as a deterministic test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7417@5f725e9368b87956ab2218645543b58a3a97d955

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
