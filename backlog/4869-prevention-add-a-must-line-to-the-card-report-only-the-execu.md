---
bornAs: xo5aobv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4793-a-load-cap-hold-that-lasts-over-30-minutes-raises-a-health-a.md", "we:scripts/lint-backlog-placeholders.mjs", "we:scripts/__tests__/lint-backlog-placeholders.test.mjs", "we:.githooks/pre-commit", "we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "c7ac9c95d3b69c93f19836cf2baf711c179b54f5"
tags: []
---

# Prevention — constrain load-hold process reporting and reject unfinished new cards

Preserve both prevention obligations from chalbert/web-everything#3360: require basename-only process identities in the load-hold alert contract, and block newly added backlog cards that retain unresolved authoring placeholders at commit time.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3360@63cc14644147dbd2ab7cdac57970df7b0a99ef5a

## Progress

- Original premise/scope: two review requests cited lines 13 and 14 of we:backlog/4793-a-load-cap-hold-that-lasts-over-30-minutes-raises-a-health-a.md, but scope contained only that card. The requests were a basename-only Must line with a sentinel-secret test and a hook or markdown lint rejecting unfinished new cards.
- Corrected premise: commit e94dd20dc prepared that card after its original commit 63cc14644. Its current Design step 3 explicitly permits redacted/truncated commands, and its Test plan mentions redaction rather than omission of every argument. Cite those named sections instead of the stale line references. The goal is not delivered: redaction is weaker than a prohibition on argv.
- Source evidence: we:scripts/operations/host-process-sample.mjs `readProcessSample` reads full command lines and `processSnapshotMetrics` persists redacted command text. This is existing telemetry, not proof of a basename-only load-hold alert. No `loadHoldAlert` occurrence was found in we:scripts/conveyor/tick-core.mjs or we:scripts/conveyor/driver-status.mjs. Runtime alert implementation remains with the original card.
- Source evidence: we:scripts/backlog/scaffold.mjs `renderItem` deliberately emits an unfinished digest, executable acceptance placeholder and `GUARD_RELAXATION_HINT`; we:scripts/backlog/__tests__/scaffold.test.mjs pins that scaffold behavior. we:.githooks/pre-commit currently runs Git identity validation, locus lint and staged inventory generation, without a placeholder check. we:scripts/lint-locus-prefix.mjs supplies a staged-file enumeration precedent, but its corpus and purpose differ.
- Corrected scope adds a dedicated staged markdown linter and hook wiring, each with a planned matching test. The original card edit is a contract clarification, not runtime implementation. Scaffold generation remains usable for work in progress; rejection happens when a new card is staged for commit.

- Revalidation: the earlier scope already contains the five required implementation/document/test files; retain it. The earlier hook description omitted the identity gate now present at we:.githooks/pre-commit:15; preserve it alongside locus at line 17 and inventory at line 32. The existing staged precedent at we:scripts/lint-locus-prefix.mjs:95 enumerates ACMR paths and reads working-tree files; reuse its purpose, not its newline parsing or content source.
- Current scaffold evidence: we:scripts/backlog/scaffold.mjs:168–181 emits the digest, shared task agreement, hints and edge cases. we:scripts/backlog/task-agreement.mjs:56–57 adds acceptance and non-goal placeholders; we:scripts/backlog/edge-case-classes.mjs:42–43 adds edge-case placeholders. Test all of these, including a supplied digest with unfinished body. No dedicated placeholder linter or matching hook test exists in this checkout; the goal remains undelivered.
- Size remains 3: expected changed lines are approximately 20 in the alert contract, 130 in the new linter, 180 in its tests, 3 in the hook and 100 in hook/contract tests (five scoped files, roughly 433 lines). This is a story, so no estimatedLoc field is added. Existing preparation stamps are left for the runner to replace; this pass does not stamp.

## Design

