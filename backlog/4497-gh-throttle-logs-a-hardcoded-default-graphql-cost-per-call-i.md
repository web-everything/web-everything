---
bornAs: xh2341j
kind: story
size: 3
parent: "3861"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs", "we:scripts/lib/__tests__/gh-throttle.budget-block.test.mjs", "we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "a39c670284815109bb0948eb00f2c588a739a322"
tags: []
---

# gh-throttle logs a hardcoded default GraphQL cost per call instead of GitHub's real reported cost, undercounting true spend

Expose measured GraphQL spend on each call-ledger entry when the captured responses actually report it. Keep the caller-declared `points` (default 1) intact: it is an admission estimate, not a measurement of GraphQL primary-budget consumption. Add an optional `realPoints` total without presenting shared-account counter movement as exclusive caller spend.

## Progress

Preparation research corrected the original premise and scope:

- **Old premise:** header capture was opt-in; consecutive same-identity `used` values represented a call's real cost; the exhaustion parser could supply the sequence. The original incident narrative cited five exhaustions on 2026-09-29, approximately one-fifth snapshot coverage, approximately 2.1 points per declared point for the fix procedure, and four counter increments for one PR edit. Those historical measurements were not reproduced in this preparation and are not acceptance evidence.
- **Current evidence:** `we:scripts/lib/gh-throttle.mjs:162-174` documents default capture for both entry points, subject to capture exclusions and the kill switch. `stripGhDebug` already extracts explicit response-body `data.rateLimit.cost`, and `rateLimitRecords` retains it as `rl[].cost` (`we:scripts/lib/gh-throttle.mjs:830-870`). The two call-log sites still pass declared `points` plus raw `rl` (`we:scripts/lib/gh-throttle.mjs:1621-1624` and `we:scripts/lib/gh-throttle.mjs:1852-1855`). `recordGhCallLogEntry` only appends the supplied entry (`we:scripts/lib/gh-throttle.mjs:1455-1461`); there is no aggregate measured-cost field.
- **Corrected premise:** `parseGhDebugResponseHeaders` retains only the last response block (`we:scripts/lib/gh-throttle.mjs:730-744`). Shared counters include concurrent traffic, and their first observation lacks a baseline. The existing accounting explicitly attributes only in-band costs and leaves legacy costs unknown (`we:scripts/lib/gh-spend.mjs:12-15`, `we:scripts/lib/gh-spend.mjs:165-186`). A delta-based `realPoints` would contradict that contract. Use existing explicit response costs instead; do not infer missing costs from counters.
- **Old scope:** the throttle source and its main and budget-block suites. **Corrected scope:** retain those paths and add the existing capture/fidelity suite, `we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs`, which exercises both entry points. No spend-report implementation changes are necessary. Historical caller references resolve to `we:scripts/conveyor/fix-procedure.mjs` (throttle import at line 586) and `we:scripts/pr-land.mjs`, not the originally stated repository-root paths; neither caller needs editing.

- **Revalidation against the current checkout:** the earlier preparation already narrowed the goal to an explicit-cost aggregate; that goal remains undelivered at `we:scripts/lib/gh-throttle.mjs:1455-1461`. Its line citations have been refreshed above. Old scope and current scope both contain the throttle source and the three matching suites in frontmatter; no additional source or test file is needed. Size remains **3**: one shared append boundary serves both call sites, with existing logger and wrapper harnesses.
- **Coverage correction:** `rateLimitRecords` drops responses without `x-ratelimit-used` (`we:scripts/lib/gh-throttle.mjs:863-870`). Consequently, the aggregate covers only retained `rl` records, not every captured response or every request in an invocation. Test this omission explicitly instead of claiming complete capture.
- **Test execution correction:** `we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs:36-55` probes authentication and conditionally enables live GitHub tests. Use the offline groups with a test-name filter; do not run that entire file unfiltered as proof requiring no live API traffic. The passthrough uses an injected spawn (`we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs:181-197`); the sync wrapper also has a real fake-process harness (`we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs:299-334`).

## Design

In `we:scripts/lib/gh-throttle.mjs`, enrich actual `outcome: 'call'` entries at the shared `recordGhCallLogEntry` boundary. Preserve `points`, `rl`, identity, invocation, attempt, and outcome fields. Derive an optional `realPoints` from the sum of explicit, nonnegative safe-integer `cost` values on GraphQL response records. Require a nonempty array of records, at least one record labeled `res: 'graphql'`, a nonempty string resource label on every record, and a valid explicit cost on every GraphQL record; omit the aggregate if these conditions fail or the sum is not a safe integer. Explicit zero is measured zero, not missing data.

For mixed REST/GraphQL records, sum only GraphQL costs; document `realPoints` as measured GraphQL primary points represented by this attempt's retained `rl` records, not total cross-resource spend or proof of complete network capture. Never use the top-level resource guess to override response resource labels. An unknown response resource makes the aggregate unavailable. A missing cost on any retained GraphQL record makes the aggregate unavailable. Responses discarded upstream for missing rate-limit headers cannot be detected at this boundary; document that limit explicitly.

