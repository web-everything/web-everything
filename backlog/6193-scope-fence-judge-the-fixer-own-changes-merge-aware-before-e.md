---
bornAs: xghfadk
kind: story
size: 5
status: closed
closedReason: duplicate
closedInto: "6637"
dateClosed: "2026-10-20"
scope: ["we:scripts/conveyor/fix-scope-fence.mjs", "we:scripts/conveyor/fix-scope-fence-io.mjs", "we:scripts/conveyor/__tests__/"]
dateOpened: "2026-10-17"
tags: []
---

# scope fence: judge the fixer own changes, merge-aware, before enforcing

PR #5461 (2026-10-17) red-team: the scope fence is too strict, too loose, misclassifies some failures, and under-tests. Confirmed findings: (1) too strict: we:scripts/conveyor/fix-scope-fence-io.mjs:72 diffs head against the saved commit, so a catch-up merge from main pulls upstream files in and the push is refused. (2) too loose: we:scripts/conveyor/fix-scope-fence-io.mjs:89 excluding all merge commits lets off-scope edits hidden in merges through. (3) we:scripts/conveyor/fix-scope-fence-io.mjs:94 catch-up merges can conceal re-added identifiers. (4) we:scripts/conveyor/fix-scope-fence.mjs:48 prefix-increment statements bypass the removed-identifier check. (5) we:scripts/conveyor/fix-scope-fence-io.mjs:78 security: identifier fence reads git diff -U0 text, which is empty or altered for binary files and colour output; use plumbing (--no-color --text or object diff). (6) we:scripts/conveyor/fix-scope-fence-io.mjs:35 a moved head is misclassified as transient. (7) we:scripts/conveyor/fix-scope-fence-io.mjs:66 and :67 unexpected cat-file or fatal git errors are treated as a terminal head move. (8) tests: we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs:30 removal markers are not covered through the live adapter. (9) we:scripts/conveyor/__tests__/await-verify-pass.test.mjs:352 has no integration coverage that early, green and salvage pushes enforce the fence. (10) we:scripts/conveyor/fix-scope-fence.mjs:88 a literal # in a filename widens scope to an unrelated directory. (11) we:scripts/conveyor/fix-scope-fence.mjs:88 canonical sibling-repo scope prefixes reject valid repairs. (12) we:scripts/conveyor/fix-scope-fence-io.mjs:192 a backlog-loader failure silently broadens declared scope; it should fail closed to no scope known and warn (operator ruled 2026-10-17 Ok). Goal: compute the fixer own net change as proposed head minus pre-fix head merged with the same upstream base, using a merge-aware tree diff. Switch default to stand-down only after warn-mode data shows a low false-positive rate. Default is warn since 2026-10-17.

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
