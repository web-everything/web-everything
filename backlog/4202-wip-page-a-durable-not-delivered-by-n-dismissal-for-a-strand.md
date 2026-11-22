---
bornAs: xkol9y8
kind: task
parent: "4075"
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
scope: ["plateau:docs/wip-page.md", "plateau:src/wip/stranding-dismissals.ts", "plateau:src/wip/stranding-dismissals.test.ts", "plateau:src/wip/wip-view.ts", "plateau:src/wip/wip-view.test.ts", "plateau:src/wip/wip-mount.test.ts"]
dateOpened: "2026-09-25"
preparedDate: "2026-10-01"
preparedAgainstSha: "026425e9e4a9c067851692c796ec0620879dabcb"
tags: []
---

# WIP page: a durable 'not delivered by #N' dismissal for a stranded row that's only a slice or a note

Follow-up from #4201. Let the operator record that a particular merged PR delivered only a slice or a note, and stop repeating that delivery question in the WIP page. Keep the card open and preserve other evidence. This is a Plateau presentation feature, not a backlog resolution or health-watch silence.

## Progress

Prepared against WE HEAD `026425e9e4a9c067851692c796ec0620879dabcb` and Plateau HEAD `1debc8990f730b45bdfc0eab430f9a567f6de2c9` by reading the current paths below. Plateau citations use the WE-relative sibling locator `we:../plateau-app/`; frontmatter retains the machine's canonical `plateau:` scope qualifier so dispatch selects the correct repository.

- **Old premise:** merged evidence repeatedly asks a Needs-you question every 10 seconds. **Corrected:** the current model puts merged bookkeeping into **doing**, with unknown liveness and no resolve action (we:../plateau-app/src/wip/wip-model.ts:235–242). The view still shows a warning asking for confirmation and links to check each merge (we:../plateau-app/src/wip/wip-view.ts:190, :250–254). Polling is 15 seconds (we:../plateau-app/src/wip/wip-view.ts:555); websocket snapshots also repaint the page (same file:589–608). The goal is therefore still outstanding, but restoring the old Needs-you/resolve behavior would be wrong.
- **Matcher premise confirmed:** Plateau loads the WE sweep (we:../plateau-app/src/wip/stranded-read.ts:64–66) and maps its hits to PR URLs (same file:154–169); stale-claim uses the same sweep (we:scripts/conveyor/health-smells/stale-claim.mjs:40, :130). The sweep does not read a dismissal annotation: it matches open/active non-epic cards and caps the returned hits (we:scripts/backlog-stranded-sweep.mjs:155–175). “dismissedPrs-style” was an analogy, not an existing integration seam.
- **Silence qualification:** health-watch has independent persisted silences (we:scripts/conveyor/health-watch.mjs:861–869), with expiry/re-raising (we:scripts/conveyor/health-watch-core.mjs:407–417). They are not a permanent per-card/PR dismissal consumed by the WIP page.
- **Old scope:** three Plateau model/reader files, without UI or tests. **Corrected scope:** the page renderer/mount, a proposed browser-local dismissal helper and its tests, existing renderer/mount tests, and the product page specification. The existing pure renderer and repaint seam are we:../plateau-app/src/wip/wip-view.ts:380 and :582–587; mounted-source tests already exist at we:../plateau-app/src/wip/wip-mount.test.ts:19–29. No source reader or shared matcher edit is needed for the page-local option explicitly allowed by the original card.

## Design

Use a versioned browser-local store for the WIP page. “Durable” here means surviving polls, pushed snapshots, navigation, reload and browser restart in the same origin/profile; it does not promise cross-device synchronization or survival after browser storage is cleared. State that boundary next to the dismissal control. This selects the original card's WIP-page-local note-store option.

Before implementation, update we:../plateau-app/docs/wip-page.md:15–31 to describe current Flow bookkeeping and this dismissal state. Those lines still describe the older Needs-you/resolve behavior; current implementation evidence above takes precedence over that stale narrative.

For each matched PR provide **“Not delivered by #N — only a slice/note”** and an accessible restore action. Key records by card identifier plus normalized repository identity and PR number, extracted from the matched PR URL already supplied by we:../plateau-app/src/wip/stranded-read.ts:162–165. Do not key by PR number alone, epic, title, or row index. Reject malformed identities rather than risk dismissing another repository's PR.

Keep the received snapshot immutable. Pass local dismissal state into the pure renderer; project only the delivery evidence at render time. Suppress the dismissed match's warning, check prompt and repeated delivery implication, while keeping an unobtrusive saved note with Restore. If another matched PR remains, show that PR's evidence and question. If every match is dismissed, replace the merge-only explanation with “Delivery matches dismissed on this browser; card remains open/active.” Keep the card, its group, liveness, totals and progress unchanged: the page does not have the raw inputs needed to safely reclassify it. Do not replace an independent already-done stall explanation with a dismissal note; that reason precedes merged evidence in we:../plateau-app/src/wip/wip-model.ts:231–238.

