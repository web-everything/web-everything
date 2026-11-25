---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/daemons-render.test.mjs", "we:scripts/operations/daemons-render-io.mjs", "we:scripts/operations/daemons-render.mjs", "we:scripts/operations/__tests__/daemons-render-io.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a table-reader injection to main (like installedReader) and a test asserting the 'missing fro… (from web-everything/web-everything#7491 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/daemons-render.test.mjs:214` — Add a table-reader injection to `main` (like `installedReader`) and a test asserting the 'missing from table:' line and exit code 1; a changed-line mutation or branch-coverage gate on scripts/operations would catch the class.
2. `we:scripts/operations/__tests__/daemons-render.test.mjs:201` — Have the card template mark each acceptance item as either a named test or an explicit post-install verification step with an owner.
3. `we:scripts/operations/daemons-render-io.mjs:72` — Throw a dedicated code such as `PLIST_NOT_INSTALLED` that only the lstat branch can produce, and add a test where exec throws an ENOENT-coded error for a present plist.
4. `we:scripts/operations/daemons-render-io.mjs:98` — Let `main` accept an injected table reader and add a `--check` case asserting the `missing from table:` line and exit code 1. File a review rule that each CLI report category has an assertion through the CLI.
5. `we:scripts/operations/daemons-render-io.mjs:70` — Add `readInstalled` cases with a dangling symlink and with a non-ENOENT stat error (for example, `LaunchAgents` being a regular file gives ENOTDIR), each asserting the original error propagates. A mutation-check lens on guard comments would cover the class.
6. `we:scripts/operations/__tests__/daemons-render.test.mjs:201` — File a post-install verification step on the card, recording the first sweep's result for fui#59, and have the card template separate live-verification criteria from test-backed ones.
7. `we:scripts/operations/__tests__/daemons-render.test.mjs` — Add a deterministic integration test using a fixture equivalent to fui#59 and assert advisory:accepted is added and review:awaiting-advisory removed after one sweep.
8. `we:scripts/operations/__tests__/daemons-render.test.mjs` — Extend the named CLI test with a table missing one sibling, assert its diagnostic and failure status, and make filesystem write calls fail the test.
9. `we:scripts/operations/daemons-render-io.mjs` — Add deterministic readInstalled tests for lstat EACCES and a dangling symlink, asserting neither is converted to ENOENT.
10. `we:scripts/operations/daemons-render.mjs` — Add a deterministic two-gap fixture with reverse insertion order and assert the complete ordered result.
11. `we:scripts/operations/daemons-render-io.mjs:74` — Add a deterministic regression test injecting an ENOENT subprocess error with an existing plist, and distinguish confirmed absence with a dedicated error marker.
12. `we:scripts/operations/__tests__/daemons-render.test.mjs` — Add a deterministic scheduled-pass integration test with mocked GitHub writes asserting both label changes after exactly one sweep.
13. `we:scripts/operations/__tests__/daemons-render.test.mjs` — Extend the named CLI test with an incomplete table fixture, assert the missing pass and summary count, and assert that filesystem write entry points are never called.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7491@f86ee21aed319aaa464d4935ed9b9051803f9d22

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
