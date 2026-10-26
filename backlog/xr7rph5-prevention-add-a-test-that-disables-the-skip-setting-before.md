---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:docs/agent/testing.md", "we:scripts/operations/__tests__/review-job-red-team-only.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a test that disables the skip setting before recovery and asserts the job does not post polic… (from web-everything/web-everything#5942 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-job.mjs:806` — Add a test that disables the skip setting before recovery and asserts the job does not post policy-clear. Better, have the recovery path read readRedTeamProbes({env}).value.skipCardOnly instead of trusting the stored flag.
2. `we:scripts/operations/review-job.mjs:806` — Add a job test where the current skipCardOnly setting is off on the new head and assert there is no policy-clear comment. Better, have the job use the same `redTeamOwedOnHead` / `readRedTeamProbes` check at execution time.
3. `we:docs/agent/testing.md:178` — Extend the named regression test to compare persisted panel verdict evidence before and after recovery, and include it in the affected-test gate.
4. `we:scripts/operations/__tests__/review-job-red-team-only.test.mjs` — Extend the named settlement test to compare the persisted panel verdict before and after recovery, and include it in the affected-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5942@74b411f5db49f81163acd1d2180baac1e1d066b3

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
