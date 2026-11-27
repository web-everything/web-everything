---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/delegated-clear-human.mjs", "we:docs/agent/platform-decisions.md", "we:scripts/conveyor/__tests__/delegated-clear-human.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Export a small buildRunArgs(argv, readers) helper (or make main injectable) and add a test that -… (from web-everything/web-everything#7607 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/delegated-clear-human.mjs:182` — Export a small `buildRunArgs(argv, readers)` helper (or make `main` injectable) and add a test that `--repo=plateauapp/plateau-app` reaches `runDelegatedClearHuman` with that repo. More generally, a standards lens: a new function parameter whose only production supplier is an untested CLI entrypoint must come with a wiring test.
2. `we:docs/agent/platform-decisions.md:6774` — Add a one-line test asserting that `{ name: 'test', conclusion: 'success' }` counts as green. As a review lens: every new decision-record sentence that states a behaviour should map to a named test.
3. `we:docs/agent/platform-decisions.md:6774` — Add a deterministic parameterized test asserting eligibility for required rows with SUCCESS, NEUTRAL, and SKIPPED in uppercase and lowercase.
4. `we:docs/agent/platform-decisions.md:6773` — Add a deterministic parameterized test asserting eligibility for required non-hold rows with SUCCESS, NEUTRAL, and SKIPPED in uppercase and lowercase; verify that removing an accepted verdict or case normalization makes it fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7607@af9681ff03ae537ea6c5ce7170ee5787c7e00829

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
