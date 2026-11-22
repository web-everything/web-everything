---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ci-selection-settings.mjs", "we:scripts/ci/dep-trace.mjs", "we:scripts/lib/__tests__/ci-selection-settings.test.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a check:standards rule that every new scripts/lib/*-settings.mjs export has a test file impor… (from web-everything/web-everything#7123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ci-selection-settings.mjs:16` — Add a check:standards rule that every new scripts/lib/*-settings.mjs export has a test file importing it, or add a verify-settings assertion that runs each loader over its defaults, an invalid leaf and an env override.
2. `we:scripts/ci/dep-trace.mjs:22` — Export UNTRACED_FLAGS and build the test rows from it with `it.each(UNTRACED_FLAGS)`, so adding a flag adds a test automatically.
3. `we:scripts/ci/dep-trace.mjs:24` — Drive the table from UNTRACED_FLAGS itself with a test that loops over the exported list and asserts each flag marks the trace incomplete. Better: a lint or check:standards rule that every flag in the list appears in a test.
4. `we:scripts/ci/dep-trace.mjs:280` — Make the replay result tri-state for every row (true, false, null) with false allowed only when traceKnown and not incomplete. Add an invariant test that `traced === false` implies `traceKnown && !incomplete`, and add this to the S4 consumer contract.
5. `we:scripts/ci/dep-trace.mjs:383` — Add a deterministic child-process regression that registers an exit-time read after hook activation and checks the persisted edge.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7123@53937d754aaaf8dd39df1db1f069ebc2b4d01654

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
