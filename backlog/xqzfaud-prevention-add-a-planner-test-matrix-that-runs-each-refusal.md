---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs", "we:scripts/conveyor/__tests__/fix-resume.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a planner test matrix that runs each refusal reason with takeoverReviewAttempts at 0 and 1 an… (from web-everything/web-everything#4779 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/conveyor/reconcile-core.mjs:1805` — Add a planner test matrix that runs each refusal reason with `takeoverReviewAttempts` at 0 and 1 and asserts every cap-exhausted outcome either dispatches something or posts a note. As a fix, fall through to the cap-exhausted note when `takeoverReviewGrant(...).ok` is false.
2. `we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs:440` — Require a refusal test for every untrusted-input guard when git or gh argv is built from PR fields. A standards check could flag `execFileSync('git'` calls that interpolate PR fields without a sibling `unsafe-ref` test.
3. `we:scripts/conveyor/__tests__/fix-resume.test.mjs` — Add a deterministic injected-I/O test asserting the read range for a journal larger than JOURNAL_TAIL_BYTES, including the default bound rather than only an explicit override.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5837.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4779@ca4b3f6a42fa59cec6ed0d7c45d280e94b235164

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
