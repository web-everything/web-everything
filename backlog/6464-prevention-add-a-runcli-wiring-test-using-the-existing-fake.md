---
bornAs: xm2o87m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a runCli wiring test using the existing fake-gh/drain harness that asserts the ledger gains r… (from web-everything/web-everything#5195 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5800` — Add a runCli wiring test using the existing fake-gh/drain harness that asserts the ledger gains review-exempt and release rows after a pass, and none under --dry-run. Longer term, a standards rule requiring a wiring test for any new import added to we:scripts/merge-ai-prs.mjs.
2. `we:scripts/conveyor/health-watch.mjs:1210` — Add a tick-level test with a scratch `--ledger-readiness-history` path asserting the file gains a line at 22:00 ET and does not under a fixture flag. A probe-registry check that every smell's declared probe has a producer in tick() would catch the same class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5195@5dd818e6ce3772d03b3656104e9333b50f5ac324

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
