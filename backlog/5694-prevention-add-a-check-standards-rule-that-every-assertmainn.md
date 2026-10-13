---
bornAs: xm8qej1
kind: story
size: 8
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-rules-dispatch-labels.test.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs", "we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:scripts/lib/main-staleness.mjs", "we:scripts/lib/__tests__/main-staleness.test.mjs", "we:scripts/lib/daemon-last-good.mjs", "we:scripts/lib/__tests__/daemon-last-good.test.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-13"
preparedAgainstSha: "5d0359792f9aa88bb3558a4e667b57dfebcb1068"
tags: []
---

# Prevention — explicit dispatcher stale-guard labels, trusted comments, and bounded fresh-adoption coverage

Filed mechanically ON APPROVAL from web-everything/web-everything#4686. Preserve all four prevention goals: explicit caller labels enforced by check:standards; a default-grace simulator case; trusted-actor checks before webhook comment classification; and fix-only fresh-adoption grace with default-environment refusal coverage for review/promote.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4686@645a73e336fcff381b1f150f83815fa080920217

## Progress

- Preparation research: the original scope listed seven files, including the simulator world but no standards-rule implementation. Original citations pointed to the fix dispatcher at line 1823, comment parsing at line 43, and the last-good decision at line 125. These are historical review locations, not current change sites.
- Corrected label premise: both fix calls already supply `FIX_STALE_GUARD_OPTS` (we:scripts/conveyor/reconcile-fix-dispatch.mjs:192,1759,2169). Remaining unlabeled production calls are in we:scripts/operations/review-dispatch.mjs:588, we:scripts/operations/review-job.mjs:803, and we:scripts/operations/ci-heal-pr-dispatch.mjs:414. The goal is not already delivered: no matching explicit-label rule was found in we:scripts/check-standards.mjs or we:scripts/check-standards-rules.mjs.
- Corrected simulator scope: we:scripts/conveyor/__tests__/sim/world.mjs:298 pins grace to zero. Preserve this baseline; add the companion scenario in we:scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs, overriding the world's environment during setup before host boot. The setup seam is we:scripts/conveyor/__tests__/sim/scenario.mjs:347. No world-source edit is needed.
- Corrected trust premise: we:scripts/conveyor/pr-events-worker/core.mjs:122 classifies the comment body without inspecting its actor. Existing positive fixtures omit actor metadata (we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs:319); they must be updated alongside negative cases.
- Corrected grace premise: the pure decision defaults grace off, but the IO wrapper enables it for every caller (we:scripts/lib/daemon-last-good.mjs:112,144). The shared guard invokes that wrapper without caller scoping (we:scripts/lib/main-staleness.mjs:221). Thus review/promote do not currently refuse solely because a fresh adoption has no held/building record. Use the card's explicit fix-only opt-in remedy; a test-only assertion of refusal would be false. Preserve the separate held-build and live-rebuild policies (we:scripts/lib/main-staleness.mjs:268,302).
- Scope now includes the standards rule and integration, all three unlabeled callers, the shared guard, and matching tests for each source. Size changes **3 → 8**: roughly 120–180 changed lines across two standards sources, 120–180 across their two tests, 10–20 across three caller sources plus 30–60 across their three tests, 25–45 across the fix/shared-guard/last-good sources plus 100–160 across their three tests, 10–20 in the event parser plus 60–90 in its tests, and 70–110 in the simulator test. These estimates follow the concrete seams above; this remains a story, so no estimatedLoc field is added.
- Evidence is source inspection, not a claim of a live failure or passing regression. No implementation, runtime tests, or preparation stamps are part of this worker edit.

## Design

