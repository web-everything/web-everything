---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-branch.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a guard-coverage convention: each refusal branch in a gate command needs a test where only th… (from web-everything/web-everything#7246 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:5651` — Add a guard-coverage convention: each refusal branch in a gate command needs a test where only that branch can fire. A mutation-testing step (for example Stryker on we:scripts/lane-pool.mjs refusals) would catch this class. File this as a backlog item.
2. `we:scripts/__tests__/lane-pool-branch.test.mjs:143` — Review lens: for each guarantee named in a comment, name the test that defends it. A deterministic gate is not practical for this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7246@fae3720520c385e97822d8a940ce6cfc568c8724

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
