---
kind: story
size: 8
parent: "6202"
status: open
blockedBy: ["4006", "4056", "4051", "4198", "4894", "4900"]
scope: ["plateau-app"]
dateOpened: "2026-11-22"
tags: []
---

# UI requirements carried from closed /wip cards

Requirements the closed /wip cards held that #6202 does not carry; each is an acceptance item on /delivery or its /wip-family surface. Full source text of each closed card is in git history. (#4007) live plan steps per card from the step status record. (#4057) Fleet panel: every open PR with phase, owner, sessions, lane, time in phase; flagged rows first and in Needs you; explain non-dispatch from admission and reconcile evidence; show each daemon's revision and distance behind origin/main. (#4199) per-card activity rows: each session/job with role, state, times, outcome, openable transcript link or copyable path. (#4202) durable not-delivered-by-N dismissal for a merged PR that delivered only a slice or note; card stays open, other evidence kept. (#3736) phone-first compact tables: at most 3 short columns, about 35 characters a row, titles cut to about 18 characters; Attention findings queue themselves. (#4901) phone Flow view: every PR wait group with counts and full descriptions, reachable chain details, honest paging coverage, human prerequisites and disclosure focus preserved across updates and reconnects, title/reason/links/paths treated as untrusted text with safe links only, each repo/number counted once. (#4984) no horizontal elastic scroll on mobile, checked at 366x747, vertical scroll unchanged. (#4997) no pinch or double-tap zoom on /wip phone pages (viewport maximum-scale and touch-action manipulation), scope /wip only. (#5377) compact touch-friendly nav between /wip, glance and /sessions with the current page highlighted and no horizontal scroll. (#4996) Discard action per request with a phone-suited confirm step; soft state change that keeps the request tagged discarded. (#5358) deep links: ?card=N scrolls, highlights and focuses the card; ?agent=session opens its panel; unknown identity shows an inline notice; exact-identity resolution, unauthorized-session refusal, incomplete-feed handling and hostile-query handling; no new write endpoint. (#5593) apply ?card= and ?agent= only to the real snapshot, never the fallback sample; scroll-once; 128-character cap on the link value, longer values ignored not truncated.

Safeguards carried from #4202 (dismissal): persist successfully before showing a saved dismissal; a missing, malformed, unavailable or quota-denied store shows a visible recoverable error and leaves the evidence visible, and never reports persistence after a failed write; the record key is card id plus normalized repository identity plus PR number, never the PR number alone, with identity validation; a Restore action (accessible, also persisted before the display changes) re-exposes only the selected match; the received snapshot stays immutable; regression tests at the renderer and mount seams (round-trip through a fresh store, isolation, duplicate save, restore, malformed data, thrown reads and writes) plus a running-browser proof with a controlled snapshot (dismiss PR N, refresh, pushed snapshot, reload, reopen the profile: N stays saved and the other match stays actionable).

Safeguards carried from #4901 (phone Flow view): reject cross-snapshot unions (replayed old snapshots or pages are rejected, rows age honestly, the unreachable remainder is marked); instrumented proof over two 120-second publish cycles plus a second tab shows zero extra collection or GitHub calls attributable to the page asks or the extra tab; a publisher to relay to same-origin browser run compares the rendered union and counts to the repo/number manifest across all three repos.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Duplicate admission

carries requirements of 13 cards closed into #6202; no existing card holds them
