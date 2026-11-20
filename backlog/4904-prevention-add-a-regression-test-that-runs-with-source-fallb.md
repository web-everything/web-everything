---
bornAs: xs52q1p
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "2e7fb7c5c200d1f2ebd931fb6a4aa3cd607f92d7"
tags: []
---

# Prevention — Bound repeated fallback-check hydration across reconcile ticks

Filed mechanically on approval of chalbert/web-everything#3432. The original requests were a fallback-required-check regression with bounded REST reads, a cross-tick negative TTL cache for incomplete heads, and an explicit heal-or-hold invariant when hydration fails despite known failing snapshot evidence.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3432@2498e55c6b57f30b629e1477e55366138ef724d6

## Progress

- **Old premise/scope:** the prior preparation located hydration at obsolete lines 990–1034, treated valid missing-name responses as `check-read-failed`, proposed a checkout-local sidecar, and omitted read-only callers. The three-file scope and size 3 remain appropriate; no implementation has been made in this preparation.
- **Corrected premise:** `we:scripts/conveyor/reconcile-pass.mjs:1560` still creates a per-invocation Map at line 1561, so sequential ticks cannot reuse negative observations. Valid missing-name responses now produce `ci-trigger-owed` at `we:scripts/conveyor/reconcile-pass.mjs:1621`; only actual read failures refuse. Preserve this recovery signal on cache hits instead of restoring the obsolete refusal. Tests at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1359` already distinguish never-started checks from read failures.
- **Delivered portion only:** commit `8b48b47dd2` preserves known red/pending snapshot evidence. Current evidence is `we:scripts/conveyor/reconcile-pass.mjs:1641` and the cancelled-check regression at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1398`. The whole goal is not delivered: there is no cross-tick hydration cache.
- **Corrected scope:** retain the same source and two suites. `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs:31` covers repository-specific fallback in one tick; its newer evidence-coverage tests also require clearing `rowsComplete` and `rowsHead` when replacing rows. `we:scripts/conveyor/reconcile-pass.mjs:1818` now propagates roster provenance, which cached hydration must preserve.
- **Caller/default evidence:** the CLI at `we:scripts/conveyor/reconcile-pass.mjs:1951` and redispatch at `we:scripts/conveyor/orphan-fix-round.mjs:239` use production defaults. The shadow caller at `we:scripts/conveyor/decider-daemon.mjs:223` supplies `readOnly: true`; cache writes must honor it. `we:scripts/lib/required-status-checks.mjs:85` documents why caches belong under the shared coordination root, not each checkout. These callers/helpers are evidence only, not additional edit targets.
- **Preparation validation:** inspected the current implementation, callers and regression assertions; historical 114/119-test counts from the previous preparation are not current validation. The runner owns checks and stamping. No production savings claim is made. The original post-deployment cost-review claim still has no verified item identifier.

## Design

Keep hydration and the implementation-local cache helpers in `we:scripts/conveyor/reconcile-pass.mjs`; leave the planner and required-check provider unchanged. Cache only a successful, validated REST response classified as incomplete (required names absent, no observed required red/pending evidence). Never persist errors, malformed responses, positive/complete results, or a negative result when the current snapshot already says red/pending.

Use a versioned disk sidecar under the shared root resolved by `we:scripts/operations/coordination-root.mjs`, with basename `we:reconcile-check-hydration-cache.json`, so sequential ticks across process restarts and lane checkouts can reuse it. Reuse the atomic writer in `we:scripts/lib/atomic-json-file.mjs`. Add optional `hydrationCachePath` and `hydrationCacheTtlMs` inputs to `runReconcilePass`, forwarding the existing injected `now`. Default TTL: 60,000 ms, measured from the successful read, never extended on hits. An explicit null path disables persistence. With a custom `readChecks` and no explicit path, disable persistence to isolate existing injected readers; the production default reader uses the sidecar. New tests explicitly supply temporary paths. Capture whether the original reader was injected before timing wrappers are applied. With `readOnly: true`, allow validated cache reads but never create directories, prune on disk, or write entries. No new environment setting or policy cascade is introduced; these are internal injectable defaults. No migration is needed: absent, malformed, or unknown-version sidecars are cache misses.