1. Update we:backlog/4793-a-load-cap-hold-that-lasts-over-30-minutes-raises-a-health-a.md consistently across Design, Test plan and Done when: **Must report only executable basename, PID, RSS and CPU% as process details; never report argv, even redacted argv.** Existing duration, measured admission reason, sample availability and derived ownership labels remain alert metadata. Classification may inspect command text transiently, but projected alert rows, notes and durable status must omit it. If executable identity cannot be obtained reliably, report it unavailable rather than falling back to command text. Require a fixture process with an ordinary positional sentinel secret, not merely a credential-shaped flag, and assert its absence from every alert surface. This item changes the contract; the original card owns that runtime test and implementation.
2. Add we:scripts/lint-backlog-placeholders.mjs with a pure body detector and a small staged CLI. Inspect only newly added direct markdown children of we:backlog/ in the index, using NUL-delimited Git enumeration and indexed blobs. Ignore modified existing cards and other files. Never read working-tree text as a substitute for staged content. Use added paths from `git diff --cached --no-renames --name-only --diff-filter=A -z` (including rename destinations newly introduced to the corpus), then read each indexed blob by argv-based Git invocation. Git enumeration/blob-read failures must fail the check with a diagnostic. Use a 10-second timeout and 8 MiB output cap per Git child; timeout/overflow refuses with an instruction to reduce the staged batch or repair the index and retry, never to bypass the gate. Exit 0 when clean/no candidates, 2 for findings, 3 for incomplete evidence; sanitize diagnostic control characters and do not print card bodies.
3. Reject unresolved authoring lines containing the standalone uppercase marker TODO outside fenced code, inline code and Markdown blockquote examples, and reject the exact unmodified `GUARD_RELAXATION_HINT` imported from we:scripts/backlog/scaffold.mjs. Detect the digest and executable placeholders emitted by `renderItem`; report path, line and reason without modifying files. Historical discussion of the marker in quoted/code examples must remain possible; ordinary prose describing future work without an authoring marker is allowed. Keep the detector specific to unfinished content, not a generic ban on discussing placeholders.
4. Wire the CLI directly into we:.githooks/pre-commit after locus and before inventory with the existing fail-fast convention. The CLI defaults to staged-only inspection of the current Git repository; imports expose the pure detector without running Git. Preserve the identity guard before locus. No new package script, dependency or full-corpus sweep is necessary. Preserve the existing hook gates and their exit-code propagation.

## MVP

- Strengthen the original alert card's contract and sentinel-test requirement without changing admission or shared telemetry behavior.
- One staged-only placeholder check, automatically invoked by the existing pre-commit hook, with actionable diagnostics.
- Source/test pairs: we:scripts/lint-backlog-placeholders.mjs → we:scripts/__tests__/lint-backlog-placeholders.test.mjs; we:.githooks/pre-commit → we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs. Both tests are planned new files. Add a contract assertion in we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs that checks the original card contains the basename-only Must, unavailable fallback and positional-sentinel requirement and no redacted-command allowance. Runtime coverage remains owned by the original card.

## Test plan

- In we:scripts/__tests__/lint-backlog-placeholders.test.mjs, cover both actual `renderItem` placeholder variants (with and without a supplied digest), the exact imported hint, unresolved authoring lines, and a complete card. Permit fenced/inline/Markdown blockquote examples and words merely containing the marker. Pin line-number diagnostics and multiple findings.
- Use temporary Git repositories and staged blobs to prove a new unfinished card fails, a finished card passes, existing-card edits and unrelated files are ignored, and working-tree fixes cannot hide unfinished staged text. Cover the inverse mismatch, spaces in paths, no staged candidates, and Git/read failures, timeout and oversized Git output. Build fixtures under the task TMPDIR; seed existing paths through a temporary index/tree without committing. Do not commit test fixtures or touch the user's index.
- In we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs, execute the real hook with controlled command shims: verify the new linter is invoked, its nonzero exit propagates, later commands do not mask failure, and identity, locus and inventory gates still execute in order on success, with each earlier failure propagated. Include an integration case using the real new CLI and staged blobs, shimming only unrelated gates; command shims alone do not prove enforcement. This tests hook execution rather than just matching its text.
- Review the original card for any remaining permission to display command arguments, and ensure its future test checks a positional sentinel across planner output, runner persistence and formatted status. Basename-only behavior must not be claimed implemented by this documentation change.

