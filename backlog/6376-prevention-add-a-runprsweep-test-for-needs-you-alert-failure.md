---
bornAs: x4v5l97
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-sweep.mjs", "we:scripts/conveyor/__tests__/pr-sweep.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a runPrSweep test for NEEDS YOU alert failure that asserts the preserved set. Add a review-le… (from web-everything/web-everything#5323 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-sweep.mjs:122` — Add a runPrSweep test for NEEDS YOU alert failure that asserts the preserved set. Add a review-lens check that every prose guarantee in docs has a named test per branch.
2. `we:scripts/conveyor/pr-sweep.mjs:108` — Add the queue-incomplete case to the 'failed owner reads' test. Assert `episodes` unchanged and `alerts` empty for each fail-closed input (owner read, PR read, queue).
3. `we:scripts/conveyor/pr-sweep.mjs:43` — Add a deterministic readLogTail test that asserts filesystem read ranges for a log larger than 2 MiB.
4. `we:scripts/conveyor/pr-sweep.mjs:116` — Add a deterministic overdue-episode queue-failure test, including preservation of the previous NEEDS YOU set.
5. `we:scripts/conveyor/__tests__/pr-sweep.test.mjs:62` — Add deterministic default, explicit-false, and explicit-true diagnosis cases using an otherwise diagnosis-eligible PR.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5323@c7b96a8602cc50ba2147089d5e4d12eee660b9ba

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
