---
bornAs: xx01mzs
kind: story
size: 1
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/run*.test.mjs", "we:scripts/operations/__tests__/file-item-cli.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "c7ac9c95d3b69c93f19836cf2baf711c179b54f5"
tags: []
---

# file-item prints why the card write was refused instead of only a resume hint

The reported 2026-10-01 filing stopped at the card write after a digest included a bare backlog path. The caller saw only the resume hint and retried with placeholder content, filing a junk card. Preserve the goal: a refused file-item write must explain the refusal, including the offending reference and its repository-prefixed correction, on stderr and exit non-zero.

Current code already renders the refusal and exits 1, but sends the human-readable output to stdout. This item fixes that output channel without weakening the writer's checks.

## Progress

- Revalidated by source inspection at checkout c7ac9c95d3b69c93f19836cf2baf711c179b54f5 on 2026-11-20. The former emission citation (line 763) is stale: we:scripts/operations/run.mjs:1057 still calls writeAllSync with descriptor 1 for every rendered outcome. we:scripts/operations/cli-adapter.mjs:1387 returns the stopped discriminator; we:scripts/operations/cli-adapter.mjs:1626 renders the effect-halted reason with exit code 1. This is source evidence, not a new end-to-end probe; the dated probe below remains historical.
- Previous prepared scope was the CLI emission point plus runner tests and a new CLI suite. Corrected scope remains the same: no runtime move requires another source file. Fixture prerequisites have widened: we:scripts/operations/file-item.mjs:233 now performs duplicate search before planning; we:scripts/operations/file-item-io.mjs:54 requires a readable backlog. Use an ordinary story (operatorTask omitted), a readable empty backlog, and valid size 1 so the test reaches the guarded writer instead of a planning refusal. Do not bypass duplicate admission. The existing CLI suite is still planned, not present in this checkout.
- Retain size 1 (old 1 → new 1): expected touch set is we:scripts/operations/run.mjs:1053 (about 5–10 changed lines), planned we:scripts/operations/__tests__/file-item-cli.test.mjs (about 150–200 fixture/assertion lines), and at most 20 compatibility assertion lines in we:scripts/operations/__tests__/run.test.mjs:49. Its child-process fixture already supplies the copy-and-run pattern. This is a story, so no estimatedLoc field is added.

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

## Acceptance

Each named test below is planned in we:scripts/operations/__tests__/file-item-cli.test.mjs. Each includes the human-readable refused-write assertion as its red baseline; compatibility assertions alone already pass before the fix and are not claimed as independent red tests.

- [A1] Executable: `human refusal explains each bare reference on stderr without mutation` parameterizes source, documentation, configuration, and data references. For each, require exit 1, locus-prefix reason, offending spelling, prefixed correction, and resume hint on stderr; require no rendered refusal on stdout and unchanged backlog/queue bytes. This fails at the stderr assertion before the build and passes after; it proves the existing fail-closed writer remains active.
- [A2] Executable: `corrected fresh filing succeeds after explained refusal` first asserts A1, then files a fresh corrected digest with default queueing. Require exit 0, completion on stdout, one new card and one queue entry. The refusal half fails before the build; both halves pass after. This covers the changed human-output default and the successful caller path.
- [A3] Executable: `JSON callers retain stdout after human refusal routing` first asserts A1, then repeats the invalid input with --json. Require one parseable stdout JSON value containing the refusal, exit 1, and unchanged backlog/queue; no human trailer may corrupt JSON. The human half fails before the build and the paired contract passes after.
- [A4] Executable: `routing is limited to human file-item effect-halted outcomes` first asserts A1, then exercises file-item help, a file-item planning refusal, and a scaffold writer refusal. Assert their existing stdout/exit behavior and no newly rerouted rendered lines. The first assertion fails before the build; the complete boundary test passes after. Persisted invalid input must not be rewritten by the output change: inspect the refused run record and use a new run for corrected input.

## Test plan

In the planned we:scripts/operations/__tests__/file-item-cli.test.mjs, launch the copied CLI from a disposable real checkout using the setup pattern in we:scripts/operations/__tests__/run.test.mjs. Create scratch space under the task TMPDIR. Point OPERATION_RUNS_DIR, OPERATION_CALLS_DIR, CONVEYOR_QUEUE_FILE, and WE_DAEMON_STATE_DIR into the fixture, and seed a readable empty backlog directory. Copy the runtime dependencies identified by we:scripts/operations/__tests__/run.test.mjs:22, including the worker-result schema and package metadata; use local Git fixture setup only. Bound each child with a timeout and maxBuffer and clean up in finally. Clear inherited filing/session overrides so the ordinary-story path is deterministic. The CLI resolves its repository by script location, so changing cwd alone is insufficient isolation.

- Parameterize invalid digests using the unprefixed spellings of we:scripts/operations/file-item.mjs, we:docs/agent/conventions.md, we:vitest.config.ts, and we:src/_data/plugs.json. Assert exit 1, stderr containing locus-prefix plus the offending/corrected pair and resume hint, and no human-readable refusal on stdout. Compare backlog contents and queue bytes before/after to prove no mutation.
- Repeat one invalid digest with --json: stdout parses as one JSON value carrying the refusal, exit remains 1, and no card or queue addition occurs.
- Run a fresh invocation with a repository-prefixed digest: assert exit 0, the ordinary completion on stdout, no refusal on stderr, one card, and one queue entry. This is a fresh run because resume retains the original committed input.
- Run the new suite and existing we:scripts/operations/__tests__/file-item.test.mjs, we:scripts/operations/__tests__/file-item-io.test.mjs, and we:scripts/operations/__tests__/run.test.mjs through the host heavy-admission runner only. Command convention: invoke node with we:scripts/readiness/heavy-admission.mjs, arguments run -- npx vitest run, then the selected test paths above (strip the we: documentation prefix when executing repository-relative paths). Run npm run check:standards through that same admission runner. If busy, use its supported wait bound once, then stop and report. Preparation leaves execution and stamping to the launcher; implementation records red/green results.

## Proof plan

Capture the real child process's exit status, stdout, stderr, and fixture filesystem assertions. Before implementation, run the newly authored A1–A4 tests against unchanged runtime code; each must fail on its human stderr assertion, not fixture setup. The invalid digest must reproduce the historical preparation probe: the reason is on stdout and stderr is empty. After implementation, the same invocation must show the complete explanation on stderr, exit 1, and unchanged backlog/queue state. The valid and JSON cases establish that stream routing did not break successful filing or machine-readable callers. Record those results during implementation; this preparation has inspected the still-unconditional stdout emission and retained historical probe evidence, not run a new CLI probe or delivered a fix.

## Follow-ups

No prerequisite design fork remains. A policy for stderr across all operations or all refusal kinds, and any change to resume guidance for immutable invalid inputs, would be separate work. Neither is necessary to expose this writer refusal correctly.
