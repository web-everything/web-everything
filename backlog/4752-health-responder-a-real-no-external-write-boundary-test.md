---
bornAs: x8xwdlc
kind: story
size: 2
status: open

dateOpened: "2026-10-02"
preparedDate: "2026-10-03"
preparedAgainstSha: "eb0677e86b2a5a17c060b7f6c6566e990bfaad83"
tags: []
---

# Health responder: a real no-external-write boundary test

Follow-up from the #3490 advisory (2026-10-02). The replay in `we:scripts/conveyor/__tests__/health-responder.test.mjs:25` checks useful disk and decision behavior, but its injected actuator tripwire is unused by production. Add an executable child-process boundary test and a bounded subprocess allowlist check so an introduced external write attempt makes a named test fail.

## Progress

- Original premise/scope: the replay was cited at `we:scripts/conveyor/__tests__/health-responder.test.mjs:23`, with a vacuous actuator tripwire and a narrow regex; the only predicted edit was that test file.
- Corrected premise: the replay starts at `we:scripts/conveyor/__tests__/health-responder.test.mjs:25`; `shadowTick` explicitly discards `actuators` in `we:scripts/conveyor/health-responder.mjs:21`. The static check at `we:scripts/conveyor/__tests__/health-responder.test.mjs:82` exempts the entrypoint from its subprocess prohibition and merely checks for a timeout string. This is a missing regression boundary, not evidence that the current tick performs external writes.
- Source evidence: `we:scripts/conveyor/health-responder.mjs` currently writes through `we:scripts/conveyor/health-responder-state.mjs`, whose journal, receipts, rotation segments, archive index and tick metadata are intentional local output. `readBootInputs` executes only `git rev-parse HEAD`; `runResponderDaemon` delegates child launch to `spawnPassOnce` in `we:skills-src/conveyor/pass-daemon.mjs`. The core in `we:scripts/conveyor/health-responder-core.mjs` is decision logic. A blanket ban on every subprocess in every imported daemon helper would reject existing legitimate behavior.
- Corrected scope: retain the single existing test file, implementing the child bootstrap and checker helpers inline there. Production files and the existing corpus at `we:scripts/conveyor/__tests__/fixtures/health-responder/replay.json` are read-only inputs. No new source entry needs a matching test path; the sole scope entry is itself the matching test. This preparation inspected the current source and history; it did not execute the proposed boundary or claim mutation proof already exists.

## Design

1. Replace the unused-actuator assertion with an isolated Node child that installs guards **before dynamically importing** the real responder. Generate the bootstrap from the scoped test, use a temporary state root and working directory, and provide an explicit minimal environment without inherited credentials or preload options. Keep the existing replay assertions; passing requires actual expected decisions and disk output, not just a successful child exit.
2. Intercept Node network entry points (global fetch, HTTP/HTTPS requests, net/socket connections, TLS and datagram sends) and all child-process launch variants, including sync, async, shell and fork forms. Synchronize patched builtin exports before module import. Record every forbidden attempt before throwing, and require the parent's parsed result to contain zero violations. A caught exception must still fail the test. Reject absolute executable paths, shell commands and unknown binaries; never fall through to a real external executable. A fake `gh` records and rejects every invocation; the tick currently needs no GitHub reads. Deny `git push` and all other unapproved git arguments. Where the harness exercises `readBootInputs`, stub only the exact `git rev-parse HEAD` read with a fixed revision.
3. Replay each existing case twice in the guarded child, injecting only deterministic facts and time. Verify the expected first decision and receipt suppression, journal records, and unchanged watch/config input bytes. Permit responder diagnostic output, including rotation artifacts when rotation is exercised. Preserve timeout and cleanup handling in the parent, and require a structured completion marker so early exit, import failure or malformed output cannot pass.
4. Add a syntax-aware subprocess check using the TypeScript parser already declared in `we:package.json`. Inspect `we:scripts/conveyor/health-responder.mjs`, `we:scripts/conveyor/health-responder-core.mjs` and `we:scripts/conveyor/health-responder-state.mjs`. Resolve named/aliased and namespace imports of child-process APIs; reject unknown/computed launch targets, shell execution and newly introduced dynamic child-process imports. The only direct production launch allowed is the exact bounded `git rev-parse HEAD` in `readBootInputs`. Keep the existing detector/actuator import restrictions. The existing `spawnPassOnce` delegation is outside the direct-binary check and remains covered by the existing daemon test; do not claim the shadow-tick harness tests the resident daemon's full lifecycle.
5. Treat this as an executable regression tripwire for ordinary Node IO and the named production modules, not an OS security sandbox against deliberately hostile code, native addons or arbitrary future runtime escape mechanisms. Runtime guards cover executed imported code; the static check covers dormant direct subprocess additions in the three responder modules.

