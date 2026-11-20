---
bornAs: xx01mzs
kind: story
size: 1
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/run*.test.mjs", "we:scripts/operations/__tests__/file-item-cli.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "c5048aa20e1c76289b25f51c126d31dad17346ea"
tags: []
---

# file-item prints why the card write was refused instead of only a resume hint

The reported 2026-10-01 filing stopped at the card write after a digest included a bare backlog path. The caller saw only the resume hint and retried with placeholder content, filing a junk card. Preserve the goal: a refused file-item write must explain the refusal, including the offending reference and its repository-prefixed correction, on stderr and exit non-zero.

Current code already renders the refusal and exits 1, but sends the human-readable output to stdout. This item fixes that output channel without weakening the writer's checks.

## Progress

- Revalidated by source inspection at c5048aa20e1c76289b25f51c126d31dad17346ea on 2026-11-20. The old prepared scope remains sufficient, but its emission/renderer citations had drifted: the unconditional stdout write is now we:scripts/operations/run.mjs:1057; the returned discriminator is we:scripts/operations/cli-adapter.mjs:1387; the detailed halted rendering is we:scripts/operations/cli-adapter.mjs:1626. The goal is not already delivered. This is source evidence, not a fresh CLI probe; the dated probe below is historical.
- Old scope: one output change plus a planned CLI suite and existing runner coverage. Corrected scope: the same touch set, with explicit resume, default human-output, JSON-caller, and unchanged-stop regression cases. The planned we:scripts/operations/__tests__/file-item-cli.test.mjs is still absent. Retain size 1: approximately 5–10 changed lines in we:scripts/operations/run.mjs plus 150–200 lines in the new CLI suite; the existing we:scripts/operations/__tests__/run*.test.mjs pattern supplies matching source coverage without requiring edits.
- Current writer evidence: we:scripts/backlog/guarded-write.mjs:127 includes the offending reference and prefixed correction; we:scripts/operations/scaffold-io.mjs:82 calls that writer; we:scripts/operations/effect-executor.mjs:434 returns its error. The write precedes queue-add in we:scripts/operations/file-item.mjs:285 and we:scripts/operations/file-item.mjs:296. The existing test at we:scripts/operations/__tests__/file-item-io.test.mjs:204 directly invokes the write sink and checks no file; despite its title, it does not drive the CLI or independently assert queue state.
- Caller audit: we:skills-src/file-item/SKILL.md:28 and we:skills-src/conveyor/investigation-agent-brief.md:107 use the human CLI; we:scripts/lib/pr-size-admission.mjs:213 requests JSON, and we:scripts/operations/review-loop-cli.mjs:292 consumes JSON stdout. Preserve these callers by changing only human file-item effect-halted output. Current duplicate-search guards in we:scripts/operations/file-item.mjs:134 can stop before writing: fixtures must provide a readable empty backlog and assert the actual stopped phase, not mistake an earlier refusal for the target failure.

- Original premise/scope: the refusal reason was lost, and the fix belonged in we:scripts/operations/file-item.mjs with we:scripts/operations/__tests__/file-item.test.mjs.
- Corrected premise/scope: we:scripts/operations/file-item.mjs is a pure declaration. Its write sink is reused by we:scripts/operations/file-item-io.mjs from we:scripts/operations/scaffold-io.mjs. The writer in we:scripts/backlog/guarded-write.mjs already throws a detailed locus-prefix error. we:scripts/operations/effect-executor.mjs preserves that error; we:scripts/operations/cli-adapter.mjs (`driveRun`, `renderOutcome`) returns an effect-halted outcome with the reason and code 1. The final CLI handler in we:scripts/operations/run.mjs unconditionally writes the rendered lines to descriptor 1. Change that emission point and add the planned we:scripts/operations/__tests__/file-item-cli.test.mjs. No writer, declaration, or executor edit is needed.
- Observed on 2026-10-02: invoked the actual file-item CLI in this lane with a story, size 1, and a digest containing the unprefixed spelling of we:scripts/operations/file-item.mjs. Temporary OPERATION_RUNS_DIR, OPERATION_CALLS_DIR, and CONVEYOR_QUEUE_FILE isolated bookkeeping and queue effects. Exit status was 1; stdout contained the full locus-prefix reason, offending reference, corrected reference, and resume hint; stderr was empty; the temporary queue file did not exist. Thus the original claim of a missing rendered reason does not reproduce, while the required stderr behavior remains undelivered.
- Existing coverage in we:scripts/operations/__tests__/file-item-io.test.mjs checks writer rejection and absence of a card, but does not invoke the CLI or assert its streams. The child-process fixture pattern in we:scripts/operations/__tests__/run.test.mjs supplies a precedent for the missing CLI coverage.

## Design

At the final output emission in we:scripts/operations/run.mjs, send the existing human-readable lines to stderr when the operation is file-item and its outcome is effect-halted. Keep the existing renderer's complete refusal text and resume information together; preserve its non-zero exit code. Use `outcome.stopped` and FILE_ITEM_OP rather than matching error text or re-running content validation. Select descriptor 2 only when the operation matches, stopped is effect-halted, and `hasJsonFlag(rest)` is false; otherwise retain descriptor 1. Apply this at the final emission after optional finish handling, keeping the discriminator from the original outcome.

