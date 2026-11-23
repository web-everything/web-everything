---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/ci/__tests__/shard-assign.test.mjs", "we:scripts/__tests__/pr-land.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Card Acceptance template line: 'lists every new refusal or blocker path this change adds'. A revi… (from web-everything/web-everything#7357 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-land.mjs:955` — Card Acceptance template line: 'lists every new refusal or blocker path this change adds'. A review lens could diff a gate's pass/skip/refuse outcome table before and after the change. No deterministic gate exists for this.
2. `we:scripts/pr-land.mjs:959` — Require each new admission refusal to map to an explicit acceptance requirement; enforce that mapping through a structured gate-change manifest checked in CI.
3. `we:scripts/ci/__tests__/shard-assign.test.mjs:30` — Add a deterministic boundary-sensitive fixture to the named test where replacing the median fallback with 6 changes the assignment, and verify that mutation fails.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7357@50890ef41a453d69cc17037a1c886950529f7377

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
