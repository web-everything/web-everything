---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/split-blocks-catalog.mjs", "we:tools/blocks-loader/__tests__/blocks-loader.test.mjs", "we:scripts/__tests__/split-blocks-catalog.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a CI-run splitter suite asserting output bytes, unchanged mtimes on rerun, preservation of unrelated e… (from frontier-ui/frontierui#58 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/split-blocks-catalog.mjs:10` — Add a CI-run splitter suite asserting output bytes, unchanged mtimes on rerun, preservation of unrelated entries, and default versus --keep removal.
2. `we:tools/blocks-loader/__tests__/blocks-loader.test.mjs:45` — Add a CI integration test that builds the site and compares generated block routes with the preserved catalog fixture.
3. `we:tools/blocks-loader/__tests__/blocks-loader.test.mjs:37` — Make the named test deterministically supply reversed directory enumeration and assert ascending ids; verify that removing .sort fails it.
4. `we:scripts/split-blocks-catalog.mjs:55` — Require a spawned-CLI test for any scripts/*.mjs that writes files from untrusted-shaped input. A check:standards rule could flag scripts that call writeFileSync with a path derived from parsed JSON and have no test referencing them.
5. `we:scripts/split-blocks-catalog.mjs:29` — Add a lint rule for `execFileSync('git', [...])` calls whose argv contains CLI-derived values without a `--end-of-options` or ref-shape check. Alternatively, validate the ref with `git rev-parse --verify --end-of-options`.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#58@a761c544c919a7b77a97ef58e3ac229aecded49b

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
