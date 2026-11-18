---
bornAs: x0tjpbx
kind: story
size: 3
status: open
scope: ["we:scripts/lib/provider-routing.mjs", "we:scripts/lib/__tests__/provider-routing.test.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "f798253427d8028a45ba4d0b8f0989d17dc0618b"
tags: []
---

# Should a repeatedly-erroring review-seat provider sit out for a cooldown instead of burning calls

Add a provider × lens cooldown to evidence-selected added review seats. Preserve the previously prepared policy: three consecutive non-quota failures suspend eligibility for six hours after the newest failure. Explicit policy routes remain outside this MVP.

## Acceptance

A1–A6 below are planned in we:scripts/operations/__tests__/review-extra-seats.test.mjs and runs with `npm run test:unit -- review-extra-seats`. Each must contain a cooldown assertion that fails on the current implementation, alongside its boundary/regression assertions; guards that already pass are not standalone red/green evidence.

- [A1] Executable — test `4515 cooldown threshold and recovery`: three recent consecutive failures exclude the provider; two do not; an intervening success resets the streak; exactly six hours restores eligibility; a new failure re-arms it. Assert exported defaults of three and six hours.
- [A2] Executable — test `4515 cooldown evidence boundaries`: scope by provider, dispatch kind and lens; use parsed timestamps with stable input order for ties, including mixed timezone representations. Unknown statuses count as failures, never as clean evidence. Include a three-unknown-status exclusion assertion. Quota rows end the counted streak and remain governed by existing quota admission.
- [A3] Executable — test `4515 cooldown skip and audit`: all candidates cooling returns null and a cooldown reason; a healthy candidate remains selectable; each excluded provider has a `cooldown:<provider>` audit entry with streak length and remaining milliseconds. No candidate is restored merely to fill an advisory seat.
- [A4] Executable — test `4515 cooldown clock and legacy evidence`: finite injected time activates exclusion; omitted or invalid time and any unparseable timestamp in the matching history disable cooldown for that pair, preserving ordinary ranking. Include active-cooldown assertions in the same table. This explicitly preserves the prior preparation's fail-open compatibility boundary; it does not claim unreadable evidence is healthy.
- [A5] Executable — test `4515 cooldown reaches planning replan and red team`: inherited routing uses injected time in initial planning, reservation-denial replanning and a fresh red-team dispatch. Assert cooled providers receive neither reservations nor launches, and all-cooled seats are skipped with a visible reason. Exercise the replan by denying another eligible provider's reservation.
- [A6] Executable — test `4515 cooldown preserves explicit routing`: paired inherited/configured cases with identical cooling evidence prove inherited selection skips while explicit policy routing retains its existing provider/model/effort. Include a coordinator overlay and operator-owned route. No production route is silently converted to inheritance to make this test pass.

- [A7] Executable — test `4515 reviewSeatRoutes forwards cooldown clock` in we:scripts/operations/__tests__/review-dispatch.test.mjs, run with `npm run test:unit -- review-dispatch`: with inherited routing, an empty coordinator overlay and a sole provider with three recent failures for each routed lens, finite injected time yields skipped seats with cooldown reasons and no routes; omitted time retains existing routes. The finite-time assertion fails before clock forwarding and cooldown implementation.

## Progress

- Validation repair: the previous five-file scope included we:scripts/operations/review-dispatch.mjs but omitted its matching suite. Add we:scripts/operations/__tests__/review-dispatch.test.mjs (existing Vitest imports at we:scripts/operations/__tests__/review-dispatch.test.mjs:17 and source imports at we:scripts/operations/__tests__/review-dispatch.test.mjs:20). The selector call at we:scripts/operations/review-dispatch.mjs:266 still omits time; A7 directly covers that forwarding boundary. Preserve the completed design and policy.

- Rechecked the current checkout: the goal is not delivered. Old premise: the selector at the former line 1221 only ranked failures, and the four-file scope omitted the dispatch caller. Corrected premise: we:scripts/lib/provider-routing.mjs:1259 still has no clock/cooldown input; candidate availability is filtered at we:scripts/lib/provider-routing.mjs:1263 and matching history is lexically sorted at we:scripts/lib/provider-routing.mjs:1272. The failure penalty remains ranking-only. The roster is now imported from we:scripts/lib/dispatch-routing-providers.mjs and re-exported at we:scripts/lib/provider-routing.mjs:1234; no roster edit is needed.
- Corrected scope: add we:scripts/operations/review-dispatch.mjs, whose `reviewSeatRoutes` at we:scripts/operations/review-dispatch.mjs:239 forwards selector inputs at we:scripts/operations/review-dispatch.mjs:266. Its matching tests already live in we:scripts/operations/__tests__/review-extra-seats.test.mjs:99, alongside selector tests at we:scripts/operations/__tests__/review-extra-seats.test.mjs:153. Keep the existing library test file for pure helper/default coverage.
- Caller drift: production planning/replanning are now we:scripts/operations/review-extra-seats.mjs:714 and we:scripts/operations/review-extra-seats.mjs:742, using the clock captured at we:scripts/operations/review-extra-seats.mjs:677. Red-team selection is at we:scripts/operations/review-extra-seats.mjs:1888 with time captured at we:scripts/operations/review-extra-seats.mjs:1825. Preserve existing resume behavior; only fresh selection changes.
- Scope limits remain deliberate: configured routes bypass the selector at we:scripts/operations/review-dispatch.mjs:266 and we:scripts/operations/review-extra-seats.mjs:1888. Coordinator overlays can also produce concrete routes through we:scripts/lib/dispatch-routing-policy.mjs:171. This is an evidence-selection cooldown, not a universal provider circuit breaker.
- Corrected proof claims: a pure timestamp filter permits eligibility after expiry, not an exclusive single probe across concurrent reviews. Existing cap reservations do not serialize a cooldown probe. Remove the former single-probe guarantee; exclusive probe ownership is follow-up work. The store reader is `readStore` / `resolveScorecardStorePath` imported at we:scripts/operations/review-extra-seats.mjs:91; `readSeatCapUsage` returns usage, not raw evidence rows. Tests use Vitest (we:scripts/operations/__tests__/review-extra-seats.test.mjs:8), not the formerly proposed Node test runner.
- Retain size 3: estimated source changes are about 65 lines in we:scripts/lib/provider-routing.mjs, 10 in we:scripts/operations/review-dispatch.mjs and 10 in we:scripts/operations/review-extra-seats.mjs; about 35 test lines in we:scripts/lib/__tests__/provider-routing.test.mjs and 180 in we:scripts/operations/__tests__/review-extra-seats.test.mjs. This is roughly 330 changed lines across six scoped files, including about 30 new direct forwarding-test lines in we:scripts/operations/__tests__/review-dispatch.test.mjs, with existing injected IO and fixtures. No new settings, persistence or locking protocol.

## Design

Export `REVIEW_SEAT_COOLDOWN_AFTER = 3` and `REVIEW_SEAT_COOLDOWN_MS = 6 * 60 * 60 * 1000` beside the review-seat exports in we:scripts/lib/provider-routing.mjs. Add optional `now` (finite epoch milliseconds) to `selectReviewSeatProvider`; keep it pure and never read a clock internally. Omitted/invalid time preserves existing behavior, including historical fixtures and external callers.

For each available provider, use only its review-seat rows for the requested lens. For cooldown evaluation, parse timestamps numerically and sort newest-first, preserving original array order for equal timestamps. Any unparseable timestamp in that matching history makes cooldown evidence unusable for that pair, so retain existing ranking without exclusion. Do not let malformed history for another provider or lens disable a valid cooldown. Keep the existing ranking comparator unchanged for survivors; the numeric ordering is for cooldown evaluation only.

Count the leading consecutive statuses other than `ok` and `quota-exhausted`; either terminates the streak. Unknown or missing status counts as a failure, following the existing conservative status classification. When the count is at least three and `now < newestMs + REVIEW_SEAT_COOLDOWN_MS`, exclude the provider. A future timestamp therefore holds eligibility until six hours after that timestamp, rather than silently treating that failure as expired. Record the count and `newestMs + duration - now` in the provider's cooldown audit entry. At exact expiry it becomes eligible; subsequent failed evidence refreshes the deadline. No claim of exclusive probe dispatch is made.

With no survivors, return null plus a cooldown-specific explanation; the existing caller skip paths expose it. Mandatory review remains untouched. The previously prepared malformed-time policy remains explicitly fail-open; unknown statuses are fail-closed for streak classification. Unreadable stores currently become empty histories in the fresh-call callers; changing that policy is outside this MVP, and tests must not misrepresent empty history as a verified clean record.

Add optional `now` to `reviewSeatRoutes` in we:scripts/operations/review-dispatch.mjs and forward it only on its existing evidence-selection path. Pass each operation's captured `io.now()` value from both planning sites and fresh red-team selection in we:scripts/operations/review-extra-seats.mjs. Preserve policy precedence, coordinator overlays, cap admission, reservation cleanup and resume-only behavior. Do not add settings or change defaults for callers that omit time.

## MVP

Implement the constants, pure cooldown evaluation, exclusion/audit result and clock plumbing across the three scoped source files. Update selector documentation and add the seven acceptance test groups. Keep malformed evidence compatibility, explicit-route bypass and lack of exclusive probe ownership visible in comments/tests. No new CLI flags, storage, live provider calls, mandatory-seat changes or global work-cascade cooldown.

## Test plan

Use existing `row()` and `TWO` fixtures in we:scripts/operations/__tests__/review-extra-seats.test.mjs for A1–A4, plus the existing injected operation IO for A5–A6. Pin inherited policy and empty coordinator overlay in inherited-route fixtures so ambient settings cannot bypass the selector. Separately pin explicit/operator policy and overlay cases. A5 must assert both reservation and launch call lists, not only a returned route.

Add library-level constants/determinism checks in we:scripts/lib/__tests__/provider-routing.test.mjs. Cover store-object input, empty history, unrelated malformed rows, equal timestamps, unknown status, future timestamps, exact expiry, omitted time, nonfinite time, successful recovery, and quota boundaries. Retain existing quota/cap and route assertions unchanged.

Add A7 in we:scripts/operations/__tests__/review-dispatch.test.mjs to exercise the exported route planner directly with pinned inherited routing and injected time.

Run only affected suites through `npm run test:unit -- provider-routing review-extra-seats review-dispatch`; this script uses the host heavy-run queue. The builder first adds the named tests and captures their expected cooldown assertion failures, then implements and reruns the same command. A missing test or import failure is not acceptable red evidence. The preparation worker does not execute proposed tests that do not yet exist; the runner owns preparation checks.

## Proof plan

Capture deterministic before/after outputs from the real selector and caller tests using fixed epoch time and three recent error rows. Before: the sole available failed provider is still chosen. After: null with the cooldown audit/reason, or an eligible alternative when supplied. A5 supplies the observable operation boundary proof: no reservation or launch for a cooled provider through initial plan, denied-reservation replan and red-team selection. Use injected IO; spend no provider calls or GitHub writes.

Optional corroboration may replay read-only real scorecards via `readStore` and `resolveScorecardStorePath` from we:scripts/conveyor/run-scorecard-store.mjs. Never assume the historical agy-claude incident is still present or recent. If absent, stale or unreadable, label the evidence synthetic and rely on the fixed fixtures. Do not mutate the shared store. Record the tested revision, fixed time, policy mode, expected failing assertions and passing results in the implementation review artifact; preserve the explicit-routing bypass in that report.

## Follow-ups

- Decide whether explicit policy/coordinator routes should also be cooled, including operator override semantics.
- Consider configurable thresholds/duration using the existing settings provenance cascade rather than an isolated environment knob.
- Consider fail-closed handling of malformed timestamps, invalid clocks and unreadable stores as a separate policy change with operator recovery semantics.
- If one concurrent probe after expiry is required, design an atomic lease/reservation and stale-lease recovery; the pure filter does not provide it.
- Surface cooldown state in the review board/report and evaluate a separate work-cascade cooldown.
