---
bornAs: x4bppjr
kind: story
size: 3
status: active
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/heavy-repair-priority.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-13"
preparedDate: "2026-10-13"
preparedAgainstSha: "481cfe502d4dd9b5364c4cbf1f2e6ad448b637f5"
tags: []
---

# Red-main repair patterns resolve host-wide, not per caller

Historical filing attribution: held finding 231 (2026-10-11), reportedly approved with a follow-up. The original #4814 attribution does not identify that approval in the current checkout (see Progress). Shared-pool callers can currently override repair priority through checkout settings or environment. Resolve priority from the same host platform source as capacity, reject patterns that can classify ordinary identities as repairs, and retain bounded classification and observable yielding.

## Progress

- Original premise/scope: two source files, size 1, per-caller priority leaves near line 240; arbitrary `.*` accepted; a reference to #4799 described the host-cap precedent. The per-caller defect remains at we:scripts/readiness/heavy-admission.mjs:240. The current #4799 card concerns CI-heal review labels, so that historical number is not evidence for capacity resolution.
- Corrected premise: the host resolver already exists at we:scripts/readiness/heavy-admission.mjs:291–369, including shared/private pool handling, a fixed real-user platform source, cache and last-good reads. Only priority remains incorrectly exempt alongside `onTimeout`. No new host configuration store or daemon is needed; “once host-wide” means one authoritative source, not one cross-process singleton or instantaneous reload.
- Regex validation at we:scripts/readiness/heavy-repair-priority.mjs:74–83 limits resources and syntax but accepts broad expressions. Existing classification already has a 150 ms deadline at we:scripts/readiness/heavy-repair-priority.mjs:125, and yielding already logs at we:scripts/readiness/heavy-admission.mjs:1191–1195. These need regression coverage, not a new scheduling policy.
- Corrected scope adds existing we:scripts/readiness/__tests__/heavy-admission.test.mjs (priority tests start at line 1742, permissive override assertions at 1837–1851) and planned we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs for focused grammar/deadline tests. Current timing coverage at we:scripts/readiness/__tests__/heavy-admission.test.mjs:1820–1827 allows 1500 ms and does not directly prove the 150 ms deadline.
- Size changes from 1 to 3: estimated changed lines are 30–50 in we:scripts/readiness/heavy-admission.mjs, 50–80 in we:scripts/readiness/heavy-repair-priority.mjs, 100–140 in we:scripts/readiness/__tests__/heavy-admission.test.mjs, and 80–120 in planned we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs (260–390 total). This is a story, so no `estimatedLoc` is added. Preparation is based on source inspection; execution proof remains below. Runner owns checks, review and stamping.

- Re-preparation premise/scope: the incoming card already has size 3 and the four-file source/test touch set above; retain both. The earlier “size 1 → 3” entry records prior preparation, not a size change in this pass. Current evidence still supports the same estimate: resolver/diagnostics at we:scripts/readiness/heavy-admission.mjs:291–376, validation/matching at we:scripts/readiness/heavy-repair-priority.mjs:74–134, existing priority tests at we:scripts/readiness/__tests__/heavy-admission.test.mjs:1786–1851, and the planned focused matcher test file named in scope.
- Corrected attribution: the current #4814 card is a sandbox-workflow prevention item, not evidence of approval for repair priority. Treat the original approval attribution as unverified historical context; the concrete defect is independently visible in we:scripts/readiness/heavy-admission.mjs:240 and we:scripts/readiness/heavy-repair-priority.mjs:74–83.
- Corrected timing premise: we:scripts/readiness/heavy-repair-priority.mjs:124–125 validates before starting the matching deadline. The 150 ms budget bounds match execution across fields/patterns, not the entire function's elapsed duration including validation and VM setup. Preserve that boundary and prove budget propagation deterministically.
- Expanded proof within the existing scope: we:scripts/readiness/__tests__/heavy-admission.test.mjs:1570–1605 already exercises torn reads and separate checkout loaders for capacity; extend these fixtures to priority. Permissive regex assumptions also occur at we:scripts/readiness/__tests__/heavy-admission.test.mjs:1786–1834, beyond the cascade assertions previously singled out. No source or test file has moved; we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs remains a planned new file.

- Delivery sanity read: the shared-priority exemption and broad-pattern acceptance remain in current source; the spec is coherent and buildable. Added regression coverage before implementation for host policy, grammar, loader recovery, yielding and deterministic matching deadlines.

