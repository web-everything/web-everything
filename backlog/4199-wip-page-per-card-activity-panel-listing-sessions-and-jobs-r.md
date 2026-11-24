---
bornAs: x62p7ex
kind: story
size: 3
parent: "3931"
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
blockedBy: ["4198"]
scope: ["plateau:docs/wip-page.md", "plateau:src/wip/wip-view.ts", "plateau:src/wip/wip-view.css", "plateau:src/wip/wip-read.ts", "plateau:src/wip/types.ts", "plateau:wip-relay.js", "plateau:src/wip/wip-view.test.ts", "plateau:src/wip/wip-view.hostile.test.ts", "plateau:src/wip/wip-read.test.ts", "plateau:src/wip/wip-source.test.ts", "plateau:src/wip/wip-relay-contract.test.ts", "plateau:scripts/wip-relay.test.mjs"]
dateOpened: "2026-09-25"
preparedDate: "2026-10-01"
preparedAgainstSha: "026425e9e4a9c067851692c796ec0620879dabcb"
tags: []
---

# /wip page: per-card activity panel listing sessions and jobs (review/fix/ci-heal/build) with transcript links

Add a snapshot-driven activity panel inside each Doing/Needs-you card's existing disclosure: list each matching session/job separately, with role, state, started/last-event time, outcome, and an openable transcript link or copyable path. Preserve #4198 as the producer dependency and #3931 as the parent; this is the non-live slice, not the fuller L2/L3 timeline.

## Progress

Preparation checked the current WE lane and Plateau checkout (Plateau HEAD `1debc8990f730b45bdfc0eab430f9a567f6de2c9`). Paths below use `we:../plateau-app/` to identify the sibling product; the machine-readable scope retains its canonical Plateau repo qualifier so dispatch does not mistake this for WE implementation.

- **Old premise:** cards only show claims/PRs and detached review jobs are invisible. **Corrected:** card details still lack activity rows (we:../plateau-app/src/wip/wip-view.ts:223–266), but the global Running now panel already shows state/times and copyable transcript paths (we:../plateau-app/src/wip/wip-view.ts:453–462). WE already includes review jobs through `listAgentsWithReviewJobs` and assigns their own logs as transcript pointers (we:scripts/operations/agent-activity-io.mjs:37,270–281). Do not recreate that collector or repeat “merged today.”
- **Old premise:** the reader only supplies the daemon-level shelling pattern. **Corrected:** it shares one `live-state` read between health and Running now, independently validates rows, and projects card/PR identity and transcript paths (we:../plateau-app/src/wip/wip-read.ts:278–315,386–415). `WipRunningRow` lacks an outcome field (we:../plateau-app/src/wip/types.ts:165–182). Global activity is therefore useful existing infrastructure, not proof this card's full goal shipped.
- **Dependency remains:** #4198 specifies the targeted query and outcomes (we:backlog/4198-add-review-job-records-as-an-agent-activity-source-join-sess.md:15). The current operation registry imports agent activity (we:scripts/operations/run.mjs:122–123); a repository search found no item-activity implementation, only forward references (we:scripts/operations/agent-activity.mjs:41,241). Treat #4198's exact envelope/flags as a producer contract to verify when it lands, not an existing API.
- **Old scope:** six reader/type/view files and tests. **Corrected:** include product documentation, relay validation and transport/hostile-input tests. The relay validates rendered items and uses closed source vocabularies (we:../plateau-app/wip-relay.js:26,292–321); a reader-only change is insufficient. Existing snapshot freshness is 120-second publication and a 600-second stale threshold (we:../plateau-app/src/wip/wip-source.ts:27–28), not a new live subscription.

## Design

1. Document the optional per-card activity projection in we:../plateau-app/docs/wip-page.md before implementation. Add an optional activity value to `WipItem`: observation time, completeness/availability, rows and a plain failure reason. Each row preserves producer identity, role, state, nullable start/last-event times, nullable outcome and transcript pointer. Unknown outcome/time stays explicitly unknown; never derive success from a dead PID or an absent session. Missing activity in an older snapshot means unknown, not empty. Existing item identity/PR fields are at we:../plateau-app/src/wip/types.ts:49–81.
2. In the reader, build the existing snapshot first, then enrich only Doing/Needs-you items with #4198's declared operation. Query by card identity so a pre-PR build and PR-associated jobs can both appear; use a repository-qualified PR query when that is the only available identity. Verify producer mapping supports both paths before integration. Deduplicate identical requests within a refresh, bound concurrency (two calls at once), and use argument arrays, timeouts and output limits following the existing operation call at we:../plateau-app/src/wip/wip-read.ts:161. No shell interpolation, per-render subprocess, separate polling loop or duplicated process scanner. The snapshot is assembled at we:../plateau-app/src/wip/wip-read.ts:463–479; enrichment after assembly avoids changing grouping and counts.
3. Validate the new optional payload at the reader and relay boundary with the same bounded validator. An unsupported operation, timeout, malformed payload or incomplete source affects that card's activity only. Preserve the rest of the snapshot. Render `No agent found` only for a fresh, complete, successful empty result; stale, partial, missing or failed evidence renders `?` with a reason, retaining any known rows as dated evidence. Page-level stale status also suppresses an empty-result assertion. This extends the existing independent-source validation pattern (we:../plateau-app/src/wip/wip-read.ts:313–315,411–415).
4. Render inside the existing native details element, preserving expansion over refresh (we:../plateau-app/src/wip/wip-view.ts:256–266). Keep distinct run identities even when role/PR match; do not collapse a review and fixer into one row. Use semantic list/labels, readable wrapping and text state labels; escape every producer string, including paths. Do not change card grouping or the global Running now list.
5. Use selectable, copyable path text for filesystem transcript pointers, including outside readable roots, matching the existing product behavior (we:../plateau-app/src/wip/wip-view.ts:454–456). Do not manufacture a file URL, browser link or filesystem-serving route. If the producer supplies an actually supported web transcript URL, validate it with the existing URL policy before rendering an anchor; otherwise retain the path fallback. Live proof must check the underlying file, not merely that text rendered. This preserves the original phone fallback goal without assuming a transcript server exists.