1. **Explicit labels.** Add a pure source validator to we:scripts/check-standards-rules.mjs and invoke it from we:scripts/check-standards.mjs over production modules beneath we:scripts/operations/ and we:scripts/conveyor/, excluding tests and fixture/soak material. Inspect actual calls using the existing TypeScript parser dependency, not a line regex. Resolve named import aliases and local constant option objects, including `Object.freeze`, so `FIX_STALE_GUARD_OPTS` passes. Require a third options argument whose effective object explicitly supplies a nonempty label; reject missing, empty, or unresolvable options and unresolved spreads that could overwrite the label. Accept a named label constant when it resolves to a nonempty string. Ignore strings, comments, declarations and re-exports. Diagnostics name the file, call line and missing-label remediation. Emit hard errors through the existing gate reporting path. Add explicit labels `review-dispatch`, `review-job`, and `ci-heal-pr-dispatch` at the three remaining sites.
2. **Trusted comment classification.** In we:scripts/conveyor/pr-events-worker/core.mjs, introduce a named predicate before `classifyPrComment`: accept exact OWNER/MEMBER/COLLABORATOR association or exact user type Bot, as the original card specifies. Reject absent or malformed actor metadata and outside human commenters even when the body contains a valid marker. Apply this to both advisory and ruling classifications. Keep the compact record format and body-free storage. No bot-login allowlist or new trust policy is introduced.
3. **Caller-scoped fresh adoption.** Add an `allowFreshAdoption` option, default false, to the shared guard and IO wrapper in we:scripts/lib/main-staleness.mjs and we:scripts/lib/daemon-last-good.mjs. The guard passes it to its default last-good reader; the wrapper supplies `freshAdoptMs: 0` unless explicitly enabled. Set it true only in `FIX_STALE_GUARD_OPTS` in we:scripts/conveyor/reconcile-fix-dispatch.mjs. Preserve injected last-good readers, held/building fallback, live-rebuild grace, grace duration and the zero opt-out. Review/promote with on-path lag and neither held nor building state must refuse under an unset grace environment; they may still use their existing independent fallback conditions.
4. **Temporal proof.** Extend we:scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs with a fix scenario that deletes the grace override from `w.env`, starts from a smoke-adopted build, pushes an on-path commit during the next tick and gives that tick actual owed fix work. Observe a dispatch on the earlier adopted SHA with no same-tick stale-refusal rebuild, then adoption/restart at the next tick start. Retain the grace-off immediate-refusal scenario. Capture actual dispatch and clone/rebuild evidence, not merely the absence of an error.
5. **Review lens.** For this delivery, every webhook-derived comment classification must cite the named trusted-actor predicate; every grace-off test must identify its default-environment companion below. This is a concrete review checklist for this seam, not a claim that a general semantic lint can prove either property across arbitrary code.

## MVP

**Must:** deliver all four original prevention outcomes in one change: executable label enforcement with current callers repaired, actor filtering for both comment kinds, fix-only opt-in with default-environment review/promote refusal tests, and a simulator replay of delayed adoption. Keep matching tests in the declared scope.

**Must on error:** missing actor evidence produces no comment record; unresolvable label options fail the gate; stale on-path review/promote code with no independent fallback refuses. Grace eligibility still requires the clean adopted HEAD and a valid bounded adoption time.

**Must for other inputs:** preserve existing non-code-only and off-dispatch-path handling; include docs, config and data paths in regression cases using their current classification. Do not silently treat an unknown behind-file list as a known harmless list. This item narrows fresh-adoption eligibility; it does not redefine the existing last-good fallback's unknown-diff behavior.

**Could:** broader actor-provenance lint, a repository-wide safety-relaxation test manifest, and simulator coverage of detached rebuild jobs. These are designed follow-ups, not prerequisites for the bounded prevention change.

## Test plan

- we:scripts/__tests__/check-standards-rules-dispatch-labels.test.mjs (new): missing third argument, missing/empty label, multiline options, import alias, frozen local options, named constants, overwritten label through spreads, unsupported options, and false-positive immunity for comments/strings/re-exports. Discovery must catch a newly added production caller. we:scripts/__tests__/check-standards.test.mjs: gate wiring emits a hard diagnostic for an unlabeled fixture and accepts the corrected fixture.
- we:scripts/operations/__tests__/review-dispatch.test.mjs, we:scripts/operations/__tests__/review-job.test.mjs, and we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs: stale refusal/log output identifies its caller. we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs: both fix entry paths retain explicit label and fresh-adoption opt-in.
- we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs: table of each trusted association, Bot, NONE/FIRST_TIMER/FIRST_TIME_CONTRIBUTOR/CONTRIBUTOR humans, missing and malformed metadata, and ordinary comments. Exercise both marker kinds. Signed outside-comment webhook returns ignored and appends no classification; trusted record stays body-free and retains delivery deduplication.
- we:scripts/lib/__tests__/daemon-last-good.test.mjs: wrapper under empty env with opt-in true/false, zero override, expired/invalid adoption, dirty tree and HEAD mismatch. we:scripts/lib/__tests__/main-staleness.test.mjs: use the real wrapper with deterministic state/time through an injected reader; matrix fix/review/promote, on-path lag, no held/building state, unset grace variable; preserve held and live-build behavior. Include unknown diff and docs/config/data classifications as regression controls; do not disable grace to obtain the default-case refusal.
- we:scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs: new default-grace scenario plus existing grace-off A2 and sibling-restart cases. Assert work actually dispatched, old versus adopted SHA, rebuild timing and restart evidence.
- Run each named file only through `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <repo-qualified-test-file>`; the `we:` prefix denotes repository locus and must be stripped when executing from the WE root. Run the standards gate through `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` with the same path translation. No direct heavy test invocation.

