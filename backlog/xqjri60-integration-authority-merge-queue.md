---
kind: story
size: 3
parent: "5407"
status: open
relatedTo: ["5402", "5468", "2692", "2740", "xs1hdl7"]
blockedBy: ["5402"]
dateOpened: "2026-10-08"
tags: [delivery-standard, merge-queue, integration-authority]
---

# Integration Authority protocol: merge-queue text in the delivery standard

Write the Integration Authority protocol text for the delivery standard (Ship Evermore, epic 5407): the merge queue. Ready changes form one ordered queue (ruled priority class, then in-class score). The head is tested on the current main tip and merges only on that fresh green; a stale head is refreshed once; after each merge the next head is re-judged. One writer. Settings off = today; batch size 1 (batching later); forge-native queue reserved. Pure rules with replay fixtures; reference implementation in card xs1hdl7.

Operator direction, 2026-10-08. No scope yet: the protocol home is unruled (5402: separate repo now, or incubate here); this card names the file once it is. Prior art: decision 2692 (event-driven merge queue, speculative merge commit, batching rider) and its tripwire 2740; the batching policy here should reuse 2692's ruling.

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
