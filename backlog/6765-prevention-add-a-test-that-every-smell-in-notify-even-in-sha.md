---
bornAs: xptge7z
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-smells-notify-list.mjs", "we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/__tests__/health-smells-notify-list.test.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs", "we:scripts/conveyor/__tests__/main-ci-red-io.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a test that every smell in NOTIFY_EVEN_IN_SHADOW whose id contains 'red-main' or 'main-ci-red… (from web-everything/web-everything#5281 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-smells-notify-list.mjs:58` — Add a test that every smell in NOTIFY_EVEN_IN_SHADOW whose id contains 'red-main' or 'main-ci-red' yields a main-red emergency from breakthroughEmergency. A deterministic gate beats a doc note.
2. `we:scripts/conveyor/main-ci-red-core.mjs:805` — In the replay test, assert the full alert schedule (first alert time, then each gap equals EveryMin), so a spacing mismatch against the setting's name reddens.
3. `we:scripts/conveyor/main-ci-red-io.mjs:232` — Give the new progress fields their own reader (or gate the supersede-by-pending behaviour on the stall setting), and add a combine-rule test with a PR that has an in-flight newer run.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5281@751a45c91cc803f7dc9d3694a5f76366d611059e

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
