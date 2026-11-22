---
kind: story
size: 3
status: open
scope: ["we:scripts/backlog-move/cli.mjs", "we:scripts/backlog-move/__tests__/reconcile.test.mjs", "we:scripts/backlog-move/manifest.mjs", "we:scripts/backlog-move/__tests__/cli.test.mjs", "we:scripts/backlog-move/__tests__/manifest.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — For each guard that throws, require one test that drives the CLI entry point to the refusal. A re… (from web-everything/web-everything#7312 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7312's review (reviewed head `002c8763a991220d3465f5e80b722f665d1011ee`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/backlog-move/cli.mjs:72` — For each guard that throws, require one test that drives the CLI entry point to the refusal. A reviewer checklist item is enough at this slice, since a deterministic gate for 'every throw has a test' is hard.
2. `we:scripts/backlog-move/cli.mjs` — Make bounds named constants and add a table-driven test that exceeds each one. Alternatively, add a lint that flags a numeric limit in a `throw` condition with no matching test.
3. `we:scripts/backlog-move/cli.mjs:143` — When adding a defensive `throw` in the evidence path, add the harness flag in the same commit. A review lens that asks 'which test goes red if this line is deleted?' catches it.
4. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:112` — Add a test that asserts the set of git subcommands used is within {rev-parse, ls-tree, show}. Add a `check:standards` rule that forbids `writeFileSync`, `git fetch` and `git push` strings under scripts/backlog-move until slice 3.
5. `we:scripts/backlog-move/cli.mjs:54` — Write one parametrised test that forces each bound over its limit and asserts it throws or stops. A lint rule requiring a test reference for each `Bound exceeded` message string would catch the class.
6. `we:scripts/backlog-move/cli.mjs:34` — Add cases to the `assertWriterToken` test for `WE_GH_APP_TOKEN` alone, `WE_GH_APP_TOKEN` shadowing a valid `GH_TOKEN`, and an Actions-style `ghs_` token. Add a slice-3 test that asserts the writer entry point calls `assertWriterToken` first.
7. `we:scripts/backlog-move/manifest.mjs:28` — Add `it.todo` entries, or skipped tests that name each finding, in we:scripts/backlog-move/__tests__/reconcile.test.mjs. Add a `check:standards` rule that fails if a write-capable import (`git push`, `gh pr create`, or PUT/POST) appears under scripts/backlog-move without the slice-3 gate-closure marker.
8. `we:scripts/backlog-move/cli.mjs:5` — Doc-note only: update the header to 'ambient gh identity, GET-only'. A deterministic gate is not worth it for this class.
9. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:113` — Make the harness reject every Git invocation outside the explicit read-only command allowlist, and run that regression test in the required test gate.
10. `we:scripts/backlog-move/manifest.mjs:27` — Add YAML-aware identity validation and a regression test asserting exactly one semantic id and formerly key after transformation.
11. `we:scripts/backlog-move/manifest.mjs:22` — Add parameterized refusal tests for both identity keys and each guarded multiline form, and include guard-removal mutation checks in the test gate.

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
