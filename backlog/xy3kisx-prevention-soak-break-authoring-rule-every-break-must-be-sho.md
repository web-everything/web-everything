---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/owed-ci-rerun-stale-daemon-clone-refused.mjs", "we:scripts/conveyor/__tests__/owed-ci-rerun-executor.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/owed-ci-rerun-stale-daemon-clone-refused.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Soak-break authoring rule: every break must be shown to fail against the pre-fix tree. A check:st… (from web-everything/web-everything#7288 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/owed-ci-rerun-stale-daemon-clone-refused.mjs:21` — Soak-break authoring rule: every break must be shown to fail against the pre-fix tree. A check:standards gate or soak-harness mode that runs each new break against the base commit's tree and requires at least one violation would do it. The break here sets `fixPresent` to true, so that verification never runs.
2. `we:scripts/conveyor/__tests__/owed-ci-rerun-executor.test.mjs:44` — Add a deterministic regression test that leaves checkStaleness unset, mocks the underlying git runner, and asserts dispatch with a stale local main plus verified origin/main; replacing the default with the stale-clone guard must redden that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7288@8e6255d9bdef7439063fd627053acff9857ef5b6

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
