---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-event-feed.mjs", "we:scripts/lib/__tests__/pr-event-feed.test.mjs", "we:scripts/lib/pr-event-feed-settings.json"]
dateOpened: "2026-10-08"
tags: []
---

# Event runtime foundation: persisted feed cursor and dirty-PR marking

Step 1 of the event-driven daemon design (ruling E6, 2026-10-08). A shared consumer for the pr-events feed: the cursor is persisted per role (today it lives in memory, so review restarted 113x and fix 60x in 48 h and each restart re-swept), and each relevant event only marks its PR dirty. CI events with no PR number (about 40%) resolve through the head-commit-to-PR map the Durable Object keeps, read via the pr-facts mirror. At-least-once: the cursor and the dirty marks are written in one atomic file; a mark is cleared only after a handler that started after it finished. A gap or reset marks a full-sweep entry. First consumer: the drain daemon (#4283), behind a mode setting off/shadow/on.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-event-feed.test.mjs` passes: a restart resumes from the stored cursor with no reset; a CI event with no PR number marks its PR through the head-commit map; a crash between take and ack re-delivers the marks; a re-mark during a handler survives its ack. The module does not exist before this item.
2. **Live** — the drain (`plateau-app:tools/drain-daemon/daemon.mjs`, #4283) logs `resumed from stored cursor N; caught up E event(s) … nothing lost` after a restart.

## Edge cases this change must handle

1. **Untrusted text** — n/a: events come from the authenticated feed; fields are only used as map keys and log text, never executed or passed to a merge.
2. **Truncated reads** — a page cut short (`more`) is read on the next page/poll from the stored cursor; a pruned range (`gap`) marks a full sweep.
3. **Shared state files** — one state file per role, written with temp file + rename; one writer per role (the drain lease holder); a corrupt or foreign file is treated as a first start.
4. **Fail closed** — an unknown mode or unreadable settings resolves to `off`; a failed poll keeps the cursor and the marks; a failed write is logged and retried on the next page.
5. **Identity scoping** — marks are keyed by lower-cased `owner/repo#number`; the head-commit map is keyed by repo and commit.
6. **State over time** — the learned head-commit map is capped (1,000, oldest first); marks are cleared by ack; the cursor only moves forward with its marks.
7. **Who wrote it** — n/a: the feed is the single writer of events (the Worker); this consumer only reads it.
