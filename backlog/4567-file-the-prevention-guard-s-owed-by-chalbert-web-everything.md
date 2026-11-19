---
bornAs: xmywyha
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/conveyor/build-dispatch-claim.mjs", "we:scripts/conveyor/__tests__/build-dispatch-claim.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "d8a4130122488abe57d96ff14e1d215334e2261f"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3036's independent review

Filed mechanically on approval of chalbert/web-everything#3036 to track prevention debt: bound worker hold reasons at the persistence boundary, cover oversized already-done reports and the moved-HEAD refusal, and verify null-safe routing. The review also requested a byte bound for all dispatch holds.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3036@cf5ddca6098fd6b80c6d5a7b0b98994ed890ac64

## Progress

- Original premise/scope: five advisory guards attributed to historical lines 367–378 of we:scripts/operations/probation-build-run.mjs, scoped only to that runner and we:scripts/operations/__tests__/probation-build-run.test.mjs.
- Corrected premise: already-done routing now occurs at we:scripts/operations/probation-build-run.mjs:622–632; it passes the raw report into the hold adapter. The production adapter at we:scripts/operations/probation-build-run.mjs:1017–1023 persists the reason unchanged. Declines sanitize a 600-character excerpt before adding the prefix at we:scripts/operations/probation-build-run.mjs:634–637; we:scripts/operations/__tests__/probation-build-run.test.mjs:276–284 explicitly expects 617 characters. Thus the requested total bound is not delivered.
- Corrected scope: add we:scripts/conveyor/build-dispatch-claim.mjs and we:scripts/conveyor/__tests__/build-dispatch-claim.test.mjs. The shared writer stringifies without bounding at we:scripts/conveyor/build-dispatch-claim.mjs:143–159. Its existing placement/refresh/expiry tests are at we:scripts/conveyor/__tests__/build-dispatch-claim.test.mjs:45–91.
- Null-check premise narrowed: we:scripts/conveyor/build-dispatch-hold-router.mjs:56–57 already normalizes missing reasons, we:scripts/conveyor/build-dispatch-hold-router.mjs:81–89 tolerates absent collections and filters invalid IDs, and the runner uses optional chaining at we:scripts/operations/probation-build-run.mjs:623. Existing tests at we:scripts/conveyor/__tests__/build-dispatch-hold-router.test.mjs:40–66 pin those contracts. No TypeScript migration or new throwing assertion is needed.
- Moved-HEAD coverage is partial: we:scripts/operations/__tests__/probation-build-run.test.mjs:824 covers the general worker-commit refusal, not the zero-diff already-done branch at we:scripts/operations/probation-build-run.mjs:624–625.
- Caller audit: shared writer consumers include we:scripts/operations/deliver-item-wrapper.mjs:408, we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:520, and we:skills-src/conveyor/build-dispatch-daemon.mjs:2811. Preserve their short reason strings, null default, cooldown refresh and replacement-stamp metadata. Existing persisted holds remain readable; bound new writes and refreshes without a bulk migration.
- Size remains 3: expected touch set is two source files (about 25 runner lines and 20 writer lines) plus two matching test files (about 100 runner-test lines and 60 writer-test lines). This is localized boundary hardening, not a new routing policy. Preparation is based on source inspection; no implementation or delivery is claimed.

## Design

Sanitize the complete reason, including its route prefix, in the production `holdWorkerDecline` adapter with the existing `sanitizeHoldReason` helper and an explicit maximum of 600 characters. Keep classification and extracted commit separate from the display excerpt: classify the original report first, and do not reclassify a truncated reason. Preserve citation verification by the existing landing pass. A truncated citation must never become independent proof of delivery.

At the shared `placeBuildDispatchHold` boundary, enforce a maximum of 2400 UTF-8 bytes for every non-null reason, including the truncation marker. This conservative byte ceiling accommodates the requested 600-character worker excerpt even for multibyte text; it does not impose the worker-specific character limit on other callers. Truncate at Unicode code-point boundaries and reserve space for the marker. Keep the current null default and short-string behavior. Do not import the operations landing module into the conveyor primitive just to apply this byte bound.

Oversized text remains an active hold with a visible ellipsis rather than becoming an admission failure or losing its cooldown. Operators can inspect the original worker output when the excerpt is insufficient. Route leases and hold-write failures must retain the existing refusal behavior. The runner adapter must strip control characters even when called directly, so new callers cannot bypass it. Do not globally change the sanitizer's existing 500-character default or the prepare finding's separate 1200-character excerpt.