No previous-entry baseline, file reread, shared state, additional request, query rewriting, or counter subtraction is needed. Retain best-effort logging and all admission, retry, debug stripping, and budget-block behavior. Missing measurements leave the existing declared-default behavior unchanged; consumers must not describe that fallback as measured spend. Existing raw costs and spend-report attribution remain authoritative; the new aggregate is a convenience on the call line, not a replacement accounting engine.

Keep the exported `recordGhCallLogEntry(logPath, entry)` signature and undefined return unchanged. Existing ledger lines need no migration; new lines add only an optional numeric field. Compute it from `rl` for `outcome: 'call'` regardless of success, preserving best-effort failure handling. Ship the source enrichment and its tests together as one additive change; no caller rollout or feature flag is needed.

## MVP

1. Extend the logger's documented entry shape and recording comment in `we:scripts/lib/gh-throttle.mjs` with the optional measured GraphQL total and its coverage limitation. Implement the deterministic enrichment inside the existing best-effort append boundary, without mutating the caller's entry.
2. Add focused logger fixtures in `we:scripts/lib/__tests__/gh-throttle.test.mjs` and capture-to-ledger assertions for both wrappers in `we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs`.
3. Retain the existing budget-block regression suite, `we:scripts/lib/__tests__/gh-throttle.budget-block.test.mjs`, to verify that measurement does not change exhaustion handling. No production caller edits or live GitHub traffic are required.

## Test plan

- In `we:scripts/lib/__tests__/gh-throttle.test.mjs`, append a call with declared `points: 1` and two GraphQL responses with explicit costs 2 and 3; read the ledger and assert `realPoints: 5`, unchanged `points: 1`, and unchanged raw records/input object.
- Cover zero cost, absent/empty records, one missing GraphQL cost among measured responses, negative/fractional/nonfinite/unsafe costs, overflow, unknown resource, REST-only records, and mixed resources. Also cover null/malformed records and non-array `rl`; these must leave the call logged without a measured total. Non-call diagnostic entries must not acquire a measured total. Retain a failed-append test to prove logging still never throws.
- Replay counter-only records with increasing `used`, resets, and different identities; none may acquire `realPoints`. Include an explicit-cost fixture whose counter jump exceeds its cost to prove that concurrent bucket movement cannot inflate the total.
- In `we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs`, feed complete synthetic debug blocks with response-body costs through both real wrapper capture paths, using the existing fake-process harness. Check success and failed-attempt logging, per-attempt isolation on retry, unchanged stdout/stderr, and omission when capture is disabled or costs are absent.
- Add a capture fixture containing a response without `x-ratelimit-used`; assert that it is absent from `rl` and that any aggregate describes only retained records. Keep synthetic traces inline or in temporary files so no additional fixture path is required.
- Run the main and budget-block suites, and the offline fidelity groups, through the host heavy-run queue only. This is tooling-only work; no rendered-page or standard conformance demo changes are involved.

## Proof plan

The executable regression is the two-response logger fixture in `we:scripts/lib/__tests__/gh-throttle.test.mjs`. Run it with Vitest's test-name filter before implementation: current code preserves `points: 1` but has no `realPoints`, so the expected total of 5 must fail. Run the identical fixture after implementation and require it to pass. Preserve the RED/GREEN output for review.

For implementation verification, invoke `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run`, supplying the two scoped main/budget-block test paths. Run the fidelity file separately with `-t '^(stripGhDebug|runGhCliPassthrough|runGhSync)'` to exclude its live side-by-side group. The module-level authentication probe still runs; the selected tests use fixtures and fake processes. Apply the same queue and the chosen logger test-name filter for RED/GREEN. Run the standards gate through that queue with `run -- npm run check:standards`. All test paths are the repository-relative forms of the `we:`-prefixed scope entries. Inspect the temporary ledger produced by the wrapper fixtures: each attempt must show the declared value alongside the measured total when available, with raw response evidence sufficient to recompute that total. A counter-only fixture must still lack the measured field. These controlled probes prove the logging contract; they do not claim to reproduce the historical production incident or establish complete account-wide attribution. The runner owns preparation stamping and checks; this preparation does not implement or execute the proposed regression.

## Done when

The regression above fails on the original logger and passes after the change; both wrapper paths emit the measured GraphQL total from complete explicit-cost records, preserve declared points and caller-visible behavior, and leave unmeasured costs unclaimed. MVP 1 is complete when the logger regression and omission cases pass; MVP 2 is complete when both offline wrapper paths preserve caller-visible behavior and isolate retry attempts; MVP 3 is complete when the budget-block suite and queued standards gate pass.

## Follow-ups

Preserving response evidence currently dropped for absent rate-limit headers, increasing explicit-cost coverage for queries that do not return `rateLimit.cost`, changing report presentation, and measuring production capture coverage are separate work. Do not silently rewrite queries, enable extra requests, or relabel counter deltas as caller costs in this item. No follow-up is required to ship the bounded logging improvement.