## Proof plan

1. Before implementation, add the regression assertions and record queued failures: the source validator is missing, outside comments are classified, and non-fix fresh-adoption defaults currently permit the last-good fallback. Keep failures separated so one missing import does not masquerade as proof of the other defects.
2. After implementation, record the queued test commands, exit codes and named passing cases. Run the standards gate against actual sources. In an isolated test fixture, remove a dispatch label and show the wired gate fails with its file/line diagnostic; restore it and show the fixture passes.
3. Preserve simulator evidence for the old-SHA dispatch and subsequent tick-start adoption, alongside the grace-off same-tick-refusal control. Do not claim a production daemon rollout from a hermetic simulator run.
4. Review the exact touch set and named actor/default-on companions. The runner owns preparation stamping and checks; this preparation does not claim completion of implementation acceptance.

## Done when

- All scoped tests and the standards gate pass through the host queue, and the negative label fixture fails for the intended rule.
- Outside humans cannot generate advisory/ruling observations by copying marker text.
- Only the fix caller opts into fresh-adoption fallback; default-environment review/promote refusal and the simulator timing trade-off have executable evidence.

## Non-goals

No webhook transport redesign, new bot allowlist, new grace duration, removal of held-build or active-rebuild fallback, detached-job simulator conversion, or change to daemon dispatch scheduling.

## Edge cases this change must handle

1. **Untrusted text** — parse comment shape only after actor validation; never persist the body.
2. **Truncated reads** — malformed actor metadata is untrusted; unreadable/unparseable scanned source fails the new gate rather than silently skipping a call.
3. **Shared state files** — preserve the existing per-clone rebuild reader and write nothing new; simulator uses its isolated state directory.
4. **Fail closed** — reject unverifiable labels and actors; distinguish no-fallback stale refusal from existing explicitly supported fallbacks.
5. **Identity scoping** — trust metadata from the signed webhook payload, never body claims or display names; preserve repository and PR identity.
6. **State over time** — exercise freshness expiry, zero override, old-SHA dispatch, next-tick adoption and unchanged immediate-refusal behavior with grace off.
7. **Who wrote it** — exact association/user-type predicate for both comment kinds, including missing-author negatives.

Transport note: we:scripts/conveyor/pr-events-worker/core.mjs:350 already requires POST, a configured secret and HMAC verification before parsing. It currently reads the full body and has no local body-size cap or rate limiter; this item does not claim otherwise. CSRF/origin is not the authentication mechanism for this signed server-to-server endpoint. The new predicate prevents outside comments from appending classification observations; ignored deliveries still touch receipt liveness. No state-reset endpoint is added or changed.

## Follow-ups

- **Could — transport limits:** separately inventory ingress/provider limits before proposing a body cap and rate policy; add request-level oversize/rate-limit tests with that change. This is outside the comment-classification defect.
- **Could — generalized review enforcement:** build an explicit registry of classification predicates and safety-relaxing controls before attempting a cross-repository lint; require each registered control to identify a default-environment companion test. Avoid lexical rules that mistake mentioning a predicate for enforcing it.
- **Could — detached rebuild fidelity:** extend the simulator to model the production rebuild-job mode, then repeat the adoption timing proof there; the existing inline-mode pin remains visible in we:scripts/conveyor/__tests__/sim/world.mjs:294.
