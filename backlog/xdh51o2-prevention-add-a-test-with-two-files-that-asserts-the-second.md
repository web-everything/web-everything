---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/deps-job.mjs", "we:scripts/lib/__tests__/deps-job-no-packages.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/deps-job.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a test with two files that asserts the second read receives maxBytes - firstFileBytes. More g… (from web-everything/web-everything#7592 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/deps-job.mjs:128` — Add a test with two files that asserts the second read receives `maxBytes - firstFileBytes`. More generally, require every stated bound to have an assertion on the bytes read or the read range.
2. `we:scripts/lib/daemon-rebuild/deps-job.mjs:74` — Add tests for a non-monotonic `now`, a non-finite `now`, a budget of 0 or 1.5, and a missing `read`, `now` or `syntax`. Longer term, add a branch-coverage threshold on the `refuse(...)` calls.
3. `we:scripts/lib/__tests__/deps-job-no-packages.test.mjs:1` — List each merge-path negative as N/A or as a test name in the PR description. Alternatively, add a standards check that a prep Test plan's named cases exist.
4. `we:scripts/lib/daemon-rebuild/deps-job.mjs:72` — Add a lint or coverage gate that requires every distinct `refuse('<reason>')` literal in we:scripts/lib/daemon-rebuild/deps-job.mjs to appear in a test. A check:standards rule that greps the reason slugs against the test file is enough.
5. `we:scripts/lib/__tests__/deps-job-no-packages.test.mjs:17` — Add a deterministic reader-contract test covering the default budget, boundary-sized files, and oversized files, with assertions on readSync arguments and call counts.
6. `we:scripts/lib/__tests__/deps-job-no-packages.test.mjs:21` — Add a deterministic reader test that spies on readSync and asserts its byte range, including files at and above the remaining budget.
7. `we:scripts/lib/daemon-rebuild/deps-job.mjs:62` — Add a deterministic execution-sentinel regression test to the dependency inspection suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7592@250c00b3d6ffb33afbeece2db1138cf6c9aeb33a

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
