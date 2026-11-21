---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ci-selection-settings.mjs", "we:scripts/ci/dep-trace.mjs", "we:scripts/lib/__tests__/ci-selection-settings.test.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — A write-gate that requires every new scripts/lib/*.mjs module to have a test file importing it, o… (from web-everything/web-everything#7123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ci-selection-settings.mjs:16` — A write-gate that requires every new scripts/lib/*.mjs module to have a test file importing it, or a lens rule that every 'invalid leaves retain X' claim must cite a named test. Filing a backlog item is the cheapest option.
2. `we:scripts/ci/dep-trace.mjs:219` — Write a failure marker file, such as trace-<pid>we:.incomplete.json with truncated:true, so mergeTraces treats the test as unknown. Add a named test for the write-failure path.
3. `we:scripts/ci/dep-trace.mjs:112` — For an explicit options.env, add only the hook flag: use inheritOptions(childEnv.NODE_OPTIONS ?? ''). Add a test asserting that exact NODE_OPTIONS value.
4. `we:scripts/lib/ci-selection-settings.mjs:16` — Add a check:standards rule that every new scripts/lib/*.mjs module exporting a function has a sibling __tests__ file naming that export. Until then, add a loadCiSelection unit test covering invalid leaves, cascade order and malformed WE_CI_SELECTION.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7123@114c8f692e50caaaa4c53103a059aa3d53b1c3db

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
