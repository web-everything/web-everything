---
bornAs: xggx7p0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-smells/main-ci-red.mjs", "we:scripts/conveyor/__tests__/main-ci-red-group-evidence.test.mjs", "we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a smell test that evaluates the summary for each flake.reason (already-rerun, rerun-off, merg… (from web-everything/web-everything#5278 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-smells/main-ci-red.mjs:90` — Add a smell test that evaluates the summary for each flake.reason (already-rerun, rerun-off, merge-group-green-on-tip) and asserts the 're-run requested' wording only for an actual planned re-run. Alternatively, make the smell take the wording from the plan's reason.
2. `we:scripts/conveyor/__tests__/main-ci-red-group-evidence.test.mjs:96` — Review lens: for each new setting in MAIN_CI_RED_DEFAULTS, require one test per documented value (off, 0, default) asserting the observable read call. A lint that flags new MAIN_CI_RED_DEFAULTS keys not referenced in __tests__ would make this deterministic.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5278@dc56ab1cecce2817fc2c6f0537f3081716803b56

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
