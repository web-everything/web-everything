---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-jobs.mjs", "we:scripts/lib/__tests__/daemon-jobs.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Run the acceptance-3 live capture of real brew info --json=v2 --installed and brew outdated --jso… (from web-everything/web-everything#7552 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-jobs.mjs:432` — Run the acceptance-3 live capture of real `brew info --json=v2 --installed` and `brew outdated --json=v2 --greedy` output, and commit it as a golden fixture the tests parse, replacing hand-built rows.
2. `we:scripts/lib/__tests__/daemon-jobs.test.mjs:466` — Add a review lens or checklist step: for each `throw` or guard branch in a new module, name its test. A coverage-threshold gate on changed lines in `we:scripts/lib/daemon-jobs.mjs` would also catch this.
3. `we:scripts/lib/__tests__/daemon-jobs.test.mjs:470` — Add a review lens or a lint that requires each guard clause in a validator to have a negative test case. A cheap form is a coverage-threshold or mutation check on the validator.
4. `we:scripts/lib/daemon-jobs.mjs:430` — Pin an allowlist of expected full names or taps in `WATCHED_TOOLS`, and add a test with a same-basename package from a foreign tap that expects 'unknown'. File this as a backlog card.
5. `we:scripts/lib/daemon-jobs.mjs:373` — Add the named boundary tests to the test gate, rejecting each omitted adapter and observing zero process launches during import and construction.
6. `we:scripts/lib/__tests__/daemon-jobs.test.mjs` — Add a deterministic fault-injection test that rejects writeState after publication, restarts the watcher, and asserts identical episode IDs and exactly one published event.
7. `we:scripts/lib/daemon-jobs.mjs` — Add an isolated-import test with process-launch APIs intercepted before loading the module and assert zero launches.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7552@35c9902ab5dfcde747b3770d924e3503184618b8

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