**Per-repo delivery split (#4289):** #4198 is the WE producer predecessor; #4199 is the Plateau reader/relay/view successor, with separate repo gates and PRs. The general per-repo profile rule is we:docs/agent/platform-decisions.md:5511 (`#conveyor-multi-repo-model`); the explicit split ruling is we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:18–20. No WE implementation files belong in this scope. Before building, verify #4198 exports the query, completeness, outcome and pointer data above. If an additional shared contract or operation registration is needed, propose a WE-only predecessor amendment with its own tests; do not quietly add WE writes to this Plateau card. Coupled delivery remains a future supported capability, not a prohibition on cross-repo features.

## MVP

Ship the optional documented activity payload, bounded reader integration, shared relay validation and per-card presentation together. Support build, fix, ci-heal and review rows; display additional producer roles faithfully. Preserve schema-1/schema-2 snapshots without the optional field as unknown, and pass the field through publication and fetch. The current fetch accepts both schemas (we:../plateau-app/src/wip/wip-source.ts:44–55), and the relay has separate schema-2 handling (we:../plateau-app/wip-relay.js:297–305); cover both validation paths.

Excluded: live interest/watch transport, token/tool timelines, remote transcript-file serving, session control, new activity discovery, outcome inference and changes to card priority/counts. #4198 must land before the consumer build is declared complete.

## Test plan

- **Capability (Red today):** extend we:../plateau-app/src/wip/wip-read.test.ts: review plus fixer on one card produces two rows; a pre-PR build matches by card; same PR number in another repository cannot leak in; duplicate query keys issue one call per refresh; concurrency stays bounded; timeouts, unsupported operation, malformed rows and partial results yield unknown without breaking healthy cards. Verify explicit outcomes survive projection and unknowns are not invented.
- **Capability (Red today):** extend we:../plateau-app/src/wip/wip-view.test.ts and we:../plateau-app/src/wip/wip-view.hostile.test.ts: every row field, empty/failure/stale distinctions, absent legacy data, multiple same-role jobs, escaped hostile values, long paths, and copyable outside-root pointers with no dead anchor. Include completed/failed/unknown outcomes and missing timestamps. Existing path-escaping coverage starts at we:../plateau-app/src/wip/wip-view.test.ts:235.
- **Capability (Red today):** extend we:../plateau-app/src/wip/wip-relay-contract.test.ts, we:../plateau-app/scripts/wip-relay.test.mjs and we:../plateau-app/src/wip/wip-source.test.ts: publisher→relay→fetch round trip, schemas 1 and 2, legacy absent fields, null/error versus successful empty, invalid dates, oversized strings/arrays, and scope-less schema-2 validation. New fields must survive transport and be validated wherever rendered.
- **Preservation (GREEN today):** run the full Plateau WIP Vitest directory plus the relay script suite using Plateau's configured test runner; run the Plateau repo gate. Browser-check keyboard disclosure, expansion preservation through refresh, narrow phone layout, visible focus, accessible labels and states distinguishable without colour. Mutation proof: make snapshot refresh discard the open-card set, or remove the existing path escaping; the corresponding preservation assertions must fail. “GREEN today” classifies existing behavior to preserve, not a test run performed in this preparation. Preparation itself does not execute or claim these future implementation tests.

## Proof plan

1. After #4198 lands, capture its real targeted output for an in-flight card/PR with both a review job and fixer. Record repository, card, PR, run identities, timestamps and producer revision. Confirm each transcript/log pointer resolves to a real non-empty file; do not equate a fixture or filename with this observation.
2. Open the dev or deployed /wip route against that snapshot and expand the matching Doing/Needs-you card. Capture both separate rows with role, state, times, outcome (or explicitly unknown), and transcript link/path. Verify a supplied web link opens readable content; for filesystem paths, copy/select the displayed path and verify the file on the host.
3. Observe a subsequent refresh update the activity while preserving expansion. Exercise a successful empty query, then a failed/partial source and a stale snapshot: only the first may say `No agent found`; the others show `?`. Confirm another healthy card remains usable and no additional live subscription was introduced.
4. Capture passing Plateau tests/gate and browser evidence with exact revisions. Deployed proof must include a publisher→relay→phone read; a reader unit test alone cannot establish that the panel reached the phone.

## Follow-ups

- Recheck #4198's delivered contract at implementation time; the current card describes required consumer behavior, not a fabricated producer envelope. Any missing producer capability belongs in its WE predecessor with contract/operation tests before dispatching the consumer.
- Keep live L2/L3 disclosure under #3931's broader work; transcript streaming or a guarded file-serving endpoint requires its own design and scope.
- Testing lesson: local view fixtures cannot prove relay compatibility, source freshness or transcript existence. Keep the live two-run proof and old-snapshot cases on this card; do not append shared agent documentation.

## Done when

The scoped Plateau tests and repo gate pass; a real card displays its review job and fixer separately with all required fields and verified transcript access/path fallback; healthy-empty, unknown and stale evidence remain distinguishable; publisher/relay compatibility and keyboard/phone use are observed. This preparation changes only the card and does not implement or claim that proof.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22): the per-card activity panel (sessions and jobs) is built once in the Delivery detail sheet, not on /wip.
