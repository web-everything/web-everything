---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/pr-trace-io.mjs", "we:scripts/operations/__tests__/pr-trace.test.mjs", "we:scripts/operations/pr-trace.mjs", "we:scripts/operations/__tests__/pr-trace-io.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — Filter by filename prefix before counting, or raise the cap well above the real directory size, a… (from web-everything/web-everything#5961 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/pr-trace-io.mjs:23` — Filter by filename prefix before counting, or raise the cap well above the real directory size, and add a test that runs the reader over a directory larger than the cap. A lint on hard-coded scan caps without a test is possible but low value.
2. `we:scripts/operations/__tests__/pr-trace.test.mjs:103` — Add a checklist item to the review lens: every numeric bound constant in an io module needs a test that exceeds it. A deterministic gate for this is not obvious.
3. `we:scripts/operations/__tests__/pr-trace.test.mjs:87` — Add tests named for each guard. One should pass an invalid repo (`'a/b/c'`, `'x'`, a 201-character slug) and assert `gh` is not called. Another should use a fake `opendirSync` or a directory with more than 32 matching files and assert that `red-team-status` lands in `unavailable`. A mutation-testing gate over io modules would catch the whole class.
4. `we:scripts/operations/pr-trace-io.mjs:23` — Add deterministic tests asserting actual read ranges or byte counts, maximum directory reads, and matching-status limits; run them in the standard test gate.
5. `we:scripts/operations/pr-trace.mjs:11` — Add a deterministic parameterized test with two distinct matching reasons for each supported format and assert that latest and likelyBlocker use the appended reason.
6. `we:scripts/operations/__tests__/pr-trace.test.mjs:112` — Add a deterministic test named 'limits source reads to MAX_BYTES' that instruments filesystem reads and asserts their byte counts and ranges on oversized fixtures; require it in the test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5961@e29192f23a7d0b9719209e4b67e7da647cf5e563

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
