---
kind: story
size: 1
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/run*.test.mjs", "we:scripts/operations/__tests__/file-item-cli.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-10-02"
preparedAgainstSha: "3f130ea59e0ffd5524322915a70a1866235d32ec"
tags: []
---

# file-item prints why the card write was refused instead of only a resume hint

The reported 2026-10-01 filing stopped at the card write after a digest included a bare backlog path. The caller saw only the resume hint and retried with placeholder content, filing a junk card. Preserve the goal: a refused file-item write must explain the refusal, including the offending reference and its repository-prefixed correction, on stderr and exit non-zero.

Current code already renders the refusal and exits 1, but sends the human-readable output to stdout. This item fixes that output channel without weakening the writer's checks.

## Progress

- Original premise/scope: the refusal reason was lost, and the fix belonged in we:scripts/operations/file-item.mjs with we:scripts/operations/__tests__/file-item.test.mjs.
- Corrected premise/scope: we:scripts/operations/file-item.mjs is a pure declaration. Its write sink is reused by we:scripts/operations/file-item-io.mjs from we:scripts/operations/scaffold-io.mjs. The writer in we:scripts/backlog/guarded-write.mjs already throws a detailed locus-prefix error. we:scripts/operations/effect-executor.mjs preserves that error; we:scripts/operations/cli-adapter.mjs (`driveRun`, `renderOutcome`) returns an effect-halted outcome with the reason and code 1. The final CLI handler in we:scripts/operations/run.mjs unconditionally writes the rendered lines to descriptor 1. Change that emission point and add the planned we:scripts/operations/__tests__/file-item-cli.test.mjs. No writer, declaration, or executor edit is needed.
- Observed on 2026-10-02: invoked the actual file-item CLI in this lane with a story, size 1, and a digest containing the unprefixed spelling of we:scripts/operations/file-item.mjs. Temporary OPERATION_RUNS_DIR, OPERATION_CALLS_DIR, and CONVEYOR_QUEUE_FILE isolated bookkeeping and queue effects. Exit status was 1; stdout contained the full locus-prefix reason, offending reference, corrected reference, and resume hint; stderr was empty; the temporary queue file did not exist. Thus the original claim of a missing rendered reason does not reproduce, while the required stderr behavior remains undelivered.
- Existing coverage in we:scripts/operations/__tests__/file-item-io.test.mjs checks writer rejection and absence of a card, but does not invoke the CLI or assert its streams. The child-process fixture pattern in we:scripts/operations/__tests__/run.test.mjs supplies a precedent for the missing CLI coverage.

## Design

At the final output emission in we:scripts/operations/run.mjs, send the existing human-readable lines to stderr when the operation is file-item and its outcome is effect-halted. Keep the existing renderer's complete refusal text and resume information together; preserve its non-zero exit code. Use the returned outcome discriminator rather than matching error text or re-running content validation.

Keep JSON mode on stdout with the existing structured error and exit status. Successful filing, help, other operations, and non-effect stops retain their existing output behavior. This bounds the change to the reported filing failure without making a new shared CLI output policy. The declaration, guarded writer, queue ordering, persisted run, and resume semantics remain authoritative.

## MVP

1. Implement the narrowly conditioned output-descriptor selection in we:scripts/operations/run.mjs.
2. Add we:scripts/operations/__tests__/file-item-cli.test.mjs to exercise the real CLI and real guarded writer in a disposable checkout, with isolated run, call-log, and queue paths.
3. Cover refusal, corrected successful input, and JSON refusal. Reuse fixture setup patterns without changing shared helpers unless a separate scope update is justified.

## Done when

- Must: a human-readable file-item write refusal exits 1 and puts the writer's reason, offending reference, repository-prefixed correction, and existing resume information on stderr. No card or queue addition occurs for the rejected write.
- Must: existing refusal rules remain intact for source, documentation, configuration, and data references recognized by the locus scanner; no bypass or placeholder retry is introduced.
- Must: a corrected digest files and queues normally; JSON refusal remains parseable on stdout with its error and non-zero status.
- Executable regression: run Vitest against we:scripts/operations/__tests__/file-item-cli.test.mjs. Its human-readable refusal assertion must fail on the current stdout-only implementation and pass after the output change.

## Test plan

In the planned we:scripts/operations/__tests__/file-item-cli.test.mjs, launch the copied CLI from a disposable real checkout using the setup pattern in we:scripts/operations/__tests__/run.test.mjs. Point OPERATION_RUNS_DIR, OPERATION_CALLS_DIR, and CONVEYOR_QUEUE_FILE into the fixture, and seed its backlog directory. The CLI resolves its repository by script location, so changing cwd alone is insufficient isolation.

- Parameterize invalid digests using the unprefixed spellings of we:scripts/operations/file-item.mjs, we:docs/agent/conventions.md, we:vitest.config.ts, and we:src/_data/plugs.json. Assert exit 1, stderr containing locus-prefix plus the offending/corrected pair and resume hint, and no human-readable refusal on stdout. Compare backlog contents and queue bytes before/after to prove no mutation.
- Repeat one invalid digest with --json: stdout parses as one JSON value carrying the refusal, exit remains 1, and no card or queue addition occurs.
- Run a fresh invocation with a repository-prefixed digest: assert exit 0, the ordinary completion on stdout, no refusal on stderr, one card, and one queue entry. This is a fresh run because resume retains the original committed input.
- Run the existing we:scripts/operations/__tests__/file-item.test.mjs, we:scripts/operations/__tests__/file-item-io.test.mjs, and we:scripts/operations/__tests__/run.test.mjs alongside the new suite, then the standards gate.

## Proof plan

Capture the real child process's exit status, stdout, stderr, and fixture filesystem assertions. Before implementation, the invalid digest must reproduce the preparation probe: the reason is on stdout and stderr is empty. After implementation, the same invocation must show the complete explanation on stderr, exit 1, and unchanged backlog/queue state. The valid and JSON cases establish that stream routing did not break successful filing or machine-readable callers. Record those results during implementation; preparation has only established the current failure, not delivered a fix.

## Follow-ups

No prerequisite design fork remains. A policy for stderr across all operations or all refusal kinds, and any change to resume guidance for immutable invalid inputs, would be separate work. Neither is necessary to expose this writer refusal correctly.