Keep JSON mode on stdout with the existing structured error and exit status. Successful filing, help, other operations, and non-effect stops retain their existing output behavior. This bounds the change to the reported filing failure without making a new shared CLI output policy. The declaration, guarded writer, queue ordering, persisted run, and resume semantics remain authoritative.

## MVP

1. Implement the narrowly conditioned output-descriptor selection in we:scripts/operations/run.mjs.
2. Add we:scripts/operations/__tests__/file-item-cli.test.mjs to exercise the real CLI and real guarded writer in a disposable checkout, with isolated run, call-log, and queue paths.
3. Cover all A1–A5 cases: refusal, corrected successful input, JSON callers, persisted resume, and routing boundaries. Reuse fixture setup patterns without changing shared helpers unless a separate scope update is justified.

## Acceptance

Each named test below belongs in planned we:scripts/operations/__tests__/file-item-cli.test.mjs. Each includes a real human write-refusal assertion that is red before the stream fix, alongside its stated compatibility assertions, so preserved behavior is not misrepresented as a pre-existing failure.

- [A1] Executable — `human refusal explains every recognized reference`: parameterize source, documentation, configuration, and data digests; assert exit 1, full reason/offending reference/prefixed correction/resume hint on stderr and no human output on stdout. Assert no card and unchanged queue bytes, including an initially absent queue. This proves the changed default and fail-closed writer path together.
- [A2] Executable — `corrected fresh filing follows a rejected write`: first assert A1, then file a fresh corrected digest and assert exit 0, completion on stdout, no refusal on stderr, exactly one new card and one queue entry. No placeholder or validator bypass is permitted.
- [A3] Executable — `JSON callers retain structured stdout after human refusal`: first assert A1, then repeat with --json and assert one parseable stdout value, effect-halted, writer error, exit 1, and no card/queue change. Include --json=false as human mode and duplicate JSON flags with parser-consistent precedence.
- [A4] Executable — `resume preserves refusal routing and stored input`: assert A1, resume that persisted run, and assert the same stderr explanation/non-zero exit with no card or queue change; supplied replacement input must not silently replace the saved invalid digest.
- [A5] Executable — `routing remains specific to human file-item effect halts`: assert A1, then verify file-item help and argument/step refusals retain their existing streams/codes, and a scaffold writer halt retains stdout. The shared renderer and other operations acquire no new output policy.

Run the named cases through the host heavy-run queue using its `run -- npx vitest run` command with we:scripts/operations/__tests__/file-item-cli.test.mjs as the test target (strip the repository-reference prefix when supplying filesystem argv).

## Test plan

In the planned we:scripts/operations/__tests__/file-item-cli.test.mjs, launch the copied CLI from a disposable real checkout using the setup pattern in we:scripts/operations/__tests__/run.test.mjs. Point OPERATION_RUNS_DIR, OPERATION_CALLS_DIR, and CONVEYOR_QUEUE_FILE into the fixture, and seed its backlog directory. The CLI resolves its repository by script location, so changing cwd alone is insufficient isolation. Copy the import dependencies identified at we:scripts/operations/__tests__/run.test.mjs:21, including schema and skill resources, and provide local Git freshness evidence without remote network access. Use task TMPDIR, bounded child timeout/maxBuffer, and guaranteed cleanup. Seed a readable backlog so duplicate-search succeeds before the guarded writer is reached. Keep all card, queue, run, and call-log writes inside the disposable fixture.

- Parameterize invalid digests using the unprefixed spellings of we:scripts/operations/file-item.mjs, we:docs/agent/conventions.md, we:vitest.config.ts, and we:src/_data/plugs.json. Assert exit 1, stderr containing locus-prefix plus the offending/corrected pair and resume hint, and no human-readable refusal on stdout. Compare backlog contents and queue bytes before/after to prove no mutation.
- Repeat one invalid digest with --json: stdout parses as one JSON value carrying the refusal, exit remains 1, and no card or queue addition occurs.
- Run a fresh invocation with a repository-prefixed digest: assert exit 0, the ordinary completion on stdout, no refusal on stderr, one card, and one queue entry. This is a fresh run because resume retains the original committed input.
- Run the existing we:scripts/operations/__tests__/file-item.test.mjs, we:scripts/operations/__tests__/file-item-io.test.mjs, and we:scripts/operations/__tests__/run.test.mjs alongside the new suite, then the standards gate, all through the host heavy-run queue. The runner owns preparation checks and stamping; these are implementation validation instructions.

## Proof plan

Capture the real child process's exit status, stdout, stderr, and fixture filesystem assertions. Before implementation, the invalid digest must reproduce the preparation probe: the reason is on stdout and stderr is empty. After implementation, the same invocation must show the complete explanation on stderr, exit 1, and unchanged backlog/queue state. The valid and JSON cases establish that stream routing did not break successful filing or machine-readable callers. Record those results during implementation. Run every A1–A5 named test before and after the change; each must fail before on its included human-stderr assertion and pass afterward. Preparation source inspection establishes the routing defect; no new runtime test result is claimed here.

## Follow-ups

No prerequisite design fork remains. A policy for stderr across all operations or all refusal kinds, and any change to resume guidance for immutable invalid inputs, would be separate work. Neither is necessary to expose this writer refusal correctly.