- Baseline proof: the required queued two-file Vitest run acquired a host slot after 569359 ms and executed 256 tests: 231 passed, 24 expected regression assertions failed (shared priority, broad/literal pattern acceptance and bounded diagnostics), and one new child-watchdog harness failed because Vitest supplied an HTTP module URL. Corrected that harness to use an explicit filesystem URL; this was distinct from admission timeout. Baseline output retained at /tmp/5943-before-tests.log. Existing yielding and deterministic deadline tests passed before implementation.

- Implemented the shared-host priority cascade using the existing resolver, retaining private overrides and per-caller timeout behavior. Added exact built-in/anchored repair-literal validation with whole-layer rejection, bounded one-line invalid diagnostics, and updated resolver documentation. The matcher deadline and scheduler are unchanged; the same two-file queued test command is running against the implementation.

- Final delivery proof: reran `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/readiness/__tests__/heavy-admission.test.mjs we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs` through the host queue: **2 files, 256 tests passed**, exit 0, 26.53 s test duration. Output retained at /tmp/5943-after-tests.log. Syntax checks passed for both changed source modules. Reviewed source/test changes against pre-edit copies without git; authored changes are confined to the four declared implementation/test paths plus this Progress section.
- Captured diagnostic assertions prove `priority.mode=off (platform)`, ignored tool/env priority values, and `invalid: platform.priority.repairPatterns=` with bounded single-line text. Four payload fixtures each capture exactly one `yielding to red-main repair waiter` log and resume ordinary admission after three polls. Controlled VM/clock assertions prove a post-validation deadline of 150 ms, match timeouts of 50 ms then 20 ms as time advances, and no further VM execution at exhaustion. The corrected child watchdog passes against the low-level catastrophic matcher.
- Delivery boundary: working-tree edits are ready for the wrapper. No git commands or gate commands were run; the wrapper owns committing and the queued `check:standards` requirement (A3). No out-of-scope implementation follow-up was introduced.

## Design

1. In we:scripts/readiness/heavy-admission.mjs, remove both priority leaves from `PER_CALLER_LEAVES`. Shared pools resolve standard → platform only; local tool/env values populate the existing ignored diagnostics. Keep `onTimeout` per caller. Update the stale cascade description in we:scripts/readiness/heavy-admission.mjs:125–126 and the resolver documentation alongside the implementation. Preserve the existing private-pool override exception, shared-pool alias detection, source reporting, ten-second cache and last-good read behavior.
2. In we:scripts/readiness/heavy-repair-priority.mjs, retain the existing resource checks and add a conservative, provable repair-language restriction. Accept the exact built-in expressions and fully anchored literal repair identities that themselves match a built-in repair shape. An array can select built-in families or specific repair identities; an empty array still disables matches. Reject other regex syntax rather than attempting general regex-language containment. A literal means only slug letters, digits and hyphens between `^` and `$`; do not accept lookarounds, alternative branches, arbitrary wildcard suffixes or unanchored prefixes. This provides narrower operator selections without allowing broader identities.
3. Reject an invalid array as a whole, preserve the previous valid policy layer (or standard), and expose the offending layer/value through existing invalid-policy diagnostics and `formatAdmissionPolicy`. Direct classifier calls retain validation and safe standard fallback. Malformed input never grants ordinary work P0. Reuse bounded one-line formatting for rejected text if needed to prevent multiline diagnostic injection.
4. Keep the four identity fields, standard main-fix/revert-red forms and optional lane-holder suffixes, P0 ordering across both slot kinds, FCFS within class, and non-preemption. Keep 50 ms per match and the shared 150 ms matching budget after validation; test deadline exhaustion deterministically with a controlled clock/VM seam rather than a strict wall-time assertion on a busy host.

## MVP

**Must:** Shared-host callers with conflicting environment or checkout preferences resolve identical priority settings and sources from the platform policy; host mode `off` cannot be locally changed to `enforce`.

**Must:** Broad, malformed, overlong or otherwise unsupported repair patterns are rejected and diagnosed; ordinary identities remain P3 after rejection. The standard repair shapes and supported narrower selections still classify correctly. Source, docs, config and data jobs use the same identity-based rule; payload type grants no exemption.

**Must:** Retain private-pool isolation, existing capacity rules and bounded classification. A normal waiter demonstrably emits `yielding to red-main repair waiter` once while yielding to a live repair waiter.

**Could:** More expressive provably narrow regex syntax can be added separately with a containment proof. It is not needed to close this defect.

## Done when

- [A1] New regression assertions fail on the old implementation for shared-pool priority overrides and broad-pattern acceptance, and pass after the change. Run through we:scripts/readiness/heavy-admission.mjs with arguments `run -- npx vitest run`, targeting we:scripts/readiness/__tests__/heavy-admission.test.mjs and we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs.
- [A2] Captured policy diagnostics identify ignored caller overrides and rejected platform patterns; captured admission logs contain the exact yielding phrase, and deterministic assertions demonstrate no match starts after the classification deadline.
- [A3] The runner executes `npm run check:standards` through the host heavy-run queue before stamping.

