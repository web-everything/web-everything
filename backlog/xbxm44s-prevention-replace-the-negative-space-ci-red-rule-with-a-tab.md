---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs", "we:docs/agent/testing.md", "we:scripts/conveyor/__tests__/pr-expectations.test.mjs", "we:scripts/conveyor/pass-daemons/__tests__/pr-expectation-pass.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Replace the negative-space ci-red rule with a table-driven check classifier (name to action). Add… (from web-everything/web-everything#7190 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:148` — Replace the negative-space `ci-red` rule with a table-driven check classifier (name to action). Add a fixture test that enumerates the real check names (unit, review-gate, merge-gate, red-team, AI review), including a failed-then-rerun-green pair, and asserts the exact action set each produces.
2. `we:docs/agent/testing.md:4678` — Add a docs-claim review lens to the checklist, or a doc note, requiring each delivery-semantics sentence to cite its test. A deterministic gate is not practical here.
3. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:232` — Add a regression test, 'retired PR re-listed or explicitly targeted emits nothing and creates no state', to we:scripts/conveyor/__tests__/pr-expectations.test.mjs. A broader fix is a mutation-coverage check on guard lines, filed as a backlog item.
4. `we:scripts/conveyor/__tests__/pr-expectations.test.mjs` — Add CI regressions that instrument the filesystem reads and assert their offsets and cumulative byte limits, including the expectation reader's boundary-byte probe.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7190@76e40da9d5f3b92121006ac0ba5241344a10c4a5

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
