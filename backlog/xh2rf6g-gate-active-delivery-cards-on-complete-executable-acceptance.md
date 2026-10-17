---
kind: story
size: 5
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-delivery-card-contract.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Gate active delivery cards on complete executable acceptance, test mappings and dependency edges

Prevention owed by PR #5505 review: extend we:scripts/check-standards-rules.mjs and we:scripts/check-standards.mjs to reject active-card TODO placeholders, duplicate Acceptance headings or acceptance IDs, A1 without a backticked runnable command, copied n/a edge-case explanations, and Shared state files n/a when a card declares a state-directory write. Require structured behavioral-guarantee mappings to repository-qualified planned test files, named cases and observable assertions, with semantic review for coverage. Lint overlapping active-card scope files lacking a blockedBy ordering path and artifact prerequisites missing a blockedBy edge. Add fixture coverage in we:scripts/__tests__/check-standards-delivery-card-contract.test.mjs. Keep this PR cards-only; implement the lint in this follow-up.

## Acceptance

- [A1] **Executable** — From WE, `npm run test:unit -- check-standards-delivery-card-contract.test` selects we:scripts/__tests__/check-standards-delivery-card-contract.test.mjs by filename filter; it fails before implementation and passes after, covering every named case below through the scoped standards entry point as well as the pure validators.

## Test plan

All cases below are CAPABILITY tests (RED before implementation) in we:scripts/__tests__/check-standards-delivery-card-contract.test.mjs. Use temporary card fixtures; do not mutate the live backlog to demonstrate rejection.

- `rejectsIncompleteActiveAcceptance` — RED; active fixtures with any unfinished placeholder, repeated Acceptance heading, duplicate acceptance IDs (including a prose copy), or A1 lacking a backticked executable command yield file-attributed errors. Reject repository-qualified pseudo-shell paths and explanatory text inside commands; one complete runnable acceptance is accepted.
- `rejectsCopiedEdgeCaseExemptions` — RED; identical normalized n/a reasons on multiple edge-case lines fail, and Shared state files marked n/a fails when an explicit state-directory write is declared. Distinct justified exemptions and concrete handling pass.
- `requiresGuaranteeCaseAndAssertionMappings` — RED; each explicit behavioral guarantee, including idempotent/only/never/read-only claims, must map to a repo-qualified planned test file, named case and observable assertion. Missing any component fails; valid same-file section-level declarations pass. Require semantic review for completeness; token presence alone cannot establish coverage.
- `ordersOverlappingActiveScopes` — RED; active cards sharing a repo-qualified scope file or overlapping directory prefix fail without a direct/transitive blockedBy ordering path. Ordered overlaps and equal paths in different repos pass; report cycles and unresolved prerequisite IDs without hanging.
- `requiresArtifactPrerequisiteEdges` — RED; a declared consumed artifact from another card requires a blockedBy path to that producer, while a producer merely naming downstream consumers does not. Define structured artifact references rather than guessing dependency direction from arbitrary prose.
- `scopedStandardsReportsAllContractFailures` — RED; invoke the real standards entry point with local fixture scope and assert nonzero exit and attributed diagnostics for each rejected class; valid fixtures pass. Scoped graph checks must still load prerequisite metadata outside the selected file set and flag an overlapping unselected active card.

## Risks

Prose-only inference can produce false positives. Define a structured guarantee/artifact-reference format and a bounded migration policy; scope deterministic rejection to the specified contract while leaving semantic completeness to review. Do not silently impose a whole-corpus migration on resolved cards.

## Non-goals

- [N1] No delivery collector/dashboard/digest implementation, automatic card rewrites, queue dispatch or resolved-card migration. This is the single prevention follow-up for the overlapping recommendations in PR #5505.

## Edge cases this change must handle

1. **Untrusted text** — Card text is parsed as data; never execute acceptance commands during lint. Markdown fences, quoting and pseudo-command paths are fixtures in `rejectsIncompleteActiveAcceptance`. No HTTP endpoint is introduced, so network request controls do not apply.
2. **Truncated reads** — Read complete card files and required graph metadata; unreadable/partial frontmatter is an attributed error rather than an empty success (`scopedStandardsReportsAllContractFailures`).
3. **Shared state files** — n/a: this lint reads card metadata and writes no coordination state; fixtures use isolated temporary directories.
4. **Fail closed** — Invalid active contracts and unresolved graph prerequisites fail the scoped gate, with diagnostics (`scopedStandardsReportsAllContractFailures`, `ordersOverlappingActiveScopes`).
5. **Identity scoping** — Compare repo-qualified file paths and card IDs; identical relative paths in distinct repos are independent (`ordersOverlappingActiveScopes`).
6. **State over time** — Keep resolved cards outside the new active-card policy and handle blockedBy chains/cycles deterministically (`ordersOverlappingActiveScopes`, `scopedStandardsReportsAllContractFailures`).
7. **Who wrote it** — n/a: contract checks apply regardless of card author and do not grant authorship or approval authority.