## Acceptance

Each named regression below is a planned test, not a claim that the behavior exists. Execute the focused files through the host heavy-run queue. Each regression must fail an assertion against the old hook/card and pass after implementation; paired success cases protect permitted inputs.

- [A1] **Executable** — we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs test `requires basename-only alert contract` checks the Must, unavailable identity fallback, positional sentinel across planner/notes/persisted/formatted output, and removal of argv/redacted-command permission from we:backlog/4793-a-load-cap-hold-that-lasts-over-30-minutes-raises-a-health-a.md. It fails against today's contract and passes after the documentation change; it does not claim runtime secrecy.
- [A2] **Executable** — we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs test `rejects unfinished new cards and accepts completed cards` runs the real hook/CLI on indexed fixtures generated by `renderItem`, with and without digest, and isolates each digest/acceptance/non-goal/edge-case marker and exact guard hint. The unfinished fixture currently exits zero under successful unrelated gates; after wiring it exits 2 with path, line and reason. Completed cards and fenced, inline-code and blockquote examples pass. we:scripts/__tests__/lint-backlog-placeholders.test.mjs pins standalone matching, exclusions and multiple diagnostic locations.
- [A3] **Executable** — we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs test `checks indexed additions only by default` pairs an unfinished index/finished worktree (must reject, currently passes) with the inverse (must pass), existing-card edits, unrelated/nested paths, spaces, rename destinations, an unborn repository and no candidates. we:scripts/__tests__/lint-backlog-placeholders.test.mjs exercises the same indexed-blob selection through the CLI; no fixture may modify the user's index.
- [A4] **Executable** — we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs test `refuses incomplete placeholder evidence` injects enumeration/read errors, timeout and output overflow specifically at the placeholder Git boundary: old hook never checks this evidence and passes, new hook exits 3 with a sanitized repair/reduce-batch diagnostic, without running inventory or reading worktree substitutes. Mirror these branches in we:scripts/__tests__/lint-backlog-placeholders.test.mjs, including oversized output.
- [A5] **Executable** — we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs test `orders placeholder gate between locus and inventory` asserts identity → locus → placeholder → inventory and nonzero propagation from every gate. Old hook lacks the required invocation and fails this assertion; new hook passes. Existing we:scripts/backlog/__tests__/scaffold.test.mjs remains a compatibility check proving skeleton generation still works; it is not claimed as a red-before regression.

## Proof plan

Run the named tests in we:scripts/__tests__/lint-backlog-placeholders.test.mjs and we:scripts/__tests__/pre-commit-backlog-placeholders.test.mjs plus compatibility coverage in we:scripts/backlog/__tests__/scaffold.test.mjs through the heavy-admission runner at we:scripts/readiness/heavy-admission.mjs (`run -- npx vitest run` with those repository-relative test arguments). The `we:` prefix denotes the repository, not part of a shell pathname.

Author the tests first. Capture the A1 contract assertion and A2–A5 old-hook assertion failures with unrelated gates controlled to succeed. A missing module/test is not before-proof: the before-hook harness must actually execute the original hook and demonstrate its zero exit or missing invocation against the required rejection/order. After implementation, record passing assertions and exit codes, the paired completed-card success, and the original-card diff. Run `npm run check:standards` through the same heavy queue as the implementation gate. If busy, wait once using the queue's supported wait option, then report without polling. The preparation runner owns checks and stamping for this card-only change.

## Follow-ups

- Execute the basename/secret runtime regression as part of the original load-hold implementation, including persisted and rendered output. Do not expand this prevention item into the alert feature itself.
- Broader telemetry command-retention policy, historical-card cleanup, and enforcement for commit paths that bypass local hooks are outside these two review obligations.