Each entry contains normalized rows, the incomplete reason, and observation time. Key by canonical repository slug, exact head SHA, sorted unique required names, and a stable fingerprint of snapshot check evidence (name, run ID where present, status, conclusion, completion timestamp). Reordered equivalent evidence should not invalidate; changed evidence, head, repository, or required set must miss. Bypass the negative cache for current red/pending evidence; complete short snapshots continue to bypass REST as today. Expired or future-dated entries miss. Revalidate persisted rows before using them, and only reuse entries that still classify as incomplete under the current required set.

On a hit, retain the same per-PR `ci-trigger-owed` signal and unchecked CI outcome as the original readable incomplete response; preserve the existing conflict exemption. Only real hydration errors emit `check-read-failed`. Reapply the existing output shaping, including `rollupIncomplete: true`, `rowsComplete: false`, and `rowsHead: null`, and retain the current roster provenance. Never turn a cache hit into green or erase newer snapshot evidence. Preserve the existing per-pass Map for same-head deduplication. Read once per pass, prune expired entries, cap storage at 512 entries by oldest observation, and write through the shared atomic writer. Cache read/write failures are best-effort misses or lost savings, never CI evidence. Concurrent writers may lose cache entries; the read bound applies to sequential ticks sharing a writable sidecar, not a distributed single-flight guarantee.

Update the hydrateChecks header to distinguish unknown evidence (withhold from heal/promotion) from known red/pending snapshot evidence (preserve existing planner behavior even when hydration refuses). This documents the already-shipped invariant.

## MVP

1. **Must 1 — Bounded reads:** for N distinct unchanged incomplete heads with fallback requirements, the first pass performs N hydration reads, further sequential passes before TTL expiry perform zero, and the first pass at expiry performs N. Multiple PRs sharing a head still need only one read per pass. The bound counts injected hydration calls, not required-policy reads or paginated HTTP requests inside one hydration call.
2. **Must 2 — Evidence safety:** negative cache reuse never promotes or heals unknown/incomplete evidence; current red/pending snapshot evidence bypasses it. A throwing hydration read preserves known required red evidence and its existing recovery outcome, with a visible refusal. Readable absent checks still owe a trigger. Unknown evidence still withholds CI heal/promotion while unrelated planning continues.
3. **Must 3 — Real tick lifetime:** persist across separate cache-reader/process lifetimes, with exact key isolation, a non-sliding expiry, bounded storage, and safe corruption/I/O degradation. Do not cache read failures as successful negative observations.
4. **Must 4 — Input independence:** apply the same read bound and conservative evidence rules to source, documentation, configuration, and data changes; file category must not become an exemption.

Build in one source-plus-tests delivery: first add failing cache regressions, then implement the sidecar and injectables, then clarify the header and rerun the existing recovery tests. This is a local IO optimization with no new standard API or runtime demo.

## Test plan

- In `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`, use at least three distinct valid heads and a duplicate-head PR, `source: 'fallback'`, a required name missing from both snapshot and valid REST rows, injected enrichment readers, fake numeric time, and a fresh temporary sidecar. Assert counts N, 0, 0, N at initial time, a later pre-expiry tick, TTL minus one, and exact expiry. Assert `ci-trigger-owed` for every affected ordinary PR, no false `check-read-failed`, and no CI heal/promotion. Repeat over the four file categories from Must 4.
- Reopen the persisted cache in a fresh module/process context using injected fixtures; prove the warm tick makes zero hydration reads. Do not rely solely on repeated calls sharing one Map. Inspect persisted observation times to prove hits do not renew the TTL.
- Exercise repository/head/required-set/snapshot changes, reordered equivalent evidence, current red and pending evidence, complete snapshots, empty REST rows, malformed sidecars/rows, unsupported versions, future timestamps, expiry, and storage pruning. A thrown REST read must retry next tick; a failed sidecar write must leave the planner's result intact and permit a later REST retry. Use temporary directories and clean them up.
- In `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`, retain the existing cancelled-check/throwing-read recovery case and pending/truncated-green cases. Add an explicit `FAILURE` conclusion variant and run it after a negative cache has been seeded, proving the new optimization cannot suppress recovery.

