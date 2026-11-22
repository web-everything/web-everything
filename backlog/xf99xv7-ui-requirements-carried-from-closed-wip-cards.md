---
kind: story
size: 8
parent: "6202"
status: open
scope: ["plateau-app"]
dateOpened: "2026-11-22"
tags: []
---

# UI requirements carried from closed /wip cards

Requirements the closed /wip cards held that #6202 does not carry; each is an acceptance item on /delivery or its /wip-family surface. Full source text of each closed card is in git history. (#4007) live plan steps per card from the step status record. (#4057) Fleet panel: every open PR with phase, owner, sessions, lane, time in phase; flagged rows first and in Needs you; explain non-dispatch from admission and reconcile evidence; show each daemon's revision and distance behind origin/main. (#4199) per-card activity rows: each session/job with role, state, times, outcome, openable transcript link or copyable path. (#4202) durable not-delivered-by-N dismissal for a merged PR that delivered only a slice or note; card stays open, other evidence kept. (#3736) phone-first compact tables: at most 3 short columns, about 35 characters a row, titles cut to about 18 characters; Attention findings queue themselves. (#4901) phone Flow view: every PR wait group with counts and full descriptions, reachable chain details, honest paging coverage, human prerequisites and disclosure focus preserved across updates and reconnects, title/reason/links/paths treated as untrusted text with safe links only, each repo/number counted once. (#4984) no horizontal elastic scroll on mobile, checked at 366x747, vertical scroll unchanged. (#4997) no pinch or double-tap zoom on /wip phone pages (viewport maximum-scale and touch-action manipulation), scope /wip only. (#5377) compact touch-friendly nav between /wip, glance and /sessions with the current page highlighted and no horizontal scroll. (#4996) Discard action per request with a phone-suited confirm step; soft state change that keeps the request tagged discarded. (#5358) deep links: ?card=N scrolls, highlights and focuses the card; ?agent=session opens its panel; unknown identity shows an inline notice; exact-identity resolution, unauthorized-session refusal, incomplete-feed handling and hostile-query handling; no new write endpoint. (#5593) apply ?card= and ?agent= only to the real snapshot, never the fallback sample; scroll-once; 128-character cap on the link value, longer values ignored not truncated. (#3931) live agent activity per card: status line, step timeline, step detail excerpt, derived from transcripts, streamed over the relay only while a page watches, never stored.

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
