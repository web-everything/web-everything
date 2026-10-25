---
bornAs: xmxojbm
kind: story
size: 2
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs"]
dateOpened: "2026-10-18"
tags: []
blockedBy: ["6265"]
---

# we: 6265 slice 4 - dedup check must also see already-published override-loosening-ended lines

Follow-up to #6265: deduplicate ended override events against both active and ended publications for the same entryId. The prerequisite is still open; its proposed active-key-only check misses an ended event appended before a crash. Implement this with or after #6265, not as a fix to an override producer that already exists.

## Acceptance

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` — extend the proposed test `a crash between appending ended events and writing the state does not publish the same ended event twice`: use real temporary feed/state files, append an ended event, retain the old cursor, then restart runOnce twice. Assert exactly one ended publication and cursor progress after recovery. Fails with #6265's active-key-only lookup.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` — cover an existing active publication (no ended publication), an existing ended publication (no duplicate), and a different entryId (one new ended publication). Repeat with rewritten-history replay; assert ended events never enter openKeys or receive a clear.
- [A3] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` — use real temporary feed/state files and the actual append/replay path: seed complete preceding events followed by exactly `NEE` without a newline and retain the old override cursor. Under the feed-state lock, terminate the nonempty unterminated tail with a newline before retrying the ended event; restart runOnce twice and assert preceding events survive, replay sees exactly one ended publication for the retried entryId on its own physical line, and only then the cursor progresses. Repeat with a valid ended event missing only its final newline (preserve and deduplicate it), an already newline-terminated malformed line, and a crash after tail repair but before event append. Inject tail-repair and event-append failures separately: abort with the cursor unchanged, then recover and publish exactly once on the next successful run.

## Non-goals

- [N1] No override-store, acknowledgement, expiry, or PR-metrics redesign; #6265 owns initial override ingestion.

## Edge cases this change must handle

1. **Untrusted text** — Use parsed event identity, not substring matches in actor/instruction text; embedded key text must not suppress an event.
2. **Truncated reads** — Ignore a malformed partial line as dedup evidence, but repair the append boundary before publishing: append a newline to any nonempty unterminated feed tail under the feed-state lock. Preserve all existing bytes and complete preceding events; a valid final event missing only its newline remains dedup evidence after repair. Never concatenate a retried event onto a torn tail. Unreadable history holds the cursor and raises the #6265 history alarm.
3. **Shared state files** — Re-read the feed, repair its tail, read publication evidence and append under the same existing feed-state lock; persist the cursor atomically with openKeys only after every required publication is successfully appended or matched to existing durable publication evidence. Recovery after a crash between repair and append, or between append and state write, must be safe to repeat.
4. **Fail closed** — An unreadable feed must not be treated as an empty publication history; a feed-read, tail-repair or event-append failure aborts without advancing the cursor. Retrying must leave each required new ended publication replayable exactly once before its cursor can be committed.
5. **Identity scoping** — Match operator-override, PR 0, exact entryId, and either override-loosening or override-loosening-ended; other kinds and entries do not collide.
6. **State over time** — Crash replay, first-run replay and rewritten-log replay all deduplicate against durable publications, not just openKeys.
7. **Who wrote it** — Retain actor/time from the override record; feed text is display data. This local producer adds no HTTP endpoint; body caps, rate limits and CSRF are inapplicable.

## Grounding

- we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:6 is open and specifies the future producer and crash test.
- we:scripts/operations/needs-you-feed.mjs:164 currently reads the queue only; lines 194–199 lock, append, then write state.
- we:scripts/operations/needs-you-feed.mjs:109 parses event JSON; line 124 replays durable feed events.
- we:scripts/operations/needs-you-feed.mjs:115 appends lines directly without repairing an unterminated feed tail; a real-file probe with `NEE` followed by an ended-event append produced `NEENEEDS-YOU` and zero replayed events.
