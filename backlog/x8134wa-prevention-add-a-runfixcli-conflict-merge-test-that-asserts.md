---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a runFixCli conflict-merge test that asserts the git add pathspec excludes we:.fix-evidence.m… (from web-everything/web-everything#7410 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs:1131` — Add a runFixCli conflict-merge test that asserts the `git add` pathspec excludes `we:.fix-evidence.md`. A better fix is to apply the filter once inside `stageLaneFiles`, so one test covers both the merge and non-merge paths.
2. `we:scripts/operations/fix-run.mjs:1131` — Add a runFixCli conflict-merge test that asserts the `stageLaneFiles` path list excludes `we:.fix-evidence.md` when it is among the unmerged paths. A single shared `isStageable` choke point inside `stageLaneFiles` would also make the call-site filter unnecessary.
3. `we:scripts/operations/fix-run.mjs:197` — Run `git reset -q -- we:.fix-evidence.md` (or `git rm --cached --ignore-unmatch`) before each launcher commit, or assert after staging that `git diff --cached --name-only` does not contain the file.
4. `we:scripts/operations/fix-run.mjs:1135` — Add the named orchestration test and a deterministic mutation check that removing the final filter makes it fail.
5. `we:scripts/operations/fix-run.mjs:192` — Gate changes with the named lifecycle test asserting that evidence remains present and readable after the run.
6. `we:scripts/operations/fix-run.mjs:1135` — Add the named conflict-merge regression test to the automated suite, asserting that root evidence is excluded from git staging while another resolved file is included.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7410@511dfb216a967c4d8ba018ac658b2dfadcfa9e22

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