Persist successfully before showing a saved dismissal. Missing storage means no saved notes; malformed data or unavailable/quota-denied storage produces a visible recoverable error and leaves evidence visible. Restore is also persisted before changing the display. Mount and unmount must load/clean up their local state and subscriptions; test through both poll and pushed-snapshot paint paths. Compose existing disclosure behavior if a saved-note disclosure is needed; the page already uses `nav:section` (we:../plateau-app/src/wip/wip-view.ts:539).

## MVP

1. Document the behavior and storage boundary in the Plateau page specification.
2. Add we:../plateau-app/src/wip/stranding-dismissals.ts (proposed): identity validation, versioned storage decoding, idempotent save/restore, and injectable storage for tests.
3. Integrate dismissal and Restore into we:../plateau-app/src/wip/wip-view.ts:190, :233, :252 and :569. Preserve focus across repaint and expose save failures to assistive technology. Keep saved notes inspectable without recreating an action-demanding warning.
4. Add helper tests and extend existing view/mount tests listed in scope. No backlog annotation, health-watch mutation, matcher change, publisher/relay protocol change or remote command is part of this MVP.

**Repository delivery:** implementation and tests are Plateau-only. This WE card is the planning carrier. Under the #4289 ruling (we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:18), a future shared annotation design would require a separately useful WE predecessor (annotation contract, sweep semantics and tests), followed by a Plateau consumer/UI successor blocked on it. Do not add that mixed implementation scope to this card or silently omit WE files to bypass admission. No split is needed for the selected browser-local MVP, and no additional cards are created in this preparation.

## Test plan

- Proposed we:../plateau-app/src/wip/stranding-dismissals.test.ts: round-trip through a fresh store instance; card/repository/PR isolation; duplicate save; restore; malformed JSON/version/identity; missing storage; thrown reads/writes and quota errors. Never report persistence after a failed write.
- Extend we:../plateau-app/src/wip/wip-view.test.ts at the renderer seam (we:../plateau-app/src/wip/wip-view.ts:380): two matches, one dismissal, all dismissed, a new PR, saved-note restore control, escaped hostile text, and unchanged group/count/progress. Assert independent stall/review/CI/degraded evidence remains visible; current grouping precedence is we:../plateau-app/src/wip/wip-model.ts:220–242.
- Extend we:../plateau-app/src/wip/wip-mount.test.ts:19–29: click → successful persistence → next poll → pushed snapshot → unmount/remount preserves the dismissal; Restore re-exposes only the selected match. Verify failure messages, keyboard access and retained focus through repaint. Use injected sources/storage; no live backlog or GitHub writes.
- Run in the Plateau implementation checkout (the helper suite is proposed, not present or passing during preparation):

```bash
npx vitest run src/wip/stranding-dismissals.test.ts src/wip/wip-view.test.ts src/wip/wip-mount.test.ts src/wip/wip-model.test.ts src/wip/wip-read.test.ts
```

## Proof plan

Implementation acceptance requires a running browser with a controlled snapshot containing an open card and two merged matches. Record the initial warning, dismiss PR #N, wait through a refresh, deliver a pushed snapshot, reload, and reopen the browser profile: #N must remain saved while the other match remains actionable. Introduce a different PR and verify its question appears. Restore #N and verify its evidence returns. Repeat with storage writes rejected: no success message or hidden evidence is allowed.

Capture the card remaining open, unchanged counts and unrelated warnings, the visible same-browser limitation, keyboard focus/accessible control names, and the fixture identity alongside screenshots and test output. No production card should be resolved for this proof. These are future implementation acceptance steps, not claims that the dismissal has been built or browser-tested in this preparation.

## Done when

1. The focused Plateau command in Test plan passes with new persistence/poll/remount regression cases that fail against the old implementation.
2. The running-browser Proof plan demonstrates per-card/per-PR dismissal and restoration without concealing other evidence or claiming cross-device durability.
3. Only Plateau implementation/specification/test files listed in scope are needed; existing WE sweep and health-watch behavior remain intact.

## Follow-ups

- Cross-device/shared operator dismissals are a possible later feature, not delivered or separately filed here. If requested, define persistence ownership and consumer semantics first, then apply the per-repo dependency split above.
- The sweep limits displayed PR hits (we:scripts/backlog-stranded-sweep.mjs:171; we:../plateau-app/src/wip/types.ts:93–94). This page-local feature must not claim that dismissing the returned matches proves there are no other merges; broadening or paginating evidence is separate work.
- Testing lesson for implementation: exercise fresh storage instances and both snapshot arrival paths. A renderer-only test cannot prove persistence across reload, and a successful storage write alone cannot prove the page stops repeating the question.
