---
kind: story
status: open
size: 5
dateOpened: "2026-11-02"
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
tags: [prevention, security]
---

# Prevent unclassified daemon-clone Git targets and mutations

Track the guard prevention work requested by the advisory on web-everything/web-everything#6262 at head `e70d38e16b31b1984632d24f3ae4617998467477`. This files the prevention obligations; it does not change guard behavior or overturn the supplied operator rulings, including the `not-real` ruling on the HOME finding.

## Design

Classify Git subcommands as read, write or ambiguous for protected daemon-clone targets. Prefer denying commands without a known read classification, with argument-sensitive handling for read/write commands such as symbolic-ref and reflog. Keep the broader inventory separate from the existing mutator list used for other guard policies.

Audit wrapper directory effects and environment scope through the existing tokenizer, canonical command parser and decision wiring. Unsupported directory-changing wrapper options must retain an unknown target or fail closed. Compound constructs must retain possible GIT_DIR/GIT_WORK_TREE values instead of silently dropping them.

The advisory also owes deterministic coverage of earlier HOME assignments for global -C, --git-dir and --work-tree targets. First establish the supported shell semantics and the reason for the supplied `not-real` ruling. Pin those semantics with injected hook HOME distinct from shell-local HOME. If an authorized behavior change is needed, pass effective HOME consistently into target normalization and fetch-config reads; do not silently supersede the operator ruling.

## Advisory obligation map

The advisory's `codex-correctness` panel reports `prevention-outstanding`. Its HOME prevention request is filed here as A4; filing it does not assert that the disputed behavior is a confirmed defect. This card stays open until its executable acceptance criteria are delivered.

Prevention receipt for the advisory posted **2026-11-03T04:01:53Z**, `codex-correctness/correctness` at `we:scripts/guard-bash.mjs:1975`: “Add a deterministic parameterized regression test covering earlier HOME assignments for -C, --git-dir, and --work-tree, and pass the tracked effective HOME into normalization.” A4 below owns that request, including the required reconciliation with the current `not-real` ruling. Filing this receipt does not claim that the tests or runtime change have shipped.

| Advisory finding | Filed prevention |
| --- | --- |
| correctness/correctness — unclassified Git mutators | A1 command inventory and classification |
| security/coverage — wrapper directory effects | A2 wrapper table |
| security/coverage — compound environment changes | A3 scope and hook tests |
| security/coverage — incomplete mutator denylist | A1 command inventory and classification |
| codex-correctness/correctness — earlier HOME assignments | A4 deterministic HOME matrix and normalization consistency |
| correctness/claim-accuracy — stale residual prose | [xp6262r](xp6262r-reverify-pr-residual-claims-against-final-diff.md) |

## Acceptance

- [A1] Executable — a deterministic Git-command inventory test fails for an unclassified command, including a synthetic newly introduced command. Cover update-index, bisect, sparse-checkout, maintenance, replace, symbolic-ref writes, submodule update, reflog expire and filter-branch. Read controls remain allowed.
- [A2] Executable — a parameterized wrapper table covers every wrapper peeled by canonicalCommand, including env -C / --chdir and sudo -D, proving its directory effect is carried or refused. Unknown path-taking options cannot establish a safe target.
- [A3] Executable — named decision and hook tests cover an export inside a function body and a loop/if branch preceding a Git mutation, plus read controls and child-scope isolation.
- [A4] Executable — a named parameterized regression, `DENIES tilde targets after an earlier HOME assignment`, covers -C, --git-dir and --work-tree where the supported semantics require denial. Include separated/equals spellings, earlier assignments/exports, quoted literal tilde, unset/unknown HOME, assignments after the command and read controls. Record the operator-ruling reconciliation before changing behavior.

### A4 deterministic fixture and wiring

Use distinct injected hook HOME, shell-local HOME, lane and protected-clone roots. Cross earlier bare assignments and exports with `-C <path>`, `--git-dir <path>`, `--git-dir=<path>`, `--work-tree <path>` and `--work-tree=<path>`; Git's `-C` takes a separate argument. Include quoted and concatenated assignment values, conditional assignments and child shells. Assert the effective target at the decision boundary and through hook JSON input, with a harmless read command as the control. Keep candidate mutation strings inert.

Distinguish unquoted `~/...` expansion from a quoted literal tilde and from `$HOME` / `${HOME}` expansion. An assignment after the Git invocation cannot affect its target. Unset, relative or unresolved effective HOME must exercise the unknown-target path where expansion requires HOME. Give each case an explicit shell-semantics expectation rather than applying the advisory's denial expectation to literal paths. Fixtures must not depend on the developer's HOME or alter it without restoration.

If the reconciled semantics require tracked HOME, carry the same effective value through global target options, GIT_DIR/GIT_WORK_TREE normalization and persisted fetch-config reads. Add a fetch-reader assertion so target protection and the configuration subprocess cannot resolve the same tilde spelling differently. Preserve possible earlier HOME values after conditional or refused assignments. Record the current `not-real` ruling alongside the test expectations; do not describe this prevention filing as a completed runtime fix.

## Non-goals

- Execute candidate shell commands or Git mutations against a resident daemon clone.
- Change unrelated guard policies, clear human review, or treat advisory findings as an operator verdict.

## Edge cases

- Untrusted text — cover quoted/concatenated shell words, escaped literals, relative paths and unresolved expansions without evaluating substitutions.
- Truncated reads — a command inventory that cannot be read completely must fail with a named reason.
- Shared state — use injected environment values and isolated fixtures; restore any process environment modified by tests.
- Fail closed — unknown commands, wrapper directory effects and unresolved targets cannot prove a protected mutation safe.
- Identity scoping — test registered roots, lane targets and unrelated directories independently.
- State over time — preserve assignment order, conditional alternatives and function/subshell scope.
- Who wrote it — candidate command text is data; never execute it to discover targets.

## Test and proof plan

Run the focused guard test file through the admitted unit-test command. Demonstrate each new regression on the pre-change implementation before repairing that behavior, except where the current ruling already establishes a non-defect; record that case explicitly. Verify decision-level cases and the real hook JSON boundary using temporary registry fixtures. The final gate must report the affected tests and whether each new regression discriminates with the source change reverted.

Source: advisory posted 2026-11-03T04:01:53Z on PR #6262, correctness/correctness, security/coverage and codex-correctness/correctness prevention requests. The two mutator-classification requests share A1.
