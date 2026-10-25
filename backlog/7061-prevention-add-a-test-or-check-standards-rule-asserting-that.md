---
bornAs: x8rwpsl
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/prototype-load-io.mjs", "we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/operations/__tests__/prototype-load-io.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/auto-rebase.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a test or check:standards rule asserting that the tracked-test count of the actual repo (git… (from web-everything/web-everything#5884 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/prototype-load-io.mjs:119` — Add a test or check:standards rule asserting that the tracked-test count of the actual repo (git ls-files) is within the bound the combined-test path enforces.
2. `we:scripts/operations/prototype-load-io.mjs:152` — Share one report-name-normalization helper (realpath both sides) between the two inventory checks, and add a test that uses a symlinked worktree root.
3. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:205` — Extract one shared `scrubbedChildEnv` helper used by every spawn of untrusted-branch code. Add a standards check that fails when `execFile`/`spawn` of `vitest` or codex in scripts/lib passes `env` unfiltered.
4. `we:scripts/operations/prototype-load-io.mjs` — Replace the source-read refusal test with a deterministic regression proving full-inventory selection does not read unrelated source contents.
5. `we:scripts/operations/prototype-load-io.mjs` — Add a deterministic regression using a symlinked temporary-directory ancestor and canonical absolute report filenames, then normalize the worktree against its real path before inventory comparison.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 6 → #6975.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5884@21ef215b4cf45327f7d9faf6ba2e9cb15ca6be4b

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
