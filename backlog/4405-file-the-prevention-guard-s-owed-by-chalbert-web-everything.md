---
bornAs: xv72gek
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs", "we:scripts/conveyor/lease-reaper.mjs", "we:scripts/conveyor/__tests__/lease-reaper.test.mjs", "we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.mjs", "we:scripts/conveyor/soak/breaks/fixtures/lease-reaper-graphql-unattributed.mjs", "we:scripts/conveyor/soak/breaks/fixtures/__tests__/lease-reaper-graphql-unattributed.test.mjs", "we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/lease-reaper-graphql-unattributed.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "669efb6dd4272c14806b7ee2ba58905497f47f52"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2902's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). The accepted review owed acquire-time REST argv coverage, merged-REST reduction coverage, endpoint-faithful mocks, and distinct REST/GraphQL soak responses. Preserve those prevention goals; the original seven bullets included three overlapping mapper assertions whose expected uppercase state is not the current reducer contract.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2902@ffa521d2fdabbeb4c688d457ee8e48a95d38ab6b

## Progress

- Prepare-validation repair: the previous scope relied on we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.soak.test.mjs to cover the child fixture indirectly. Inspection of we:scripts/conveyor/soak/breaks/fixtures/lease-reaper-graphql-unattributed.mjs confirms it is a separate executable reporting only `ok`, `axisOn`, and `itemCount` on success. Add planned we:scripts/conveyor/soak/breaks/fixtures/__tests__/lease-reaper-graphql-unattributed.test.mjs as its matching report-contract test; the existing soak coverage and prevention goal remain unchanged.