## MVP

1. Apply complete-reason sanitization in the real worker-hold adapter; update the 617-character fixture to distinguish the incoming route entry from the persisted, bounded value. Exercise the real adapter with isolated coordination roots, rather than proving only a fake IO implementation.
2. Add the shared UTF-8 write bound, preserving null, metadata and refresh behavior. Test both initial persistence and replacement of a historical oversized hold.
3. Add oversized already-done and decline coverage, a named zero-diff already-done moved-HEAD arc test, and persistence-failure assertions. Retain existing null-safe router tests as regression coverage.

## Acceptance

- [A1] Executable — add `4567 worker hold boundary bounds both routes` in we:scripts/operations/__tests__/probation-build-run.test.mjs. Direct real-adapter calls and runner arcs for decline/already-done, with oversized text and control characters, must persist reasons of at most 600 characters without Unicode control characters. Include prefixes in the count; preserve route and extracted commit, including a citation beyond the excerpt. The new assertions fail against today's unbounded adapter and pass after the build. Run the focused runner test command in Test plan.
- [A2] Executable — add `4567 all hold writes enforce UTF-8 ceiling` in we:scripts/conveyor/__tests__/build-dispatch-claim.test.mjs. ASCII, emoji and multibyte inputs must persist at most 2400 UTF-8 bytes with a visible truncation marker and no split code point. Cover null/default, unchanged short caller reasons, replacement of oversized historical state, replacement-stamp metadata and TTL refresh. Oversized assertions fail before implementation; the compatibility assertions must stay green. Run the focused writer test command in Test plan.
- [A3] Executable — add `4567 already-done refusal and persistence failures stay closed` in we:scripts/operations/__tests__/probation-build-run.test.mjs. Pair the oversized stationary-HEAD case (red before A1) with moved-HEAD, route-lease failure and hold-write failure cases: refusal must not land, resolve or publish; moved-HEAD must not place a hold. Assert the existing human-escalation/error detail. Retain the existing absent-message fallback and null-safe router tests. Run the focused runner and router test commands in Test plan. The refusal behavior already exists; the new named branch coverage guards it while A1 changes the boundary.

## Edge cases

Classification precedes shortening, so an already-done citation at the end of a long report still reaches independent citation verification. A decline containing a cited commit remains a decline. Empty/missing reports retain the existing explicit no-final-message finding. Unicode truncation counts encoded bytes, not JavaScript string length; the marker counts toward the ceiling. Historical oversized holds are tolerated on read and bounded on refresh. A failed lease or write cannot be treated as successful persistence.

## Test plan

Use the host heavy-run queue, once per command, with one bounded wait if occupied. Commands below strip the documentation-only `we:` prefix before passing paths to Node/Vitest; every authored path retains its repository locus.

```sh
queue=we:scripts/readiness/heavy-admission.mjs
runner=we:scripts/operations/__tests__/probation-build-run.test.mjs
writer=we:scripts/conveyor/__tests__/build-dispatch-claim.test.mjs
router=we:scripts/conveyor/__tests__/build-dispatch-hold-router.test.mjs
node "${queue#we:}" run --wait-ms=60000 -- npx vitest run "${runner#we:}" "${writer#we:}" "${router#we:}"
```

Use temporary coordination roots beneath the task's TMPDIR; do not touch production holds or dispatch work. Add the tests first and record the expected A1/A2 failures against the old code, then implement and run the same focused suite. Do not weaken short-message, citation-verification, cooldown or null-safety assertions to make fixtures pass.

## Proof plan

Capture red/green results for the named A1–A3 tests. Inspect persisted metadata through the actual hold reader, checking both character length and `Buffer.byteLength(reason, 'utf8')`; an assertion against a mock entry alone is insufficient. Record the no-land/no-publish call trace for moved HEAD and failed persistence. Verify that only the four scoped implementation/test files change during the build. The runner owns preparation stamping and checks; this card-only preparation does not stamp or claim implementation success.

## Follow-ups

The advisory suggestion to add a general review-lens checklist for every new refusal branch is process work outside this bounded implementation. This card supplies the specific missing named branch test. TypeScript conversion is unnecessary for the already-null-safe router. No dependency change is proposed.
