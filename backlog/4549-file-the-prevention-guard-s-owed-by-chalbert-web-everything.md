---
bornAs: x1dgehb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "325a7f76f5fe350ba10d6cec238fe9efa38ca39f"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3008's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Add the review-lens checklist alternative requested by the approval: every new durable-claim path needs tests for acquisition, release on completion, and release on failed launch. The current rendered checklist belongs in `we:scripts/lib/review-core.mjs`.
2. Add a deterministic regression in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` connecting the daemon's emitted dispatch inputs to model resolution against a non-Sonnet routing-table default. Preserve today's shared-policy routing contract.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3008@ec409f2d6bbea5a99ea4e07b3264b4433584691a

## Progress

Preparation research (2026-11-18; runner-owned stamps left unchanged):

- **Old premise/scope:** the prior preparation located build acquisition at line 423, prepare acquisition at line 607, prepare retirement at line 581 and synchronous dispatch at line 858 of `we:skills-src/conveyor/build-dispatch-daemon.mjs`. It scoped the daemon/test and review-core/test pairs and proposed testing only synchronous dispatch.
- **Corrected premise/scope:** build acquisition and failure release are now at `we:skills-src/conveyor/build-dispatch-daemon.mjs:989` and `we:skills-src/conveyor/build-dispatch-daemon.mjs:1020`; prepare equivalents are at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1466` and `we:skills-src/conveyor/build-dispatch-daemon.mjs:1503`. The shared `prepareDispatchLaunch` helper starts at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1924`; synchronous and detached callers start at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1948` and `we:skills-src/conveyor/build-dispatch-daemon.mjs:1980`. Cover both callers within the existing four-file scope. Grouped claim handling now exists; reuse its coverage, do not redesign it.
- **Guard still owed:** `we:scripts/lib/review-core.mjs:1972` registers only claim-accuracy hunt guidance, while `we:scripts/lib/review-core.mjs:1138` renders registered briefs. The existing handoff test at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:3408` checks argv/environment shape without downstream model resolution. The fallback test at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:3510` likewise stops at environment assertions. This is not already delivered.
- **Routing evidence:** `we:scripts/lib/dispatch-routing-policy-io.mjs:107` serializes the policy snapshot; `we:scripts/lib/dispatch-contracts.mjs:1361` accepts it as `routingPolicy`; `we:scripts/operations/dispatch-lane-io.mjs:1818` selects launch adapters and refuses an unavailable fallback chain. The shared helper forwards policy and inherited arguments without inventing a model override, contradicting its comment at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1929`. The separate integration test at `we:scripts/operations/__tests__/routing-policy-builder-dry-run.test.mjs:25` supplies a Sonnet table, not the required distinct non-Sonnet sentinel.
- **Existing lifecycle coverage:** restart, completion, empty observations and failed dispatch cases start at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:560`, `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:590`, `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:599` and `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:616`. Prepare failed-observation/stale-attempt retention is at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:2794`; grouped failed-launch coverage is at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4134` and `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4652`.
- **Sizing:** retain story size 3. Expected touch set: daemon comment approximately 3 lines; daemon tests approximately 140–200 lines for connected routing, both callers and targeted lifecycle assertions; review brief approximately 15 lines; review tests approximately 30–45 lines. No new production routing behavior or dependency edge is required. Source inspection establishes the preparation premise; implementation tests and mutation proofs below are future delivery work.

## Design

Add a correctness entry to `LENS_HUNT_BRIEF` in `we:scripts/lib/review-core.mjs`, using the existing `buildPanelMandate` rendering. Every added or changed durable-claim path requires named executable evidence of acquisition before dispatch, retention while live, release on current-attempt terminal completion, and release after returned refusal or thrown launch failure. Evidence must inspect claim state, not only summaries. Missing evidence is a review finding, not permission to infer success. Preserve lens selection and verdict rules; unrelated lenses must not inherit this checklist.

In `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`, capture actual argv/environment from both `cliDispatch` (injected exec) and `cliDispatchDetached` (injected spawn, temporary pending-launch root and deterministic base). Both use the shared helper. Mock only the policy IO boundary with a fixed validated policy, preserving other exports; restore environment/module mocks and clean temporary files after each test. Decode the captured `WE_DISPATCH_ROUTING_SNAPSHOT` and feed it to real `decideDispatchRoute` in `we:scripts/lib/dispatch-contracts.mjs`, then feed its route into real `routeDispatchProvider` in `we:scripts/operations/dispatch-lane-io.mjs`. Stub final launch effects and adapter availability, not policy selection.

Use an explicit non-Claude prepare primary and Claude fallback from the validated model vocabulary. Supply a valid non-Sonnet table model distinct from both selected models. Ordinary prepare uses the primary; `prepareFallback: true` forwards probation off and exercises the policy fallback. Assert exact provider/model at the launcher, snapshot equality, unchanged inherited caller arguments and no daemon-invented model arguments. Build with the same fallback flag must preserve the inherited probation setting. No defaults change. If every adapter is unavailable, assert the existing refusal and zero launcher calls; do not invent a new invalid-snapshot policy (the reader intentionally retains last-good policy).

