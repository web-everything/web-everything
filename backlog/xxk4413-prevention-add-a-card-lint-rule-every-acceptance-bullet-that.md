---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6273-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a card-lint rule: every Acceptance bullet that says 'Must' needs a backticked test name in th… (from web-everything/web-everything#5510 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6273-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:23` — Add a card-lint rule: every Acceptance bullet that says 'Must' needs a backticked test name in the same file, or an explicit 'n/a: vacuous' marker.
2. `we:scripts/conveyor/review-referral-hold.mjs:250` — Add a test-matrix rule or lint for policy cascades: every new boolean policy leaf needs an invalid-value case per layer (tool, platform, env) asserting the logged `ignored invalid` line and the effective value. Failing that, a review-lens note on kill switches that default on.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5510@f7e0cef24eecfc9a1cec7cda04c995bb84268273

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
