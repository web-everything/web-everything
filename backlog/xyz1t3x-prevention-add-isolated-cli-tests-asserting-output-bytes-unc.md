---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/split-blocks-catalog.mjs", "we:tools/blocks-loader/__tests__/blocks-loader.test.mjs", "we:scripts/__tests__/split-blocks-catalog.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add isolated CLI tests asserting output bytes, unchanged mtimes, unrelated-file preservation, and default… (from frontier-ui/frontierui#58 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/split-blocks-catalog.mjs:10` — Add isolated CLI tests asserting output bytes, unchanged mtimes, unrelated-file preservation, and default versus --keep behavior; run them in the automated test gate.
2. `we:tools/blocks-loader/__tests__/blocks-loader.test.mjs:45` — Gate the migration with a named Eleventy build test asserting the index plus every expected block route.
3. `we:scripts/split-blocks-catalog.mjs:53` — Add a test under tools/blocks-loader/__tests__/ that runs we:scripts/split-blocks-catalog.mjs with --from=<tmp monolith> holding a `../x` id. It should assert a non-zero exit and that no file appears outside OUT. Also add a check:standards rule that every scripts/*.mjs writing to the filesystem has a matching test file.
4. `we:scripts/split-blocks-catalog.mjs:60` — Add a we:tools/blocks-loader/__tests__/split-blocks-catalog.test.mjs case: split the fixture into a tmp OUT twice and assert the second run reports '0 file(s) written', leaves every file's mtime unchanged, and leaves an unrelated pre-existing <id>.json in place. Add a check:standards rule that each Acceptance bullet in a PR's PREP block cites a test name.
5. `we:scripts/split-blocks-catalog.mjs:33` — Reject refs matching /^-/ (or pass `--end-of-options` before the ref). Add a lint/check:standards rule that flags execFileSync('git', [...]) calls that interpolate a CLI-derived value without a leading-dash guard.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#58@e7bf050daf89c227da42a87dfbbf1454f4dea965

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
