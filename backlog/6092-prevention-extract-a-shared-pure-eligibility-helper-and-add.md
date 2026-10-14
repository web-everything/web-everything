---
bornAs: xfqpocz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Extract a shared pure eligibility helper and add a deterministic duplicate-code check for this po… (from web-everything/web-everything#5235 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-job.mjs:818` — Extract a shared pure eligibility helper and add a deterministic duplicate-code check for this policy block to check:standards.
2. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:1629` — Extend this named test with table-driven true, false, and omitted waiver values, and run it as a deterministic CI regression gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5235@47e45cac880c025756dd17aae76059b2f7d87558

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
