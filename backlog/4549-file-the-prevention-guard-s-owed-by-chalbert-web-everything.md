---
bornAs: x1dgehb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "0539048b166ad08136336a1eca36ea550d13be5c"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3008's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Add the review-lens checklist alternative requested by the approval: every new durable-claim path needs tests for acquisition, release on completion, and release on failed launch. The current rendered checklist belongs in `we:scripts/lib/review-core.mjs`.
2. Add a deterministic regression in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` connecting the daemon's emitted dispatch inputs to model resolution against a non-Sonnet routing-table default. Preserve today's shared-policy routing contract.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3008@ec409f2d6bbea5a99ea4e07b3264b4433584691a

## Progress

Preparation research (2026-11-18; runner owns stamping):

- **Old premise/scope:** the previous preparation targeted four files (the daemon, review core and their matching tests), cited obsolete daemon lines 423/581/607/858, and described only synchronous dispatch. It proposed preserving shared policy routing, not reinstating a Sonnet pin.
- **Corrected premise/scope:** the same four-file scope remains sufficient. The shared launch builder is now at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1924`; its stale override comment is at line 1929, snapshot/environment handoff at line 1944, synchronous caller at line 1948, and detached caller at line 1980. Both callers require regression coverage. Build acquisition is at `we:skills-src/conveyor/build-dispatch-daemon.mjs:989`; prepare acquisition and failed-launch releases are at lines 1466/1503/1509 of that same file. These behaviors exist; this is prevention work, not a new lifecycle policy.
- **Missing guard evidence:** `we:scripts/lib/review-core.mjs:1972` defines only the claim-accuracy hunt brief; `we:scripts/lib/review-core.mjs:1138` already renders registered briefs. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:3408` checks argv/environment shape without downstream model resolution; the fallback test at line 3510 likewise stops at environment assertions. Neither exercises a distinct non-Sonnet table through the captured handoff.
- **Caller/fixture correction:** `we:scripts/lib/__tests__/review-core.test.mjs:785` pins the default correctness mandate's exact bytes. Extend its explicitly permitted delta; preserve the historical `we:scripts/lib/__tests__/fixtures/panel-mandate.correctness.pre-3094.txt` unchanged. The changed default is the correctness review text only; no model, fallback, lens selection or claim-retirement default changes.
- **Routing evidence:** `we:scripts/lib/dispatch-routing-policy-io.mjs:111` serializes the policy snapshot. The pure resolver at `we:scripts/lib/dispatch-contracts.mjs:1361` accepts it as `routingPolicy`; the launcher at `we:scripts/operations/dispatch-lane-io.mjs:1818` selects available policy candidates and refuses when none can launch. Production uses the policy IO wrapper, so this proposed test is a deterministic boundary composition, not proof of the entire command pipeline. `we:scripts/operations/__tests__/routing-policy-builder-dry-run.test.mjs:25` still uses a Sonnet table and does not capture daemon output.
- **Lifecycle evidence:** existing cases in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:560` cover restart retention, line 590 completion, line 616 refused launch, line 2794 failed observations/stale attempts, and line 3204 unknown prepare failure. Group failed-launch coverage also exists at lines 4134 and 4652. Reuse these; do not recreate all lifecycle behavior.
- **Estimate:** retain story size **3**. Expected touch set: about 10–20 changed lines in `we:scripts/lib/review-core.mjs`, 30–50 in `we:scripts/lib/__tests__/review-core.test.mjs`, 2–5 in `we:skills-src/conveyor/build-dispatch-daemon.mjs`, and 120–180 in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`. No additional production dependency needs editing.
- **Status:** not already delivered; source inspection establishes both missing guards. No tests or mutation experiments were executed during this card-only preparation. No blocker-edge change is proposed.

## Design

Add a correctness entry to `LENS_HUNT_BRIEF` in `we:scripts/lib/review-core.mjs`. Require named executable tests and observable durable claim state for acquisition before dispatch, retention while live, completion release, and release after both refused and thrown launches. Missing tests or unreadable evidence must be reported as a review finding, never counted as proof. Use the existing panel rendering hook. Preserve unrelated lens text and verdict policy.

In `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`, capture real emitted argv/environment from both `cliDispatch` (injected exec) and `cliDispatchDetached` (injected spawn, temporary pending-launch root and fixed readBase). Use a validated fixed policy fixture at the routing-policy environment boundary; restore mocks and ambient environment after each case. Decode the captured snapshot, validate it with the existing policy validator, and pass that captured policy to the real `decideDispatchRoute` in `we:scripts/lib/dispatch-contracts.mjs`. Feed its result to the real `routeDispatchProvider` in `we:scripts/operations/dispatch-lane-io.mjs`. Stub final launcher effects, executable availability and provider availability only as needed; do not substitute the original fixture for the captured policy downstream.

Use an eligible noncritical prepare card, a probation primary with a Claude fallback, and a non-Sonnet table model distinct from both policy models. Capture exact provider/model at each launcher. Cover normal prepare with probation on, prepareFallback with probation off, and build with prepareFallback set as a control. Preserve inherited agent arguments without manufacturing a model pin. With all adapters unavailable, assert the existing explicit refusal and zero launcher calls. Do not turn this into a new policy for malformed snapshots: the IO reader already retains last-good policy on read errors.

Correct the override comment in `we:skills-src/conveyor/build-dispatch-daemon.mjs`. Audit existing lifecycle assertions using temporary real claim stores, adding only missing ordering/release assertions in the scoped daemon test. Keep failed-observation and stale-attempt retention intact.

## MVP

1. Add a red rendered-correctness-mandate test, then the brief and the explicit expected-text delta in `we:scripts/lib/__tests__/review-core.test.mjs`. Do not overwrite the historical fixture or weaken the byte comparison.
2. Add the synchronous and detached captured-handoff matrix to `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`; include the no-available-adapter refusal.
3. Map acquisition, retention, completion and failed-launch guarantees to existing claim-store cases; strengthen only gaps and correct the obsolete daemon comment.
4. Record targeted test and mutation evidence. Leave routing and lifecycle production semantics unchanged.

## Acceptance

- [A1] Executable — proposed test `4549 correctness mandate requires durable-claim lifecycle evidence` in `we:scripts/lib/__tests__/review-core.test.mjs` must fail against the pre-build brief and pass after it is added. Assert all four lifecycle obligations and that absent/unreadable evidence must produce a finding. The existing exact-byte default-mandate test must pass with only the explicit new brief delta; an unrelated-lens control must remain unchanged.
- [A2] Executable — proposed parameterized test `4549 captured dispatch handoff selects policy models` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` covers both callers, ordinary/fallback prepare, build isolation, inherited arguments, exact snapshot and exact launcher provider/model against the distinct table. Run its mutation challenge before and after adding the guard: before, the old shape-only test must miss at least the downstream table-substitution mutation; after, the new named test must fail for that mutation and pass on restored code. Also require failures for dropped snapshot forwarding and a daemon-invented Sonnet pin. This is a prevention red/green comparison, not a claim that current routing is defective.
- [A3] Executable — proposed test `4549 captured handoff refuses unavailable adapters` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` asserts an explicit no-available-adapter refusal and zero launch calls. Challenge it by bypassing that refusal: the pre-build handoff guards do not detect the bypass; the new test must fail under it and pass after restoration. No automatic retry or new fallback is introduced.
- [A4] Executable — proposed test `4549 lifecycle checklist names acquisition retention and both release outcomes` in `we:scripts/lib/__tests__/review-core.test.mjs` must fail before the brief and pass after it, requiring both refused and thrown launch coverage. Support it with named real-store lifecycle cases in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: acquisition-before-dispatch, live/restart retention, current completion release, refused/thrown launch release, and failed-observation/stale-attempt retention. Bypass each acquisition/release separately and identify the detecting case; add missing assertions, never change retirement policy to satisfy the test.

## Test plan

Run only the two affected test files via the host heavy queue. Command notation below uses repository-qualified paths; remove the leading `we:` when passing each path to the shell from the WE root:

`node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/review-core.test.mjs we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`

The A1/A4 assertions verify rendered text, not merely the brief map. A2/A3 exercise real handoff construction, temporary handoff files and actual resolver/launcher selection, with final external effects stubbed. Use task TMPDIR-backed scratch space and clean pending records. Existing downstream suites are reference fixtures, not an additional required test run for this four-file change.

For implementation completion, run `npm run check:standards` through the same heavy-admission runner. If admission is busy, wait once using its supported wait option and then report; never poll. The preparation runner owns checks for this card-only edit.

## Proof plan

1. Record the new mandate assertions red against the old brief, then green after the production text change. Preserve the exact-byte historical check with a narrowly documented added clause.
2. Record baseline detection gaps and post-build mutation results for A2/A3 separately. Only one temporary mutation at a time; restore it before the next probe. A new routing test may pass immediately on today's correct implementation, so an unmutated green run alone is insufficient prevention evidence.
3. Challenge acquisition and completion/refused/thrown release independently. Record test names and observable real claim-store state; do not infer release from a summary. Retain controls for stale attempts and unreadable observations.
4. Record queued commands, statuses, mutation diffs/restoration, and captured provider/model values. Run the affected suites on restored code. This proves deterministic boundaries, not a live provider launch. Do not run remote workers or acquire real lanes for these tests.

## Follow-ups

No additional approval debt or numerical branch-coverage threshold is required after the checklist alternative is delivered. If probing exposes a production lifecycle or routing defect, report the exact failing case separately instead of silently expanding this prevention change. Shared routing modules and historical fixtures stay read-only; any genuinely necessary additional edit requires a scope correction before implementation. No unresolved policy fork was found.
