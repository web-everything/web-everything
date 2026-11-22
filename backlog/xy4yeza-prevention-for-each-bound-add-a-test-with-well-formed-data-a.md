---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog-move/cli.mjs", "we:scripts/backlog-move/__tests__/reconcile.test.mjs", "we:scripts/backlog-move/manifest.mjs", "we:scripts/backlog-move/__tests__/cli.test.mjs", "we:scripts/backlog-move/__tests__/manifest.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — For each bound, add a test with well-formed data at the limit (999 or 1000 valid entries, the 129… (from web-everything/web-everything#7312 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog-move/cli.mjs:101` — For each bound, add a test with well-formed data at the limit (999 or 1000 valid entries, the 129th call, the oversize manifest) that asserts action 'stop' and a message naming the bound. A deterministic route is a mutation-check step in heavy-admission that perturbs numeric literals in we:scripts/backlog-move/cli.mjs.
2. `we:scripts/backlog-move/cli.mjs:5` — Doc note: reword the header to 'ambient gh identity; App token enforced in slice 3 via assertWriterToken'.
3. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:93` — Make the harness `run` throw on any git subcommand outside an explicit allowlist (rev-parse, ls-tree, show) and any binary other than git or gh. This turns the read-only claim into a deterministic test.
4. `we:scripts/backlog-move/cli.mjs:62` — Hoist the limits into named exported constants and add one parametrised test per bound that feeds just-over-limit input and expects a throw or stop. A lint rule requiring a test reference for each `Bound exceeded` message would catch the class.
5. `we:scripts/backlog-move/cli.mjs:38` — Add a test with WE_GH_APP_TOKEN=ghs_ and GH_TOKEN=ghp_ that expects a throw or an env that forces GH_TOKEN to the validated token. Add this to the slice-3 gate list so the writer must inject the returned token.
6. `we:scripts/backlog-move/cli.mjs:4` — Doc note only: when a requirement moves between slices, grep the changed files for its keyword (here 'App-token') before pushing.
7. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:105` — Add a deterministic test named 'plan and status invoke only local read-only Git commands' in we:scripts/backlog-move/__tests__/reconcile.test.mjs, with the harness rejecting every command outside the explicit read-only allowlist.
8. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:115` — Make the harness reject unknown binaries and Git subcommands, and add a named negative test proving a mutating command is rejected.
9. `we:scripts/backlog-move/manifest.mjs:17` — Add parameterized negative tests for invalid UTF-8 and block or continued identity values, and require those tests in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7312@002c8763a991220d3465f5e80b722f665d1011ee

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
