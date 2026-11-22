---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ci-selection-settings.mjs", "we:scripts/ci/dep-trace.mjs", "we:scripts/lib/__tests__/ci-selection-settings.test.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a standards rule or lint that every new scripts/lib/*-settings.mjs loader has a sibling __tes… (from web-everything/web-everything#7123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ci-selection-settings.mjs:16` — Add a standards rule or lint that every new `scripts/lib/*-settings.mjs` loader has a sibling `__tests__` file calling its exported loader. Failing that, add a review-lens line to the cascade-policy checklist.
2. `we:scripts/ci/dep-trace.mjs:28` — Drive the test from the exported flag list (`it.each(UNTRACED_FLAGS)`), so adding a flag adds its test.
3. `we:scripts/ci/dep-trace.mjs:297` — Add a replay invariant test: any result with `traceKnown === false` must be `traced: null`, or the summary must warn on `counts.unknown > 0`.
4. `we:scripts/ci/dep-trace.mjs:29` — Derive the table rows from the exported flag list, so adding or removing a flag changes the tests automatically.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7123@cecaea39e042db8a5f1fb1d183946fd2430ec46e

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
