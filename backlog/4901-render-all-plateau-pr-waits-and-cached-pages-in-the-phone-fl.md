---
bornAs: xnwxew9
kind: story
locus: plateau-app
size: 3
parent: "4623"
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
blockedBy: ["4894", "4900"]
scope: ["plateau-app:src/wip/wip-view.ts", "plateau-app:src/wip/wip-view.css", "plateau-app:src/wip/wip-view.test.ts", "plateau-app:src/wip/wip-view.hostile.test.ts", "plateau-app:tests/wip-progress.spec.ts"]
dateOpened: "2026-10-01"
tags: []
---

# Render all Plateau PR waits and cached pages in the phone Flow view

Show every observed PR in counted wait groups with full descriptions, reachable waiting-chain details and honest paging coverage. Preserve human prerequisites, existing decision links and disclosure focus across mobile updates and reconnects.

## Design

Render all primary groups, counts and disclosure, including empty groups, with one fully wrapped description per PR and reachable chain details. Reuse native disclosure already used by the WIP view (we:../plateau-app/src/wip/wip-view.ts:250); no custom disclosure listeners. Preserve disclosure/focus/scroll on updates. Treat title, raw reason, links and paths as untrusted text; permit safe links only and never publish absolute host paths/transcripts. CSS currently clamps descriptions (we:../plateau-app/src/wip/wip-view.css:146); remove clipping on the new flow path. No new approval/merge/stop control.

Consume both predecessor outputs, show every primary group including empty ones, and count each repo/number exactly once across loaded pages. Group totals describe the accepted collection, not only visible pages; show pending versus actionable human counts and preserve system prerequisites. Author/card/epic filters never change global totals. Every row exposes current wait, owner/reason/age, queue/blocker/shared-file evidence, holder/since, conditional next steps and ETA or its specific unknown reason. Missing/truncated repo observations cannot claim all-PR completeness. Do not add approval/merge/stop controls.

## Observed seam and scope

we:../plateau-app/src/wip/wip-view.ts:343 renders the schema-2 summary/actions; :569 mounts snapshot/live updates. Extend that existing surface and recheck #4057 for Fleet overlap before build. Native disclosure is present at :250; reuse it, preserving focus/scroll/open state. The current wrapping rule at we:../plateau-app/src/wip/wip-view.css:197 supersedes the old preparation's blanket clamp diagnosis: test the new Flow path rather than assuming it needs global CSS removal. Existing renderer/hostile tests anchor the new cases. Proposed we:../plateau-app/tests/wip-progress.spec.ts uses the owning browser harness.

Budget: **5 implementation/test paths, 2 areas** (we:../plateau-app/src/wip/ and we:../plateau-app/tests/), plus card close-out. Only the browser spec is a new file. Exact touch set is frontmatter scope.

## Test plan / Done when

- **Capability — Red today expected (not executed during this backlog split):** View/hostile tests prove full descriptions, safe links/text, all groups/rows reachable, truthful partial/offline coverage and global totals invariant under filtering. Keep decision links, human prerequisites and human action counts; pending review/fix stays Flow without explicit human disposition.
- **Capability — Red today expected (not executed during this backlog split):** Drive 320/390px browser screenshots, keyboard traversal and axe. Check visible focus, accessible names, landmarks, one h1/ordered headings, no clipping or horizontal overflow, restrained live announcements and retained disclosure/focus/scroll after updates.
- **Capability — Red today expected (not executed during this backlog split):** Save sanitized snapshots for all three repos with producer timestamps and a repo/number manifest. Run publisher → relay → same-origin browser, load all pages and compare exact rendered union/counts to that manifest. Repeat with missing/truncated repo observations.
- **Capability — Red today expected (not executed during this backlog split):** Capture contemporaneous refusal/claim/run evidence, compare blocker/shared file/holder/start, then observe a later pass changing the wait. Show controlled known ETA and insufficient-history unknown; record unsupported producer fields rather than inventing them.
- **Capability — Red today expected (not executed during this backlog split):** Observe two 120-second publish cycles plus a second tab with process/network instrumentation and GitHub ledger attribution. Require zero calls attributable to collection/page asks/extra tab, accounting separately for unrelated legacy history activity.
- **Capability — Red today expected (not executed during this backlog split):** Disconnect/reconnect publisher and replay old snapshots/pages; preserve rows and age honestly, mark unreachable remainder and reject cross-snapshot unions. Run focused WIP suites and affected relay suites plus the owning gate. Record proof commands, source identities, results and limitations here and on the epic.

## Follow-ups

#4624 owns broader standalone running/held-work discovery. Consume its evidence if available; it is not a hidden prerequisite. Preserve the umbrella's producer-enrichment/history follow-ups without expanding this UI story.

## Delivery boundary

This is one story under #4623; its prepared Design, MVP and Proof plan remain the umbrella acceptance. No implementation was performed while splitting. Reconcile predecessor interfaces before build and capture expected failing capabilities before changing code. All tests use sanitized fixtures, injected clock/IO and network/process spies, never live claims. A missing source means unknown with a reason. No new GitHub polling, approval, dispatch or merge behavior is authorized.

Build only the listed scope. Re-probe the touch set if upstream interfaces move; split again before exceeding 20 paths or 4 areas. Run the affected suites and the owning repository gate, recording commands, source identities and limitations on this card. Keep testing lessons in Follow-ups rather than shared agent docs.
