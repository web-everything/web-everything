---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:backlog/xq8udcz-pin-lane-cleanup-and-json-error-contracts.md", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — Add a table case for readFile throwing a non-ENOENT code in the markReady tests. A branch-coverag… (from web-everything/web-everything#5839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/codex-job.mjs:298` — Add a table case for readFile throwing a non-ENOENT code in the markReady tests. A branch-coverage threshold on scripts/operations would also catch this class.
2. `we:scripts/operations/codex-job.mjs:34` — Use a Map, `Object.hasOwn(keys, name)`, or `Object.create(null)` for allow-lists, and add an inherited-name case such as `--constructor=x` to the parseArgs rejection table. A lint rule against plain-object allow-list lookups could enforce the first part.
3. `we:scripts/operations/codex-job.mjs:163` — Keep `detail` as one type, or put the appended test output in a separate field. Add a post-repair out-of-scope case that asserts the `detail` shape.
4. `we:scripts/operations/codex-job.mjs:259` — Re-run the index-versus-worktree check (`diff --quiet --exit-code`) after `write-tree` and before `commit`. Add a fixture test whose `write-tree` rule mutates the index. A lint is not practical for this class, so a standing test pattern for 'mutation between check and snapshot' is the cheapest guard.
5. `we:backlog/xq8udcz-pin-lane-cleanup-and-json-error-contracts.md:21` — Gate executable Acceptance items on explicit test-file, case-name, and assertion mappings, including separate mappings for independently exercised seams.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5473, finding 6 → #5473, finding 7 → #5473, finding 8 → #5360, finding 10 → #5668.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5839@d9c8cb3948d17375ee33ddb3a15559526a4c2b1e

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
