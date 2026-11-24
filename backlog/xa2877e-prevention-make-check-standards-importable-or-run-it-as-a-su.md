---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/split-blocks-catalog.mjs", "we:tools/blocks-loader/__tests__/blocks-loader.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/split-blocks-catalog.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Make check-standards importable (or run it as a subprocess against a temp WE root) so a fixture test can c… (from frontier-ui/frontierui#58 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:58` — Make check-standards importable (or run it as a subprocess against a temp WE root) so a fixture test can cover the cross-repo branches. File a card for it.
2. `we:scripts/split-blocks-catalog.mjs:60` — Add a vitest .mjs test that spawns the script with --from=<fixture> against a temp OUT dir (the script needs an OUT override or a cwd-relative root to allow this), and assert the second run reports '0 file(s) written'.
3. `we:scripts/check-standards.mjs:80` — Add a check:standards or write-gate rule: any new allowlist, baseline or KNOWN_* map in scripts/ must have a sibling test that asserts both the pass and the re-arm path. Failing that, extract the weSpecPath resolution into a pure function in scripts/lib/ and test it.
4. `we:tools/blocks-loader/__tests__/blocks-loader.test.mjs:23` — Use the frozen monolith as input to an isolated splitter round-trip test, and gate the live catalog with per-entry invariants instead of equality to historical content.
5. `we:scripts/split-blocks-catalog.mjs:61` — Gate the splitter with isolated filesystem tests asserting write counts or unchanged modification times, retained entries, and source-file existence across default, explicit-source, and --keep modes.
6. `we:scripts/check-standards.mjs:60` — Add a deterministic fixture-driven check-standards test matrix covering split and legacy catalogs, missing and failing loaders, and exact baseline membership.
7. `we:tools/blocks-loader/__tests__/blocks-loader.test.mjs:44` — Gate an isolated Eleventy build with assertions that every catalog id has its expected page and the index exists.
8. `we:scripts/split-blocks-catalog.mjs:10` — Add the named filesystem integration tests to the existing test gate, asserting unchanged bytes and mtimes, preservation of unrelated files, and source-file existence.
9. `we:scripts/check-standards.mjs:58` — Gate the validator with fixture-based subprocess tests for split, legacy, absent, and malformed catalogs, including baseline acceptance, changed-target rejection, and resolved-baseline rejection.
10. `we:tools/blocks-loader/__tests__/blocks-loader.test.mjs:44` — Add a build integration gate asserting the blocks index and exactly one generated route per catalog id.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#58@66d4c572f115ce9906d755c18e37ac40a44225c4

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
