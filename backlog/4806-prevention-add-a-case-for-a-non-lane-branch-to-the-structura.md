---
bornAs: xezaii2
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-10-01"
tags: []
---

# Prevention — Count non-lane missing-run recovery failures and guard transient deferrals

Filed mechanically ON APPROVAL from chalbert/web-everything#3253: add a non-lane branch case to the structural-deferral soak and unit coverage, and require every deferral call to justify its transient classification.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3253@f2247f0abf422ce9259b71e418098f8b9da8d942

## Progress

- Original premise/scope: the review cited lines 29–30 of we:scripts/conveyor/missing-run-push.mjs and scoped only that source and we:scripts/conveyor/__tests__/missing-run-push.test.mjs, despite requesting a soak case too.
- Verified premise: we:scripts/conveyor/missing-run-push.mjs:31–34 combines invalid repository/PR/SHA and non-lane branch validation into a free deferral. A direct injected-executor probe with a valid repository, PR number and SHA but branch `feature/example` returned `ok: false`, `deferred: true`, and zero executor calls. This goal is not already delivered.
- Corrected scope: retain that source/unit pair and add we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs with its matching we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs. No sweep implementation change is needed: we:scripts/conveyor/ci-red-recovery-watch.mjs:845 skips the durable comment for deferred outcomes and otherwise posts it.
- Current evidence: we:scripts/conveyor/__tests__/missing-run-push.test.mjs covers stacked/fork failures, credentials, races and claims, but no non-lane input. The soak currently exercises stacked, fork and ineligible-credential cases over six ticks with a cap of two; its header incorrectly describes a marked-tip case as part of that scenario. Correct that description when adding the non-lane case; marked-tip unit coverage already exists.

- Prepare-validation scope correction: the previous scope included the existing soak wrapper but omitted the required matching unit-test scope for we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs. Retain the wrapper and add planned we:scripts/conveyor/soak/breaks/__tests__/missing-run-structural-deferral-loops*.test.mjs. Source evidence: the existing wrapper delegates to `defineBreakTest`, while the break owns fixture construction, repeated ticks and violation reporting; no matching test under that unit-test pattern currently exists. The recovery goal and implementation boundary remain unchanged.

## Design

Keep the existing lane-only recovery boundary. Unsupported branch names must return a counted refusal (`ok: false`, `action: 'pull-request-push'`, explanatory `error`, no `deferred` property), before any GitHub or git command. Treat the rest of the combined malformed-input preflight likewise: retrying identical invalid input cannot make it eligible. Do not loosen validation or attempt a push on any rejected input.

In we:scripts/conveyor/missing-run-push.mjs, reserve `defer` for external state that can change: stale PR head/state, mergeability recalculation or conflict repair, live claim ownership at either checkpoint, and a fetched head race. Give each call a stable transient reason and an adjacent explanation of what must change before retry. Preserve the public result shape; reason bookkeeping is internal.

Add a unit-level source guard in we:scripts/conveyor/__tests__/missing-run-push.test.mjs that enumerates every direct `defer` call, requires its literal reason to belong to an explicit reviewed transient-reason table, and requires a nonempty retry justification for each call site. Pin the expected sites so additions/removals require an explicit test update. Include negative guard fixtures for an unannotated call and an unknown/structural reason. This is an audit tripwire, backed by behavioral tests; a comment alone does not prove transience.

Extend the existing fixture builder in we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs to accept a head branch override used consistently in both listed and live PR shapes. Add a same-repo, main-based PR with a valid SHA and a non-lane branch. Preserve the six-tick/cap-two scenario and existing cases. Its non-lane case must record exactly two counted attempts and two comments, then reach `missing-run-cap-exhausted`, without invoking git. Keep the existing fix-presence detection so the new regression is a required failure before the fix, not silently expected-fail.

## MVP

1. Add failing unit coverage for a valid non-lane input and other malformed preflight inputs in we:scripts/conveyor/__tests__/missing-run-push.test.mjs; assert counted refusals and zero executor calls.
2. Add the non-lane repeated-tick case and correct the scenario description in we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs; retain its matching wrapper we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs.
3. Change structural preflight returns and document each surviving transient call in we:scripts/conveyor/missing-run-push.mjs; add the source guard and behavioral matrix to the existing unit file.
4. Run the focused unit and soak checks, then the standards gate. Deliver as one bounded change, with no recovery-policy expansion or new lint infrastructure.

## Test plan

- Planned we:scripts/conveyor/soak/breaks/__tests__/missing-run-structural-deferral-loops*.test.mjs: cover the break's non-lane regression detection, asserting that repeated free deferrals produce violations and counted refusals reach the cap with exactly two attempts and two durable comments. Keep the existing soak wrapper as the real-sweep integration proof.

- we:scripts/conveyor/__tests__/missing-run-push.test.mjs: non-lane branch, missing/non-string branch, malformed repository, invalid PR number and invalid SHA all refuse without `deferred` or executor activity. Valid lane success remains covered.
- The same unit file must exercise every allowed transient site: changed head/ref/state, unknown/conflicted mergeability, initial held claim, pre-push held claim and fetch race. Verify `deferred: true` and no push; preserve structural stacked/fork/credential/marked-tip assertions.
- The source guard must reject a new unjustified call and a structural reason. Restoring the old preflight deferral must fail behavioral coverage even if someone annotates it as transient.
- we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs must run the real sweep and recovery function with injected reads/comments through the existing break, proving bounded retries and durable accounting for the non-lane case alongside existing cases.

## Proof plan

Before implementation, capture red focused unit and soak runs with the new cases against the unchanged source. After implementation, capture green results for the same commands. Commands below are run from the WE repository; strip the `we:` repository locus from each path argument when executing:

- `npx vitest run we:scripts/conveyor/__tests__/missing-run-push.test.mjs`
- `npm run test:soak -- we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs`
- `npm run check:standards`

Use the injected-executor unit probe to demonstrate zero external commands on non-lane refusal. Record the soak's two comments/two attempts and final cap refusal. These local tests prove recovery accounting, not live GitHub CI startup; no real remote push is required.

## Done when

- Non-lane and malformed preflight inputs are counted failures and cannot execute a push.
- Every remaining deferral has an enforced transient justification and matching behavioral coverage.
- The extended soak fails against the old non-lane behavior and passes with bounded attempts, durable comments and cap handoff after the fix.
- Focused unit/soak checks and the standards gate pass.

## Follow-ups

None required for this bounded prevention item. Broader retry-policy changes and general-purpose linting are outside scope; preserve existing transient conflict/claim behavior.

## Findings (standalone worker, 2026-11-20)

The build-dispatch daemon held #4806 with:

> worker-declined: Not prepared: #4806 — could-not-prepare. The shared-admission refusal at 'we:scripts/conveyor/missing-run-push.mjs:107' freely defers both exhausted budgets and unreadable evidence. The card requires every deferral to be transient while excluding broader retry-policy changes. A decision is needed: classify those admission refusals and change their accounting, or explicitly exempt them from this guarantee. No files changed or stamps applied. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
