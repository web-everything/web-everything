---
bornAs: xorgh7m
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/lib/__tests__/gh-throttle.priority.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/gh-deferred-lint.mjs", "we:scripts/lib/__tests__/gh-deferred-lint.test.mjs", "we:scripts/__tests__/check-standards-gh-deferred.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "02b5c9a172dd95ea2c532c8451f6293abcd02bb6"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3094's independent review

Filed mechanically ON APPROVAL: the independent review accepted the change while owing regression guards for deferred reconcile reporting, command-type admission, health discovery, and unchecked deferral opt-in. Deliver those guards and the small correctness fixes needed to satisfy them.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3094@72e195c55b6f158f0074c832ba7ff4aafdf4cea8

## Progress

Preparation checked the current implementation; this goal is not already delivered.

- Old premise: deferred reporting at `we:scripts/conveyor/reconcile-pass.mjs:1003` needed coverage. Corrected: the deferred return is at `we:scripts/conveyor/reconcile-pass.mjs:1809`, supplies string notes, and the formatter at `we:scripts/conveyor/reconcile-pass.mjs:1523` reads object `.text`. The existing regression at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1110` checks skipped planning, but never formats the result. This requires a producer-shape fix as well as a test.
- Old premise: the parameterized command guard needed a stronger test at `we:scripts/lib/__tests__/gh-throttle.priority.test.mjs:78`. Still true: both entry points in that test omit opt-in. The command guard at `we:scripts/lib/gh-throttle.mjs:718` and opt-in guard at `we:scripts/lib/gh-throttle.mjs:722` are independent; removing the former is currently masked by the latter.
- Old premise: health discovery at `we:scripts/conveyor/health-watch.mjs:499` merely needed a graceful-skip test. Corrected: `probePrs` is at `we:scripts/conveyor/health-watch.mjs:778`; line 790 converts unknown/non-array results into empty observations. `collectGhProbes` publishes any truthy PR result at line 1072, including an empty array. Missing probes are already skipped by `we:scripts/conveyor/health-watch-core.mjs:943`. Preserve that missing-evidence contract instead of publishing a clean empty list after deferral.
- Old premise: the checked call at `we:scripts/conveyor/reconcile-pass.mjs:328` lacked opt-in. Corrected: the discovery call at lines 471–473 now opts in. Other defensive checks at lines 706 and 784 follow non-list calls; the lint must report absent opt-in without silently changing their execution semantics. No existing isGhDeferred/opt-in lint was found in `we:scripts/check-standards.mjs` or `we:scripts/check-standards-rules.mjs`.
- Old scope: two runtime files and three test files. Corrected scope adds a focused lint helper, its tests, standards integration and its matching test. Size **3 → 5**: approximately two runtime files × 35 changed lines, three existing tests × 55, lint helper × 120, lint unit tests × 100, integration × 20, integration tests × 60 (about 535 lines). The added work is grounded in the producer mismatch, health missing-evidence propagation, and absent lint integration above. This remains a story; no estimatedLoc is added.

## Design

1. Keep reconcile notes in the existing object shape with a text field; make the deferred producer emit that shape, with a nonempty fallback describing deferred discovery if the sentinel lacks a message. Document the shared note shape locally and audit all local producers/early returns. Preserve outcome metadata, zero dispatch and refusal counts, and the early exit before agent/check enrichment. Do not make deferred evidence look like an empty successful inventory.
2. Strengthen the existing command matrix with explicit `deferrable: true`, fixed time and isolated headroom. Exercise both synchronous and CLI passthrough calls, asserting one execution/spawn and no deferred result for comment, edit, merge and view. Keep the existing no-opt-in discovery tests and eligible discovery threshold tests. Admission defaults and thresholds do not change.
3. Give health discovery an injectable pass-admission dependency defaulting to the existing `deferGhPass` helper from `we:scripts/lib/gh-throttle.mjs:731`. Run it before snapshot, exec, commit or per-PR reads. A deferred pass raises a descriptive probe-unavailable error, caught by the existing collection boundary; it supplies no PR observation. Also reject deferred or malformed non-array results encountered during repository discovery, discarding partial observations. Successful `[]` remains authoritative clean evidence. Keep existing episodes and cadence retry eligibility through the existing missing-probe behavior; report the skip reason through probe errors. Inject snapshot access where needed so tests cover the production shared-snapshot path, not only fake exec. Update existing direct probe fixtures to inject successful admission, isolating them from host budget state.
4. Add a warning-level static rule in planned `we:scripts/lib/gh-deferred-lint.mjs`, invoked by `we:scripts/check-standards.mjs` over JavaScript script sources. Trace a directly bound call result tested with `isGhDeferred` within its lexical scope and require explicit `throttle: { deferrable: true }` on that dispatch. Use syntax-aware analysis: comments, strings and options on unrelated calls cannot satisfy the rule. Recognize forwarding checks on injected reader results as unproven provenance, not proven dispatches. Emit an explicit unverified warning for unresolved options/provenance, parse failures or unreadable selected files rather than claiming clean analysis. Diagnostics name file, line and missing evidence; operator action is to inspect the dispatch and opt in only if safe. Keep warning severity as originally requested. Do not enable deferral for non-list readers to silence a warning, and do not attempt whole-program dataflow or scan vendored dependencies.

## MVP

Implement the note-shape correction and regression, strengthen the command admission matrix, add health pass admission and missing-evidence regressions, and wire the focused warning rule into standards checking. The scope includes every matching existing or planned test. No new settings, changed thresholds, daemon deployment, network probes, or automatic rewriting of callers are required.

## Acceptance

- [A1] Executable — add test `deferred reconcile report preserves the skip reason` in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: pass the actual deferred plan through `formatReport`, assert the reason, no undefined text, no dispatch/enrichment, and a readable missing-message fallback. It fails on the current string-note producer and passes after the fix.
- [A2] Executable — strengthen `never defers %s below the normal threshold — it still executes` in `we:scripts/lib/__tests__/gh-throttle.priority.test.mjs` with explicit opt-in for both entry points and spawn-count assertions. Mutation proof: temporarily remove only the command-type guard in `we:scripts/lib/gh-throttle.mjs:718`; the strengthened matrix must fail, then pass after restoring it. This is prevention coverage for currently correct behavior, not a claim that an unmutated runtime should fail.
- [A3] Executable — add `skips a deferred discovery pass without clearing smells` in `we:scripts/conveyor/__tests__/health-watch.test.mjs`: seeded open episode plus scarce local headroom, zero discovery network/snapshot/detail calls, missing PR probe, visible reason, unchanged episode, and no successful cadence advance. Add deferred-second-repository and malformed-result cases, then a successful empty-list case that clears the episode. The deferred and malformed cases fail on current empty-list coercion and pass after propagation is corrected. Exercise both collection and tick consumption, including persisted previous state.
- [A4] Executable — planned `we:scripts/lib/__tests__/gh-deferred-lint.test.mjs` asserts warnings for missing/false/unknown opt-in, nested scope collisions and unparseable input; accepts a directly bound opted-in call; rejects comment/string/unrelated-call decoys as evidence. Planned `we:scripts/__tests__/check-standards-gh-deferred.test.mjs` runs the real gate against an isolated violating source and asserts the emitted warning, including unreadable-source handling. These tests fail before the helper/integration exists and pass after it lands; a warning does not need a nonzero CLI exit to be testable.

## Test plan

Run only the five affected/new test files named in Acceptance through the host heavy queue. Use `npm run test:unit -- <files>` with WE-relative arguments obtained by stripping each displayed `we:` locus prefix; this package command already uses heavy admission. Keep temporary fixtures under the task TMPDIR, fixed clocks and isolated budget roots; prohibit real GitHub execution in the fixtures. Retain existing opted-out discovery and normal reporting assertions. Use the same queued command for the A2 mutation run and restoration run; restore the source immediately and never commit the mutation. The expected mutant failure is proof, not a failure to repair by weakening tests.

## Proof plan

Capture red/green evidence separately: A1 and A3 expose current defects; A2 requires the targeted command-guard mutation; A4 starts with missing implementation and then verifies both pure diagnostics and actual gate emission. Record exact test names, commands and results. The runner owns preparation stamping and checks; this preparation does not claim build tests were run. At build time run `npm run check:standards` through `node` invoking `we:scripts/readiness/heavy-admission.mjs` with `run -- npm run check:standards` (strip the locus prefix for execution). Inspect any new warnings, especially the existing non-list defensive checks, without changing their semantics merely to quiet lint. If capacity is busy, use the queue's own bounded wait once and report inability to obtain capacity; do not poll.

## Follow-ups

Whole-program alias tracking and conversion of warnings into a blocking lint are outside this prevention item. Existing non-list defensive checks may remain reported with an explanation; widening the set of commands eligible for deferral is not authorized here. No blockedBy changes are proposed. The runner owns stamps, commit and parked review publication.
