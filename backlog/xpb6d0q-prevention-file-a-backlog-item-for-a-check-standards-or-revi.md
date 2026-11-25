---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/repo-health.test.mjs", "we:scripts/conveyor/repo-health.mjs", "we:backlog/xrh7470-repo-health-review-prevention.md"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — File a backlog item for a check:standards or review-gate rule that rejects argument-less toThrow(… (from web-everything/web-everything#7470 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/repo-health.test.mjs:172` — File a backlog item for a check:standards or review-gate rule that rejects argument-less toThrow() in fail-closed reader tests. Each negative case should assert the specific error message, give a valid response for every other read, and have a mutation check for each guard.
2. `we:scripts/conveyor/repo-health.mjs:43` — File a backlog item to use one shared clock-skew constant for all remote timestamps, with boundary tests just inside and just outside the tolerance for each timestamp field.
3. `we:scripts/conveyor/repo-health.mjs:161` — File a backlog item for a shared isMainModule() helper that compares realpaths, plus a check:standards rule that bans the raw argv[1] comparison.
4. `we:scripts/conveyor/__tests__/repo-health.test.mjs:182` — Give each negative case a valid response for every other call and assert the specific error message (toThrow(/incomplete GraphQL response/), /incomplete PR labels/, and so on). As a class gate, add a check:standards lint rejecting argument-less toThrow() in fail-closed reader tests. The lint must be filed; the card in this diff covers only a review checklist.
5. `we:scripts/conveyor/repo-health.mjs:55` — Require a positive reader-level assertion for every promised derived output, enforced by a targeted mutation gate replacing that output with its neutral value.
6. `we:backlog/xrh7470-repo-health-review-prevention.md:25` — Add an acceptance-to-verification manifest and a deterministic card check requiring every acceptance ID to reference a named automated or manual verification case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7470@ae46e8e6163df563d993ca097c914587756b503d

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
