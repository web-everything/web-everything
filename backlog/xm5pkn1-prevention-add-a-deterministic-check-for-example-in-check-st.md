---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/settings/expectations.json", "we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs", "we:docs/agent/testing.md", "we:scripts/conveyor/pass-daemons/__tests__/pr-expectation-pass.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a deterministic check, for example in check:standards or a unit test, that every expect react… (from web-everything/web-everything#7190 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/settings/expectations.json:36` — Add a deterministic check, for example in check:standards or a unit test, that every `expect` reaction in we:scripts/settings/expectations.json has a named producer. Alternatively, ship rows with no producer as disabled until one exists.
2. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:78` — Add a `readExpectationSettings` test with a corrupt `we:scripts/settings/expectations.json` that asserts `valid:false`. Longer term, derive the taint match from the feature file name instead of a hand-written regex.
3. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:225` — Add a terminal PR with a failing `emitEvent` case to the retire tests. Assert that state retains the PR and that `incomplete` is true.
4. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:112` — Compare `dev:ino` of existing files in addition to canonical strings. Optionally require scratch paths to sit under a temp-dir prefix.
5. `we:docs/agent/testing.md:5640` — Split the paragraph by component. Optionally add a doc-vs-code check for 'at most once' claims.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7190@ce7d30a87a886fda34d596b48c951bd24da5d1eb

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
