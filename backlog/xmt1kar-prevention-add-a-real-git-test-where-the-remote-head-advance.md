---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/load-flake-merge-main.test.mjs", "we:scripts/verify-lane.mjs", "we:scripts/operations/coroner-extract.mjs", "we:backlog/xg0rkxn-a-load-flake-retry-merges-current-main-into-the-pr-head-firs.md", "we:scripts/conveyor/load-flake-merge-main.mjs", "we:scripts/lib/verify-selection-log.mjs", "we:scripts/lib/__tests__/verify-selection-log.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/operations/__tests__/coroner-extract.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a real-git test where the remote head advances before the push and assert a throw with the re… (from web-everything/web-everything#4783 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/load-flake-merge-main.test.mjs:103` — Add a real-git test where the remote head advances before the push and assert a throw with the remote ref unchanged. A lint rule rejecting `--force` or a `+` refspec in conveyor scripts would also work.
2. `we:scripts/verify-lane.mjs:415` — Put the summarize and notice calls in a shared `safeNotice()` helper that swallows errors, so both call sites use it.
3. `we:scripts/conveyor/__tests__/load-flake-merge-main.test.mjs:112` — Add a real-git test, 'refuses a moved head: a non-fast-forward push throws and the remote ref is unchanged'. A cheaper gate is a lint rule that flags `--force`, `-f` or a `+` refspec in scripts/conveyor/*.mjs git push calls.
4. `we:scripts/operations/coroner-extract.mjs:627` — Have `parseSelectionLine` return null when the mode is not in SELECTION_MODES. Count into an object created with `Object.create(null)` or into a Map. Add a test with an unknown mode.
5. `we:backlog/xg0rkxn-a-load-flake-retry-merges-current-main-into-the-pr-head-firs.md` — A commit lint rule or PR gate verifying that any newly added `.md` file in `backlog/` contains mandatory `# Risks` and `# Test plan` headings.
6. `we:scripts/conveyor/load-flake-merge-main.mjs` — A standard requiring that any explicit safety refusal mentioned in prose must have an automated test simulating that specific failure path.
7. `we:scripts/lib/verify-selection-log.mjs` — A standard that any string manipulation limit mentioned explicitly in prose must be accompanied by a boundary test.
8. `we:scripts/lib/__tests__/verify-selection-log.test.mjs` — A lint rule forbidding `readFileSync` of the module under test to assert its behavior via regex matching in unit tests.
9. `we:scripts/conveyor/__tests__/load-flake-merge-main.test.mjs:32` — A strict coverage gate that fails PRs asserting explicit edge cases without corresponding named tests.
10. `we:scripts/lib/__tests__/verify-selection-log.test.mjs:12` — A strict coverage gate that mandates test cases for explicit boundaries (like `slice` or length caps).
11. `we:scripts/conveyor/__tests__/load-flake-merge-main.test.mjs:86` — A strict coverage gate that fails PRs asserting explicit edge cases (like push refusal) without corresponding named tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4783@4d2200971235434368af1e7cddc05113519c619d

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
