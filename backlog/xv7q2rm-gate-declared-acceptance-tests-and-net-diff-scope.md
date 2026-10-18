---
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/"]
dateOpened: "2026-10-18"
tags: [delivery, prevention]
---

# Gate declared acceptance tests and net diff scope before lane exit

PR #5510's 2026-10-18 advisory reported two failing manual-override tests in the card's own acceptance file and three implementation/test paths omitted from its declared scope. Track the requested prevention here, separately from the dispatch repair. The local pre-fix run reproduced both failures (181 passing, 2 failing); this is evidence of the regression, not proof of which checks the previous launcher ran.

## Acceptance

- [A1] **Planned** — Add `runs every test file named by the card acceptance before lane exit` to the affected verify-lane test suite under `we:scripts/__tests__/`. Include the owed-comment and review-dispatch suites named by #6273 even when ordinary diff selection misses one; a named red test must refuse hand-back.
- [A2] **Planned** — Add `rejects a net changed path absent from every declared card scope` to the standards tests under `we:scripts/__tests__/`. Compare the PR's declared base with its head, covering adds, edits, deletions and both rename paths; allow the union of declared card scopes or the lane's single card scope.
- [A3] **Must** — Missing base, malformed scope or unreadable test results refuse with a specific reason. Do not treat an unexecuted test as passing. Bind evidence to the exact tested head and invalidate it after edits.
- [A4] **Must** — Apply path coverage equally to source, docs, configuration, data and test files. Treat acceptance text as data: resolve repository-qualified test paths and pass argument arrays without executing card prose.

## Non-goals

- This card does not implement #6274's post retry or change review policy.
- The caller marker requested by the same advisory is implemented in #6273: the runner supplies `--automated`, while an unmarked CLI invocation preserves the operator override.

## Risks and test plan

Test missing and malformed declarations, unknown repositories, prefix boundary collisions, spaces and shell metacharacters in paths, renamed/deleted files, multiple cards, stale test receipts and failing acceptance suites. Reuse existing diff selection and gate results where possible; establish the current gate behavior before extending it. Add the two named regression cases above and exercise the lane-exit refusal with a deliberately failing fixture.