- Preparation research: original scope named the generic we:scripts/__tests__/lane-pool.test.mjs and a nonexistent we:scripts/conveyor/soak/breaks/__tests__/lease-reaper-graphql-unattributed.test.mjs as if it existed. The acquire integration harness actually lives in we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs; the existing soak entry is we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.soak.test.mjs. Keep the previously named soak unit path as a **planned** fixture-contract guard. Add the existing child fixture to scope because its report currently omits the reduced state.
- Old premise: we:scripts/conveyor/lease-reaper.mjs:681–683 needed to map REST `state: 'closed'` plus `merged_at` to uppercase `MERGED`. Corrected premise: `restPullToPrStateShape` at we:scripts/conveyor/lease-reaper.mjs:745 preserves `state` and maps `merged_at` to `mergedAt`; `reduceDetails` at we:scripts/conveyor/lease-reaper.mjs:766 recognizes that timestamp and produces lowercase `merged`. A direct Node import probe with a REST-shaped merged pull returned mapped `state: "closed"` and item map `[["181","merged"]]`. This is observed working behavior, not a missing production fix.
- Current call sites are we:scripts/lane-pool.mjs:1662 and we:scripts/conveyor/lease-reaper.mjs:1247, both using `ghRestGetPaged` followed by the mapper. The original acquire citation at we:scripts/lane-pool.mjs:1556 is now the beginning of candidate collection, not the API call.
- Remaining gaps: we:scripts/conveyor/__tests__/lease-reaper.test.mjs:342 tests only the mapper with a hand-built partial REST object; the fetch test at line 1029 supplies GraphQL data to REST. In we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.mjs:55–70 both fake commands return the same GraphQL body. Its child we:scripts/conveyor/soak/breaks/fixtures/lease-reaper-graphql-unattributed.mjs reports item count, not state. The acquire fake at we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs:49 returns the same body for every argv and records none.
- Corrected scope: preserve production semantics, strengthen both consumer tests and the soak, and document the endpoint-fixture review convention in we:docs/agent/testing.md. Production files remain scope anchors for their matching regression tests and any misleading comments; no runtime API change is required. Size 3 remains a bounded guard-and-fixture change. No implementation, stamp, or independent-review verdict is claimed here; the runner owns checks and parked review.
- Re-prepare (2026-10-09, main moved since a001796): premise re-verified on current main; REST mapper and reducer behave as described and no guard is delivered yet. Citations refreshed: mapper we:scripts/conveyor/lease-reaper.mjs:745, reduceDetails we:scripts/conveyor/lease-reaper.mjs:766, fetch we:scripts/conveyor/lease-reaper.mjs:1247, REST call we:scripts/lane-pool.mjs:1662, mapper test we:scripts/conveyor/__tests__/lease-reaper.test.mjs:342. Scope and size unchanged.
- Re-prepare (2026-10-09, after #4581): production files shifted lines only (unrelated hardening edits); behavior unchanged, no guard delivered. Current citations: mapper we:scripts/conveyor/lease-reaper.mjs:759, reduceDetails we:scripts/conveyor/lease-reaper.mjs:780, fetch we:scripts/conveyor/lease-reaper.mjs:1288, REST call we:scripts/lane-pool.mjs:1676, mapper test we:scripts/conveyor/__tests__/lease-reaper.test.mjs:342 (unchanged). Scope and size unchanged.

## Design

Keep `restPullToPrStateShape` and the reducers' current interfaces. REST `closed` plus a non-null merge timestamp must reduce to `merged`; unmerged `closed` to `closed`; `open` to `open`. Preserve the existing open-wins priority and both item-number and PR-number keyspaces. The normalized mapper object still contains `number`, `state`, `headRefName`, `mergedAt`, and `mergeCommit`.

Use captured endpoint responses at the subprocess boundary. During implementation, collect a real merged pull from the REST **list** endpoint through read-only `gh api`, and the corresponding GraphQL-backed `gh pr list --json` response. Record endpoint, command, capture date, and any sanitization alongside the fixture. Retain the REST merge fields and nested branch shape unchanged; do not relabel GraphQL data as REST. Embed the relevant captured records in the scoped tests/break, with provenance comments, so no unscoped fixture file is needed. Derive assertion keys from captured PR number/head ref; use explicitly marked synthetic variants only for boundary cases. Tests replay locally without GitHub credentials.

In we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.mjs, write separate REST and GraphQL response files. Dispatch the fake by argv: `pr list` receives GraphQL JSON; `api -i` for the pulls endpoint receives HTTP headers plus REST JSON. Retain argv and attribution checks. Extend we:scripts/conveyor/soak/breaks/fixtures/lease-reaper-graphql-unattributed.mjs to report the reduced maps; the break must assert the captured merged pull's state in both keyspaces, not merely a nonempty map. Expose the fixture bodies through a small named export in the break for the planned fixture-contract unit test.

Extend the existing acquire integration fake to log argv and distinguish response schemas. Exercise the real acquire child against its disposable pool, with private throttle and ETag directories. Assert a pulls call beginning `api -i`, no `pr list`, the stale merged lease reaped with reason `pr-merged`, and the fresh twin retained. A successful acquire alone is insufficient because the PR axis can silently turn off.

Document the review convention in we:docs/agent/testing.md: endpoint-boundary mocks use recorded payloads with provenance and schema-preserving sanitization; synthetic reducer edge cases are labeled separately. This implements the review's convention option. The repo-wide lint mentioned as longer-term debt remains a follow-up.

## MVP

1. Capture and annotate the two endpoint payloads; correct the REST fetch test and add mapper-to-reducer coverage in we:scripts/conveyor/__tests__/lease-reaper.test.mjs.
2. Split soak responses, extend the child report, and add the fixture-contract unit suite at we:scripts/conveyor/soak/breaks/__tests__/lease-reaper-graphql-unattributed.test.mjs. Add the child report-contract suite at we:scripts/conveyor/soak/breaks/fixtures/__tests__/lease-reaper-graphql-unattributed.test.mjs. Reuse the existing soak wrapper.
3. Add acquire argv assertions and REST response handling in we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs; retain fresh-lease protection.
4. Add the endpoint-fixture convention and correct misleading touched comments. Deliver these guards together in one reviewable change; no data migration or production state-vocabulary change.

## Test plan

- we:scripts/conveyor/__tests__/lease-reaper.test.mjs: captured REST list record → mapper → `prStatesFromList`, `prStatesByPrNumber`, and `prDetailsFromList`; assert lowercase merged state, timestamp and merge SHA. Cover unmerged closed, open, GraphQL compatibility, and an open retry winning over a merged predecessor. Fetch coverage must use REST headers/body and assert `api -i` plus the expected repo endpoint.
- we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs: actual child-process acquire logs REST pulls argv; stale merged lease is reaped, fresh merged lease survives, and the PR axis cannot pass by becoming unavailable. Clean up private pool, throttle, and ETag roots.
- Planned we:scripts/conveyor/soak/breaks/__tests__/lease-reaper-graphql-unattributed.test.mjs: fixture-contract assertions reject GraphQL keys in the REST fixture, require nested `head.ref`, lowercase state and merge timestamp, and check the separate GraphQL fixture's keys. Exercise the break judge's wrong-state failure.
- Planned we:scripts/conveyor/soak/breaks/fixtures/__tests__/lease-reaper-graphql-unattributed.test.mjs: launch the child fixture with a disposable repo root supplying a controlled reaper module; assert that its JSON report preserves merged state in both item and PR keyspaces, reports a null fetch as `axisOn: false`, and reports a thrown fetch as `ok: false`. This directly guards the child report independently of the break judge.
- Existing we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.soak.test.mjs covers both the break source and its child fixture, including REST argv, attribution and merged-state report.

## Proof plan

Run the focused Vitest suites above (the soak wrapper uses we:vitest.soak.config.ts), then `npm run check:standards`. Command paths below use repo prefixes; strip `we:` when invoking from the WE checkout:

- `npx vitest run we:scripts/conveyor/__tests__/lease-reaper.test.mjs we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs we:scripts/conveyor/soak/breaks/__tests__/lease-reaper-graphql-unattributed.test.mjs we:scripts/conveyor/soak/breaks/fixtures/__tests__/lease-reaper-graphql-unattributed.test.mjs`
- `npm run test:soak -- we:scripts/conveyor/soak/breaks/lease-reaper-graphql-unattributed.soak.test.mjs`

Before implementing the split, run the new fixture-contract assertion against the old shared body: it must fail for GraphQL-shaped REST data. Afterward, independently mutate the acquire call back to `pr list`, drop the mapper's merge timestamp, and substitute the GraphQL body on the REST soak branch. Each relevant guard must fail for its intended invariant; restore each mutation before the final green run. Capture command, exit status, and failing assertion. Existing correct reduction tests may already pass before the change; do not present them as a production red-to-green fix.

## Done when

1. Both consumer paths have executable guards for REST argv and successful merged-state reduction, with fresh-lease retention preserved.
2. The soak uses distinct endpoint-faithful bodies, checks reduced states, and continues checking attribution.
3. Captured payload provenance and the review convention are present; focused tests, mutation controls, and standards checks have recorded results.

## Follow-ups

The original longer-term suggestion to lint bare `execFileSync` calls to `gh pr list` across we:scripts/ remains outside this bounded guard change. A future lint needs explicit endpoint/exception coverage; do not introduce a blanket repository policy here. No follow-up is needed for uppercase mapper output: that premise is corrected above, while the actual merged-state contract is covered end to end.
