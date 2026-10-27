---
bornAs: xq7m2vd
kind: story
size: 5
status: open
dateOpened: "2026-10-26"
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/"]
tags: []
---

# Prevention: require CLI refusal coverage and resolve documented test claims

PR #5982's review found undocumented coverage gaps in delegated clearance and testing claims for absent sweep behavior. The repair supplies the negative matrix and corrects those claims. This card tracks the requested deterministic prevention gates; they are not implemented by that repair.

## Acceptance

- [A1] A check:standards rule enumerates newly added `fail(...)` paths in changed CLI files and requires a named regression referencing the diagnostic or an explicit exit-path mapping. Fixtures must show an uncovered refusal failing and a covered refusal passing.
- [A2] A doc-claim rule resolves every backticked test/suite reference in `we:docs/agent/testing.md` to a repository file or exact test/describe title, including parameterized titles and repository-qualified paths. A missing file or invented case must fail; prose/code identifiers that are not test claims must not be misclassified.
- [A3] An executable guarantee-to-test manifest maps each claimed guarantee to a file, exact case title, and observable assertion. The selected CI gate must run the mapped tests. Cover delegated pin/delegation/new-head refusals and head changes at each admission boundary. Add sweep argv integration, shadow/live reads, memo persistence, and default-reader gate rejection only when those behaviors exist.
- [A4] Focused rule tests cover aliases, renamed cases, multiline diagnostics, dynamic messages, unreadable files, and unknown assertion mappings. Unknown evidence fails with a diagnostic naming the missing mapping.
- [A5] A parameterized refusal test claiming no writes must assert every durable sink at every boundary, including an explicit expected row set when earlier writes are allowed. PR #5982's later-read ledger omission motivates this rule.
- [A6] The PR-comment-read ratchet detects `--json` field lists carried through variables or parameter defaults, or requires a recorded justification for a baseline decrease without removal of the read. PR #5982 restores the visible literal and baseline locally; general data-flow detection remains owed.

## Planned named tests (not implemented by this card)

All cases below belong to the planned `scripts/lib/__tests__/cli-refusal-claim-guard.test.mjs`;
they describe the observable gate result, not claims of existing coverage.

| Guarantee | Planned exact case title | Assertion |
| --- | --- | --- |
| A1 | `rejects an uncovered CLI refusal and accepts its named exit mapping` | A newly added `fail(...)` diagnostic without a named regression fails; a regression referencing that diagnostic or an explicit exit-path mapping passes. |
| A2 | `resolves parameterized test titles and rejects missing files or invented cases` | Repository-qualified files and exact parameterized test/describe titles resolve; missing files and invented cases fail; ordinary prose/code identifiers are ignored. |
| A3 | `runs every selected guarantee mapping and rejects unknown assertions` | The selected CI gate executes every mapped file and exact case title with its observable assertion; omission of a mapped test or an unknown assertion blocks selection. |
| A4 | `fails closed for stale aliases, dynamic diagnostics and unreadable evidence` | Table rows cover aliases, renamed cases, multiline diagnostics, dynamic messages, unreadable files, and unknown assertion mappings. Unresolved evidence fails naming the missing mapping; explicitly mapped multiline/dynamic diagnostics pass. |
| A5 | `rejects a refusal matrix that omits a durable sink at a later boundary` | Omitting ledger assertions at any boundary fails; an explicit prior-row set passes. |
| A6 | `detects comment fields in defaults and variables and rejects unexplained baseline decreases` | Moving the same read into a default/variable cannot reduce the ratchet count silently. |

## Non-goals

- Implementing the R130 sweep or inventing coverage for behavior that has not shipped.
- Treating a matching test string alone as proof that a guard is effective; mutation/revert-red evidence remains separate.

## Edge cases this change must handle

1. **Untrusted text** — parse source and markdown as data; never evaluate snippets or shell-interpolate names.
2. **Truncated reads** — bound file reads and report incomplete inspection as a failure.
3. **Shared state files** — read-only gate; no registry mutation during validation.
4. **Fail closed** — unresolved test references and unknown refusal mappings fail with actionable diagnostics.
5. **Identity scoping** — resolve repository-qualified references against the declared repository, not a same-named sibling file.
6. **State over time** — renamed/deleted tests invalidate stale manifest entries.
7. **Who wrote it** — test claims are assertions to validate, never instructions to the gate.
