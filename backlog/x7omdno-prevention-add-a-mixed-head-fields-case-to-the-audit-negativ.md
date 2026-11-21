---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/round-judge.test.mjs", "we:scripts/lib/round-judge.mjs", "we:scripts/conveyor/__tests__/pr-stall-sweep.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a mixed-head-fields case to the 'audit negatives' describe block. A mutation-testing gate ove… (from web-everything/web-everything#7237 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/round-judge.test.mjs:440` — Add a mixed-head-fields case to the 'audit negatives' describe block. A mutation-testing gate over the settle predicate would catch the whole class.
2. `we:scripts/lib/round-judge.mjs:152` — Allowlist reviewer actors, using a shared constant such as REVIEWER_ACTORS imported by both extractRounds and holdSettled. Add a test that an unlisted actor does not settle a hold. A check:standards rule could flag `Recorded by (?:` denylist regexes in the round-judge modules.
3. `we:scripts/conveyor/__tests__/pr-stall-sweep.test.mjs:277` — Require each Acceptance entry to reference a named test or executable smoke check, with a deterministic completeness check for those references.
4. `we:scripts/lib/round-judge.mjs:152` — Add a deterministic regression test with a fenced live-head line and no actual head field, asserting that the referral hold remains.
5. `(no file cited)` — Require each Acceptance item to reference a named implemented or planned test with an observable assertion, enforced by a structured acceptance-to-test check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7237@0a9c06897b400d27c9bc8451468018b05a8c1c28

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
