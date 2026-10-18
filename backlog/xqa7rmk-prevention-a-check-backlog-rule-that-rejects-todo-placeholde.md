---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6219-overlap-yield-held.md", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A check:backlog rule that rejects TODO placeholders in cards with status other than open. (from web-everything/web-everything#5525 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6219-overlap-yield-held.md:14` — A check:backlog rule that rejects TODO placeholders in cards with status other than open.
2. `we:scripts/merge-ai-prs.mjs:4388` — Extract the policy logging into a small function the test can call, or add a CLI smoke test that asserts the policy lines on stderr.
3. `we:scripts/merge-ai-prs.mjs:2322` — Add a test that calls buildOverlapRows with no env stub and with the CLI flag in argv. Add a drain-level gate that fails a PR whose body says 'no code' while its net diff touches scripts/.
4. `we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs:128` — Review lens: a changed expected value in an existing test needs a paired new test for the old input.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5590, finding 4 → #6142, finding 7 → #4858.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5525@2e60c7be5bb12856b299b861cee5839c6c35e18b

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