## MVP

- Keep all changes in `we:scripts/conveyor/__tests__/health-responder.test.mjs`; inline the child program, process/network guards and source checker rather than creating a general sandbox framework.
- Retain the corpus's decision, receipts and local-write assertions while replacing the misleading unused-actuator guarantee with the guarded subprocess replay.
- Add guard self-tests and source-checker negative fixtures in the same test file. Keep existing deadline, disabled-switch, journal rotation, default-reader and resident-lease tests intact.
- No live-mode behavior, production API changes, new action policy, daemon refactor or dependency additions.

## Test plan

- Run the focused suite with `node we:scripts/readiness/heavy-admission.mjs run -- vitest run we:scripts/conveyor/__tests__/health-responder.test.mjs` (strip the `we:` locus prefixes when executing from the WE root).
- The clean guarded replay must consume every case in `we:scripts/conveyor/__tests__/fixtures/health-responder/replay.json`, complete both ticks and report zero attempted external effects. Compare input bytes and assert actual local outputs and expected decisions.
- In separate guarded children, attempt fetch, HTTP/HTTPS, socket/TLS/datagram IO, fake `gh`, `git push`, an absolute binary, a shell command and a fork. Each must record denial without touching the network or launching the requested binary. Include an attempt whose exception is swallowed: the parent must still reject it.
- Source-checker fixtures must accept the current bounded git read and reject a new binary, git push, an aliased launch, namespace launch, computed command and dynamic child-process import. Unchanged real responder sources must pass.
- A child timeout, premature exit, missing completion marker or invalid result must fail and clean up its temporary state. Existing tests remain green. Run `npm run check:standards` during implementation validation; the probation runner owns preparation checks.

## Proof plan

1. Establish the existing suite's baseline. Add the boundary tests and save the clean focused result; a clean baseline alone is not evidence of a working tripwire.
2. In a disposable source copy that preserves relative module resolution, insert a caught `fetch` write attempt into the actual `shadowTick` body. Run the same child replay against that copy: the named boundary test must fail on the recorded attempt even though the tick catches the error. Do not substitute a failing assertion for a production-path mutation.
3. Repeat with a `git push` launch and a fake `gh` write invocation in the tick; demonstrate denial before any real process/network effect. Add a dormant unknown-binary launch to a responder module and show the static allowlist test fails even without executing that branch.
4. Record the mutation, failing test name and denial diagnostic for each case. Remove disposable copies and rerun the unmodified focused suite green. No mutation may reach a live remote, use real credentials or remain in the working tree.

## Done when

- **Must:** the named guarded replay executes real `shadowTick` code with expected decisions and permitted local diagnostics, while zero external attempts are recorded.
- **Must:** introduced network, git-push and GitHub write attempts fail that test, including caught failures; an unapproved dormant direct binary launch fails the source check.
- **Must:** the harness fails closed on unsupported launch forms, malformed child output and timeouts, and the clean existing replay and daemon regressions remain green.
- Executable acceptance is the focused command in Test plan plus the red/green mutations in Proof plan. This is added enforcement, not a claim that today's unchanged suite is already red.

## Follow-ups

- Broader OS-enforced isolation and complete resident-daemon import-graph auditing are outside this tick-boundary test. Do not describe this result as proof of those properties.
- If a future responder adds a legitimate facts subprocess or live actuator, its owning change must explicitly extend the allowlist and add positive/negative boundary cases; do not weaken this test by silently permitting all `gh` or `git` commands.

## Findings (standalone worker, 2026-10-06)

The build-dispatch daemon held #4752 with:

> worker-declined: scope exceeds the test-fix envelope — route to the builder: the heal changed 277 lines (limit 150)

Implementation changes were discarded. The card is held for the builder; its declared scope is preserved.

## Findings (standalone worker, 2026-10-06)

The build-dispatch daemon held #4752 with:

> worker-declined: I have launched the git log search in the background to check if #4752 was already committed to main, and will inspect the results. I have initiated a search of git history to see the prior implementation or discarded attempts for item #4752. I will wait for the git log query to return. This item is not buildable within the test-fix probation launch constraints. ### Analysis & Rationale 1. **Rule Constraint:** &gt; "Keep the change small: at most 3 files and about 150 changed lines (the proven 'test-fix' envelope). A bigger change exceeds the envelope — stop and say so in your final message r…

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
