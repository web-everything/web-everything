---
kind: story
size: 3
parent: "5407"
status: open
relatedTo: ["5402", "5468"]
blockedBy: ["5402"]
scope: []
dateOpened: "2026-10-08"
tags: [delivery-standard, merge-queue, integration-authority]
---

# Integration Authority protocol: merge-queue text in the delivery standard

Write the Integration Authority protocol text for the delivery standard (Ship Evermore, epic 5407): the merge queue. Ready changes enter one ordered queue (ruled priority class, then in-class score). The head is tested on the current main tip and merges only on that fresh green; stale heads are refreshed once per head; after each merge the next head is re-judged on the new main. One single writer. Declared settings with off = today; batch size fixed at 1 (batching = later policy); forge-native merge queue = reserved strategy adapter. Rules are pure over plain facts, with replay fixtures (#4361 and the 2026-10-08 red-main window). Reference implementation: card xs1hdl7 (we:scripts/lib/merge-queue.mjs, we:scripts/lib/merge-freshness.mjs).

Operator direction, 2026-10-08. Scope is empty until the protocol home is ruled (5402: separate repo now, or incubate here); this card then names the file.

## What the protocol text must define

Same shape as the review/fix policy protocol (5468): facts in, verdict out, no forge or label strings.

- **Facts.** A change: head, base, changed files (with a completeness flag), required-check state on a named head
  with its completion time, priority class, in-class score. Main: tip, commits since a base, files changed since
  a base (with a completeness flag).
- **Rules.** `order` (class, then score, then a stable tie-break); `merge-fresh?` (pass on current head, base is
  the tip or main moved only on disjoint files when allowed, pass younger than max age); `next action` for the head
  (`merge`, `refresh`, `wait`, `refuse`) and `queued` for the rest.
- **Settings.** `enabled`, `maxAgeMinutes`, `allowDisjointMainMoves`, `classOrder`, `defaultClass`,
  `batchSize` (1 only), `strategy` (`drain-direct` built; `forge-native-queue` reserved). Off = no queue.
- **Authority.** Exactly one writer integrates into main. A refresh happens once per head. Incomplete facts refuse.
- **Future policies.** Batching (test N heads together, bisect on failure); forge-native queue adapter.
- **Conformance cases.** The replay fixtures of xs1hdl7 become the protocol's conformance cases.

## Done when

1. **Executable** — the protocol home's conformance runner passes the xs1hdl7 replay cases against the reference
   implementation (we:scripts/lib/merge-queue.mjs); fails before the cases are added.

## Edge cases this change must handle

1. **Untrusted text** — n/a: protocol text; facts are SHAs, paths, times and ruled class names.
2. **Truncated reads** — the text requires completeness flags on file and commit lists; incomplete means refuse.
3. **Shared state files** — the per-head refresh record is owned by the single writer.
4. **Fail closed** — any missing fact refuses; never merges.
5. **Identity scoping** — refresh record keyed by change id + head, so a new push resets it.
6. **State over time** — every merge moves main; the next head is re-judged on the new tip.
7. **Who wrote it** — n/a: rules read CI results and history, not author-written text.