## Test plan

- Extend we:scripts/readiness/__tests__/heavy-admission.test.mjs: two callers of the same shared pool with contradictory mode/pattern env and tool settings; shared pool named directly and through an alias; valid platform mode/pattern precedence; private-pool overrides remain isolated; invalid platform array falls back and appears in formatted diagnostics. Update old assertions that explicitly allow shared-pool overrides and unrelated custom slugs, including the validator acceptance table, overlapping-alternation P0 expectation, count-cap fixtures and oversized-value fixture at we:scripts/readiness/__tests__/heavy-admission.test.mjs:1786–1851. Use valid anchored repair literals for count/length boundary tests so grammar rejection cannot mask the resource bound.
- Extend loader fixtures in we:scripts/readiness/__tests__/heavy-admission.test.mjs:1570–1605 with two temporary checkout settings directories sharing one injected platform fixture; assert identical priority values and source labels despite contradictory local/env settings. Advance the controlled clock beyond cache expiry, test a torn read retaining last-good priority, and then a valid replacement being read on retry. Keep test-only platform-path injection explicit.
- Extend the existing temporary-lock-root admission harness in we:scripts/readiness/__tests__/heavy-admission.test.mjs: seed a live P0 marker, poll an ordinary waiter, capture exactly one yielding log, release the repair marker, and verify ordinary admission resumes. Preserve tests for P0 FCFS, both slot kinds and running-holder non-preemption.
- Add we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs: all built-in families and holder suffixes; anchored literal subsets; empty array; ordinary main-fix-like words; `.*`, `^main-fix-.*$`, alternatives escaping the repair family, malformed regex, mixed valid/invalid arrays, count/length caps and oversized identity strings. Test all four identity fields and direct classifier fallback.
- Preserve low-level catastrophic-regex timeout coverage by exercising `repairPatternMatches` directly: rejected broad patterns should no longer reach it through a valid policy. Use controlled time to assert a deadline exactly 150 ms from the post-validation budget start, remaining-budget clipping, and no further VM execution at exhaustion; spy on the VM script execution with a controlled clock and valid built-in patterns so grammar rejection does not bypass the budget test. Restore spies after each case; retain a child-process watchdog as a coarse hang guard, not proof of exact timing.

## Proof plan

Before implementation, add the focused regression assertions and record their expected failures through the host queue, distinguishing failures from admission timeout or harness errors. After implementation, rerun the same queued tests and retain assertion output plus captured policy/yield logs. Use temporary private state and injected platform fixtures; do not edit the operator's host preferences or contend with real repair markers. Verify source labels and settings from two simulated shared callers agree, broad patterns are diagnosed, ordinary identities stay P3, and valid repair identities retain P0. Run the queued standards gate and inspect the final diff for only the declared touch set. Unit probes establish resolver and scheduling behavior; they do not claim that already-running processes instantly reload policy.

## Non-goals

- Authenticate repair ownership or redesign marker trust; the existing identity fields remain caller-provided evidence, so this does not prevent deliberate impersonation of a valid repair slug.
- Change queue capacity, timeout escapes, priority classes, preemption, host policy storage or cache lifetime.
- Add an HTTP receive/write endpoint; body-size, rate-limit and CSRF requirements do not apply.

## Edge cases this change must handle

1. **Untrusted text** — reject unsupported regex languages and retain length/count/value caps; sanitize diagnostic rendering.
2. **Truncated reads** — retain the existing last-good policy and retry behavior; no partial JSON becomes policy.
3. **Shared state files** — reuse host source resolution and temporary test roots; no new writers or marker schema.
4. **Fail closed** — rejected overrides cannot broaden P0; preserve the prior valid policy/default repair shapes, and timeout means no match.
5. **Identity scoping** — inspect the existing four identity fields, not command contents or changed-file extensions; private pools retain their isolation exception.
6. **State over time** — preserve cache expiration and last-good fallback; existing processes/markers are not retroactively reclassified by this change.
7. **Who wrote it** — platform settings govern shared priority; local preferences are ignored with provenance. Valid-slug impersonation remains explicitly outside this card.

## Follow-ups

- If operators need richer narrow expressions, extend the accepted grammar with tests proving containment in the standard repair language; do not restore arbitrary regex admission.
- If authenticated repair ownership is required, separately bind classification and waiter markers to authoritative incident/lease evidence. This requires a trust-model decision and is not silently introduced here.
