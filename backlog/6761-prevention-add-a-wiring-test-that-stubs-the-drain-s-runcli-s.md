---
bornAs: xpj0069
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/ledger-readiness-daily.mjs", "we:scripts/lib/drain-ledger-facts.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs", "we:scripts/lib/__tests__/drain-ledger-facts.test.mjs", "we:scripts/lib/__tests__/pr-merge-gate.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a wiring test that stubs the drain's runCli seams and asserts that the recorder receives revi… (from web-everything/web-everything#5195 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5800` — Add a wiring test that stubs the drain's runCli seams and asserts that the recorder receives `reviewGate` and the shared snapshot. A standards check that every new `scripts/lib/*-facts.mjs` writer is imported by a test that drives its production caller would catch the class.
2. `we:scripts/lib/ledger-readiness-daily.mjs:74` — Add a test in `we:ledger-readiness-daily.test.mjs` that runs the check at 22:05 and again at 00:05 with the toggle still active, and assert one line per night.
3. `we:scripts/lib/drain-ledger-facts.mjs:48` — Add a test that runs every fact kind (exempt, restamp, release) against a non-merge decision. Move the decision guard to the top of the per-verdict loop, with an explicit opt-out for exempt.
4. `we:scripts/lib/pr-merge-gate.mjs:377` — Have `derive` expose `exemptHeadSha` and have `ledgerVerdict` compare it to `head` the same way as `covered`. Add a mismatched-head test to we:pr-state-review-exempt.test.mjs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5195@20fb386cf1552aa4b9d2a6fcbca55e6362f09276

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
