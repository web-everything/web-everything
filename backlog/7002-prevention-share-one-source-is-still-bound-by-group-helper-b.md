---
bornAs: x8wdzjy
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/card-group.mjs", "we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/settings/drain-card-group.json", "we:backlog/6996-card-group-fast-drain-race.md", "we:backlog/6997-merge-gate-inventory-test-fails-drain-skip-kinds-merge-lock.md", "we:backlog/6998-prevention-card-group-exclusion-and-wiring-coverage.md", "we:scripts/lib/__tests__/card-group.test.mjs", "we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Share one 'source is still bound by group' helper between cardGroupHold and inCardGroup. Add a wi… (from web-everything/web-everything#5762 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/card-group.mjs` — Share one 'source is still bound by group' helper between cardGroupHold and inCardGroup. Add a wiring-matrix case in we:card-group-drain-wiring.test.mjs asserting that a settled source is neither held nor exempt. Card 6998 A6 could carry it.
2. `we:scripts/conveyor/parked-pr-conflict-watch.mjs:1412` — Short-circuit when resolveCardGroupStatePath is null or the file is absent, since membership is then known to be false. Add a test: no state file plus currentRepo failure still routes the PR. A check:standards rule requiring 'fail-closed holds name their precondition' would be heavier than the finding warrants.
3. `we:scripts/settings/drain-card-group.json` — Add a test that calls readCardGroupSettings with the real readSettings() output (env cleared of VITEST/WE_UNDER_TEST) and expects enabled true with source 'tool'. A generic standards rule could require each scripts/settings/*.json to be read by a test.
4. `we:backlog/6996-card-group-fast-drain-race.md:29` — Have card admission reject Acceptance mappings containing only a suite path or a placeholder for a test name.
5. `we:backlog/6997-merge-gate-inventory-test-fails-drain-skip-kinds-merge-lock.md:37` — Require a structured Risks-to-test mapping at card admission, including the assertion that distinguishes the prohibited behavior from a passing inventory.
6. `we:backlog/6998-prevention-card-group-exclusion-and-wiring-coverage.md:17` — Apply a deterministic Acceptance/Risks test-map requirement to prevention cards themselves, accepting concrete planned names and assertions before implementation.
7. `we:backlog/6996-card-group-fast-drain-race.md:28` — Gate card admission on an Acceptance-to-test manifest that rejects placeholder phrases such as 'Named test' without an actual case name.
8. `we:backlog/6997-merge-gate-inventory-test-fails-drain-skip-kinds-merge-lock.md:37` — Require classification changes to carry a test map naming emitter-level refusal assertions alongside inventory equality.
9. `we:backlog/6998-prevention-card-group-exclusion-and-wiring-coverage.md:18` — Add a deterministic card-lint requirement for named positive and negative fixtures, including observable assertions for each explicit Risks constraint.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 4 → #5473, finding 8 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5762@68b1be6f1fd1a15cfacbd007dd7e4a773ff890aa

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