## Proof plan

Run the two scoped suites only through the host heavy-admission queue from the WE checkout (pass the paths `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` and `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs` with the repository prefix removed for CLI invocation). Save before/after counts from the new fallback regression: before implementation each sequential tick reads N heads; after implementation only the first and expired ticks do. Temporarily bypass persistent-cache lookup during implementation verification and confirm the warm-tick assertion fails; restore it before delivery. This distinguishes a useful guard from a same-pass-only test.

Use a child-process fixture with the same temporary sidecar to prove restart persistence without credentials or network. Record explicit dispatch/refusal assertions for known red versus unknown evidence, rather than inferring safety from read counts. Run `npm run check:standards` through the same queue after implementation. Use the runner at `we:scripts/readiness/heavy-admission.mjs` with one bounded `--wait-ms=60000` admission wait; if busy after that, stop and report. A production savings claim additionally needs the follow-up observation below; fixture counts alone prove only the deterministic bound.

## Acceptance

All named tests below are planned additions. Each must fail against the pre-cache implementation and pass after implementation; pair safety assertions with a warm-hit read-count assertion so an unchanged implementation cannot pass vacuously. Execute the named tests in the scoped suites through the host queue described in Proof plan.

- [A1] Executable — `4904 fallback sequential ticks bound hydration reads` in `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`: three heads plus a duplicate, each of the four file categories, counts N/0/0/N through exact expiry, unchanged observation time on hits, owed triggers for missing checks, no false refusal, no heal/promotion; unrelated planning still proceeds.
- [A2] Executable — `4904 warm cache preserves current evidence and recovery` in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: seed then hit a negative cache, introduce required FAILURE/CANCELLED/pending evidence, assert bypass and existing recovery behavior; a throwing read refuses visibly without discarding known evidence. Also assert complete snapshots and conflict/stacked exemptions still avoid REST, and warmed incomplete rows clear completeness/head claims while retaining roster provenance.
- [A3] Executable — `4904 cache survives fresh processes and isolates evidence keys` in `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`: real temporary sidecar across two child processes, zero warm reads; invalidate repository/head/required names/snapshot changes, retain hits for equivalent reorderings. Exercise raw and normalized persisted timestamps without losing evidence. Spawn Node with bounded output and hermetic injected readers; the suite's child-process mock must not replace this real spawn.
- [A4] Executable — `4904 corrupt expired and oversized caches degrade safely` in `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`: establish a warm hit, then corrupt version/rows/time or expire it and assert fresh reads; errors and complete responses never seed negative entries. Feed 513 entries, assert oldest eviction to 512 and a fresh read for the evicted head. Unreadable/unwritable storage preserves planner outcomes and falls back to REST; real read errors remain operator-visible refusals and retry on the next tick.
- [A5] Executable — `4904 default callers and readOnly honor cache lifecycle` in `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`: exercise the real default hydration reader with mocked transport and a temporary coordination root; CLI-style and redispatch-style calls share the default cache. A shadow-style read-only call hits an existing entry without changing bytes and never creates a missing file. Explicit null disables persistence; injected readers without a path remain isolated; explicit temporary paths enable reuse; the default TTL refreshes at 60,000 ms. Preserve this distinction through timing wrappers.

## Follow-ups

Locate the original post-deployment cost-review item before claiming it exists; if none exists, track that observation separately at implementation handoff. After deployment, compare hydration reads across repeated ticks with stable missing-name heads and record TTL refreshes, cache misses, and refusal/recovery outcomes. Tune the TTL only from that evidence. Global rate limiting, cross-host locking, changing repository fallback requirements, and caching positive CI results are outside this story.
