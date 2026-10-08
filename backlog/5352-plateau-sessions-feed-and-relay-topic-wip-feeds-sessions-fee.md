---
bornAs: xlsblsu
kind: story
size: 2
parent: "5332"
status: active
scaffoldedBy: "p1-sessions-feed"
dateScaffolded: "2026-10-08"
scope: ["plateau:src/wip/wip-feeds.ts", "plateau:src/wip/wip-read.ts", "plateau:wip-relay.js", "plateau:src/wip/types.ts"]
dateOpened: "2026-10-08"
tags: []
---

# Plateau sessions feed and relay topic: wip-feeds sessions feed, DELTA_TOPICS.sessions validator, /api/wip carries sessions (P1 of 128)

Slice P1 of cards-to-file 128. Plateau serves the WE sessions operation (#5332) the way /wip gets its data: plateau:src/wip/wip-feeds.ts feed, plateau:src/wip/wip-read.ts readSessionsFeed, plateau:wip-relay.js DELTA_TOPICS.sessions validator (closed vocab, max 500 rows, no absolute paths), plateau:src/wip/types.ts WipSessions, dev /api/wip carries sessions. Ended rows are always sent (24h); the page (P2) hides them by default. Plateau has no card system, so this card is filed in web-everything with a plateau: scope.

## Done when

1. **Executable** - in plateau-app: `npx vitest run plateau:src/wip/sessions-feed.test.ts` (new validator and feed tests) fails before and passes after: the validator accepts a valid verdict and rejects an unknown `state`, an absolute path in any field, and more than 500 rows; `readSessionsFeed` with an injected `exec` returns the recorded `sessions --json` verdict unchanged except validated. On a lane dev server (spare port, stopped by PID), `curl -s localhost:<port>/api/wip` has `sessions.rows` as an array.

## Edge cases this change must handle

1. **Untrusted text** - n/a: strings are length-capped and checked against closed vocab and the id grammar; rendering is P2.
2. **Truncated reads** - the exec output is parsed whole; invalid JSON yields a degraded value, never a partial list.
3. **Shared state files** - n/a: the feed only reads and holds the latest value in memory.
4. **Fail closed** - a verdict that fails validation is dropped (previous value kept) and logged, never forwarded.
5. **Identity scoping** - n/a: single-operator local feed, same as `live`.
6. **State over time** - rows are replaced wholesale each push; only changed rows trigger a push.
7. **Who wrote it** - the rows come from the WE `sessions` operation; the relay validates and never trusts them.
