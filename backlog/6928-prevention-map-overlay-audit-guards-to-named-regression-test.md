---
bornAs: xql6q2b
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/", "we:scripts/lib/__tests__/", "we:scripts/check-standards-rules.mjs", "we:backlog/6936-follow-up-overlay-review-named-test-mappings.md", "we:backlog/5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: map overlay audit guards to named regression tests

PR #5809 review found guard guarantees without named tests. Add a scoped check that maps each audit-fix guard to a named behavioral test and reports missing references for new fails-closed or never claims. Enumerate fallback-* alert kinds in we:scripts/lib/daemon-rebuild/smoke.mjs and require a failing-smoke test for each fallback branch, including planA2 and planB. Cover we:scripts/lib/daemon-rebuild/plan.mjs, we:scripts/lib/daemon-rebuild/smoke.mjs and we:scripts/lib/daemon-rebuild/adopt.mjs. The repair adds the immediate content-free-pin, lost-overlay fallback, force-pushed-ready and instruction-length tests; the automated coverage check remains owed.

## Acceptance

- [A1] **Executable** — Add a fixture-based standards check: a new audit guard or fails-closed/never claim with no named test reference must fail; the same fixture with a valid behavioral-test reference must pass. Run it in the normal diff-selected verify gate.
- [A2] Enumerate smoke fallback alert kinds and require named failing-smoke cases for planA2 and planB, including loss of a carried overlay. Reject missing or stale test names.
- [A3] Document which references are behavioral regression pins and which have verified revert-red evidence. Existing guards must not be weakened to obtain proof.

PR #5809 review follow-up (2026-10-22): A1 must also require one named test per conjunct of a compound admission refusal predicate, with its other conditions satisfied. Until the checker exists, the review lens must ask which named test breaks if each fails-closed or never guard is removed. The direct behavioral cases below exercise the checker itself; the card-mapping fixtures in `we:backlog/6936-follow-up-overlay-review-named-test-mappings.md` A3 only check that these mappings are present and cannot substitute for these cases.

### Planned behavioral tests for the coverage checker

All cases below are planned in `we:scripts/lib/__tests__/overlay-review-test-mappings.test.mjs`; they are not implemented or claimed passing by this card. Invoke the coverage checker on isolated source, test-file, mapping and evidence fixtures, and assert its result and diagnostics, rather than searching this card for case names. Each refusal case starts from an otherwise valid fixture and changes only the named input.

| Acceptance | Named case | Observable assertions |
| --- | --- | --- |
| A1 | `rejects an audit guard without a behavioral test reference` | Parameterize a new audit guard, a fails-closed claim and a never claim. For each, the checker fails and identifies the unmapped guard or claim; a test that only asserts mapping presence does not satisfy behavioral coverage. |
| A1 | `accepts a resolved behavioral test reference` | Supply a repository-qualified test file containing the exact named case with an assertion exercising the guard's refusal. The checker resolves that case, reports behavioral coverage and passes without missing-reference diagnostics. |
| A1, A2 | `rejects a deleted behavioral test reference` | Start with a resolvable case, delete its fixture test file while retaining the mapping, and assert failure naming the missing file and affected guarantee. Repeat with only the named case deleted from a readable file; it fails with the missing case identified. |
| A1, A2 | `rejects a renamed behavioral test reference` | Rename the fixture case but leave its mapped name unchanged; the checker fails with the stale name identified. Updating the mapping to the new exact name restores acceptance. |
| A1 | `requires coverage for each refusal conjunct` | Model planner-ok, candidate-applied-unpinned and no-established-loss conditions. Omit each conjunct's coverage in turn, leaving the others mapped; each run fails naming that conjunct. Cases that falsify several conditions together are insufficient. Pass only with one case isolating each false condition while the other conditions hold, including separate absent-candidate and pinned-candidate cases. |
| A1, A2 | `refuses unreadable coverage inputs` | Inject read failures for source, mapping data, referenced test files, documentation claims and supplied evidence in turn. Each run fails with the input identified and never turns an unreadable file into an empty set of guards, fallbacks or tests. Explicitly absent optional mutation evidence remains behavioral-only, as covered by A3. |
| A1, A2 | `refuses incomplete coverage inputs` | Mark a diff, test-file read or fallback-source read as truncated in turn. Each run fails with an incomplete-input diagnostic, including when the visible prefix contains valid mappings; none certifies coverage from the prefix. |
| A1 | `treats coverage references as data within the reviewed repository` | Supply references containing quotes, backticks, newlines, leading options, traversal and Unicode lookalikes. Assert no command execution; require exact case-name resolution and reject file references escaping the repository or mappings to a different guard family. Valid literal names inside the allowed repository still resolve. |
| A2 | `rejects an unmapped smoke fallback` | Enumerate fallback-* alert kinds from a source fixture containing planA2 and planB, plus a new fallback branch. Remove each branch's failing-smoke case mapping in turn and assert failure naming the omitted branch; sharing an alert kind does not collapse distinct branches. A success-only smoke case cannot cover a fallback, and planA2/planB each require the carried-overlay-loss refusal case. |
| A2 | `accepts complete smoke fallback coverage` | Provide resolvable failing-smoke cases for every enumerated branch, including planA2 and planB carried-overlay-loss refusals. Assert the exact discovered branch set and acceptance; the new fixture branch must be included without updating a hard-coded allowlist. |
| A3 | `distinguishes behavioral coverage from verified mutation evidence` | A resolved behavioral case without mutation evidence is reported as behavioral-only. A matching record with baseline green, guard-reverted red and restored green is classified as verified revert-red. Missing, failed, stale or mismatched run/guard/test/revision records never receive that classification; a supplied but unreadable record fails per A1. Assert both classifications and their evidence references; never remove production guards to construct these fixtures. |
| A1 | `runs coverage validation in the diff-selected verify gate` | Through the normal gate entry point, a diff adding an unmapped guard selects the checker and fails with its diagnostic. Adding the valid behavioral mapping makes the same gate fixture pass; do not invoke only the checker helper. |

Prevention owed from PR #5809's 2026-10-22 review: extend the deterministic acceptance-mapping gate tracked by `we:backlog/5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md` to require a promised operation, fixture input and observable result for each mapping. Reject structural gaps; review that each assertion exercises its operation. A fixture that checks whether this table exists is not behavioral evidence for reference resolution, fallback discovery or evidence classification.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to overlay planning, credential authorization, or branch-coverage thresholds across unrelated tooling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Parse file paths and test names as data; never execute reference text or shell fragments.
2. **Truncated reads** — Report unreadable or incomplete diff/test data rather than certifying coverage.
3. **Shared state files** — n/a: the check reads the checkout and writes no shared state.
4. **Fail closed** — Missing, renamed or unresolvable test references fail the scoped guard check.
5. **Identity scoping** — Restrict references to the repository and changed guard family under review.
6. **State over time** — A renamed/deleted test must invalidate its guard reference on the next gate run.
7. **Who wrote it** — A textual claim alone is not evidence; resolve the named test and retain the trusted gate's result.
