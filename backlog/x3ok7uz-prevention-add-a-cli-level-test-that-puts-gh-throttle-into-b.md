---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-queue-watch.mjs", "we:scripts/conveyor/health-smells/ci-job-hung.mjs", "we:scripts/conveyor/__tests__/ci-queue-watch.test.mjs", "we:scripts/conveyor/health-smells/__tests__/ci-job-hung.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a CLI-level test that puts gh-throttle into backoff and asserts the fake gh receives no -X PO… (from web-everything/web-everything#4479 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-queue-watch.mjs:556` — Add a CLI-level test that puts gh-throttle into backoff and asserts the fake gh receives no `-X POST`. Alternatively, add a standards lint that flags a bare `execFileSync('gh', ...)` in scripts/conveyor.
2. `we:scripts/conveyor/ci-queue-watch.mjs:1030` — Parse the switch with a shared env-flag helper that treats any value in {0,false,off,no} as off. Add a table test over those spellings. A lint rule against `!== '0'` env checks on write-enabling switches would catch the class.
3. `we:scripts/conveyor/health-smells/ci-job-hung.mjs:62` — Restrict parsing to samples whose name is ci-queue-watch, and require the marker at line start after the optional timestamp or repeat prefix. Render check names as inert text: strip or escape `://`, `#`, `*`, `_`, `|` and `(`. A shared 'untrusted name for alerts' helper with a test corpus would cover the class.
4. `we:scripts/conveyor/ci-queue-watch.mjs` — Add a deterministic state-table test covering newer run attempts after every deferred recovery stage, asserting no cancellation and a consumed recovery budget.
5. `we:scripts/conveyor/ci-queue-watch.mjs` — Persist a recoverable cancellation intent before sending the request and add a deterministic crash-injection test in we:scripts/conveyor/__tests__/ci-queue-watch.test.mjs named 'resumes cancellation recovery after termination before response recording', asserting that a subsequent sweep restores the whole run.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4479@f656a08a3a6e5ff68b6f5dcf593fae3f24d519dd

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