Correct the stale override comment in `we:skills-src/conveyor/build-dispatch-daemon.mjs`. Audit existing lifecycle tests and strengthen only gaps required by the checklist, including acquisition ordering and thrown failures. Preserve stale-attempt/live-owner protections and grouped ownership semantics.

## MVP

1. **Must:** add the correctness checklist and rendered-mandate tests in `we:scripts/lib/review-core.mjs` and `we:scripts/lib/__tests__/review-core.test.mjs`.
2. **Must:** add connected routing cases for both launch callers, primary/fallback, build control, inherited arguments and unavailable adapters in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`.
3. **Must:** correct the shared helper comment and audit lifecycle assertions using real temporary claim storage; add only missing cases in the same daemon test file.
4. **Could, deferred:** broader routing combinations or a numerical branch-coverage threshold. The explicitly offered checklist alternative satisfies the approval debt without either.

## Acceptance

The names below are proposed tests, not claims that they exist today. Each implementation test must be collected and pass; a zero-test selection is not evidence. For prevention-only behavior already correct today, the required red state is the specified seeded regression with the new test installed, followed by green after restoring the correct implementation.

- [A1] Executable — proposed `4549 correctness mandate requires durable claim lifecycle evidence` and `4549 lifecycle brief stays correctness-only` in `we:scripts/lib/__tests__/review-core.test.mjs`: fail against the current missing brief, pass with the brief. Assert acquisition, live retention, terminal release, returned/thrown failure release and missing-evidence guidance in the rendered mandate; assert other lenses retain their own briefs.
- [A2] Executable — proposed parameterized `4549 launch callers preserve policy model selection` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: both synchronous and detached captures resolve primary/fallback against the distinct non-Sonnet table; inherited arguments survive and builds retain their probation setting. Must fail independently when snapshot forwarding is removed, a Sonnet pin is injected, fallback-off is removed, fallback-off leaks into builds, or caller arguments are discarded; pass after each restoration. These are preservation guarantees, not changed defaults.
- [A3] Executable — proposed `4549 unavailable policy adapters refuse without launch` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: captured handoff reaches the real provider selector with all adapters unavailable, produces its explicit refusal and invokes no launch sink. Fail when a test-local mutation permits a launch on that closed path; pass after restoring refusal.
- [A4] Executable — proposed parameterized `4549 durable claim lifecycle observes storage` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`, reusing existing fixtures: build/prepare claims exist before dispatch, remain while live/pending/across restart, retire on current completion and returned/thrown failed launch, and survive stale completion or failed observation. Fail on individual acquisition/release/retention mutations; pass after restoration. Existing grouped-failure cases remain green.

## Test plan

Run only the affected files and required standards gate through the heavy queue. In the following executable template, `QUEUE` denotes `we:scripts/readiness/heavy-admission.mjs`, `REVIEW` denotes `we:scripts/lib/__tests__/review-core.test.mjs`, and `DAEMON` denotes `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`; remove the `we:` locus prefix when supplying repository-relative shell arguments from the WE root:

- `node "$QUEUE" run --wait-ms=60000 -- npx vitest run "$REVIEW" "$DAEMON"` covers A1–A4 and existing callers/fixtures.
- `node "$QUEUE" run --wait-ms=60000 -- npm run check:standards` checks the repository consistency rules.

Use task-local temporary storage under the provided TMPDIR. Do not start real providers or acquire real lanes. If admission stays busy after the single bounded wait, stop and report the unrun check. Do not change historical mandate fixtures merely to suppress a failure; inspect any affected assertion and preserve historical intent. Shared routing modules and their test suites are read-only references, not extra implementation scope.

## Proof plan

1. Add A1 tests before the brief and record actual assertion failures, then record green with the brief. Confirm all named tests are collected.
2. Add A2/A3 tests and run each listed mutation individually; use a temporary test-local boundary wrapper to mutate downstream routing results without widening production scope. Record the exact mutation, failing assertion and restored green run. A wrapper that directly throws instead of exercising the real selector is not proof.
3. Map A4 to existing claim-store fixtures, then disable each applicable acquisition/release or protection in isolation. Record red/green evidence for both build and prepare. Do not promise blanket lifecycle coverage based solely on source inspection or an aggregate test count.
4. Restore all mutations, run the affected suites and standards gate through admission, and record commands, exits, test names and observed provider/model values. This is deterministic boundary/claim-storage proof, not a live-provider launch claim.

## Follow-ups

No additional work is necessary for the original approval debt. A branch-coverage threshold remains an alternative, not an extra requirement. If a mutation audit exposes a production lifecycle defect, document its exact reproducer and propose separately scoped repair rather than silently expanding this prevention story. Any newly necessary fixture must enter scope before implementation. No blockedBy changes are proposed.
