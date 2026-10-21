---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/card-dedupe.mjs", "we:scripts/operations/land-prevention-card.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention dedupe: check cards on open PRs outside the health-watch tick

On `lane/hot-card-drain-capped-3` (b58a4a46b9) the in-tick deadline (`we:scripts/lib/tick-deadline.mjs`) made in-tick dedupe skip cards that live on open PRs. The gh-throttle path (`we:scripts/lib/gh-throttle.mjs`) spawns retry/auth subprocesses that cannot share the deadline. So a finding that matches only a card on an open PR is filed as a NEW card instead of an "Also raised by" mention: more cards, against PR collection. Operator accepted this trade-off for now (2026-10-21 ~07:55 ET) and asked for the fix as a card.

Proposal: precompute an index of open-PR cards outside the tick (a background job, or the existing pr-sweep / card-batch state, refreshed every N minutes, with its age logged). In-tick dedupe reads only that index (no network in the tick). A stale or missing index means "unknown": DEFER the card to the next tick rather than file a duplicate.

Links: card 6636 (rolling card batch), PR #5762 (post-approval grouping), `we:scripts/operations/land-prevention-card.mjs`, `we:scripts/lib/card-dedupe.mjs`.

## Acceptance

- [A1] **Executable** — a unit test on `we:scripts/lib/card-dedupe.mjs` with a fresh open-PR index containing a matching card: the finding becomes an "Also raised by" mention, no new card file is written, and the dedupe makes zero `gh`/network calls (fails before, passes after).
- [A2] **Executable** — a test with a stale (older than the max age) or missing index: the card is deferred to the next tick (not filed), the deferral is logged with the index age, and it is filed or mentioned once a fresh index exists.
- [A3] **Executable** — a drain/tick run with the index in place stays under 120 s of drain time, with no gh-throttle subprocess spawned inside the tick.
- [A4] **Executable** — the index refresh runs outside the tick (background job or pr-sweep/card-batch state), logs its age, and a refresh failure leaves the old index in place (it ages out to stale, never to empty-and-trusted).

## Non-goals

- [N1] Changing the in-tick deadline (`we:scripts/lib/tick-deadline.mjs`) or the gh-throttle retry/auth behaviour itself.
- [N2] Backfilling or merging duplicate cards already filed because of the current trade-off.
- [N3] Changing how cards on merged or closed PRs are deduped (already covered by the on-main backlog scan).

## Edge cases this change must handle

1. **Untrusted text** — n/a for the index shape: it stores only card ids, titles and PR numbers; titles are compared as data and never executed or interpolated into a shell.
2. **Truncated reads** — a partial or unparseable index file counts as missing ("unknown"), so the card is deferred, never treated as "no match".
3. **Shared state files** — the refresher writes atomically (temp file plus rename); ticks only read, so no lock is needed and a concurrent tick never sees a half-written file.
4. **Fail closed** — a stale, missing or unreadable index defers the card; it never files a possible duplicate.
5. **Identity scoping** — index entries are keyed by repo (web-everything vs plateau-app) plus PR number; a match must be in the same repo.
6. **State over time** — a PR that merges or closes drops out of the index at the next refresh; a stale index is bounded by a max age (N minutes), and its age is logged on every read.
7. **Who wrote it** — only cards on PRs by this repo's own lanes count; the index records the PR author so third-party PR text is never trusted as a match source.
