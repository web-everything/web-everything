---
bornAs: xiciisp
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-delivery-policy.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/merge-delivery-policy.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Merge-delivery policy reads the merge-queue override layer (batchSize)

The original report conflates two current settings namespaces. The delivery reader consumes mergeDelivery, including its dedicated override file; the legacy queue hook separately consumes mergeQueue. The declared file intentionally contains different batchSize values. Determine which override is owed before changing precedence.

## Acceptance

- [A1] `t=we:scripts/lib/__tests__/drain-merge-strategy.test.mjs; q=we:scripts/readiness/heavy-admission.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — After the namespace/precedence ruling below, add a real temporary-file regression to this suite: platform batchSize=3 and the ruled repo override=1 must resolve to 1 with the correct source in formatMergeDeliverySourcesLine. Run against the pre-change reader to demonstrate failure, then against the change to pass. The expected namespace cannot be finalized until the ruling.
- [A2] Run the same queued command with t=we:scripts/lib/__tests__/merge-delivery-policy.test.mjs; assert missing override falls back, malformed JSON emits a diagnostic, invalid batchSize is rejected, and simultaneous delivery/queue keys follow the ruled precedence without affecting unrelated keys.

## Non-goals

- [N1] No GitHub ruleset mutation, batching algorithm, or change to live batch size. No network receive/write endpoint; HTTP caps, rate limits and CSRF are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Parse override files as JSON data; reject non-integer, zero, negative and out-of-range batch sizes.
2. **Truncated reads** — A truncated override must be diagnosed and use the established lower-layer fallback, not a partial parsed value.
3. **Shared state files** — Read settings only; do not rewrite shared settings or introduce a second override store.
4. **Fail closed** — Preserve invalid-value diagnostics and validated fallback; no malformed override may silently weaken gate placement.
5. **Identity scoping** — Scope overrides to the target repo reader; preserve hermetic VITEST/WE_UNDER_TEST behavior.
6. **State over time** — Each new resolution observes the current override; deleting it restores the declared/platform/default cascade.
7. **Who wrote it** — The source report names the layer that supplied the effective value, not an inferred operator or model author.

## Grounding

- we:scripts/lib/merge-delivery-policy.mjs:164 reads only the mergeDelivery tool block.
- we:scripts/lib/drain-merge-strategy.mjs:70 reads WE_MERGE_DELIVERY_SETTINGS_FILE before declared settings.
- we:scripts/lib/merge-queue-hook.mjs:62 separately reads WE_MERGE_QUEUE_SETTINGS_FILE and mergeQueue.
- we:scripts/settings/merge-queue.json:5 sets mergeDelivery.batchSize=5; line 16 sets mergeQueue.batchSize=1.
- we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:436 already tests the dedicated override file.

## Open questions

Which setting is intended to control delivery: the existing mergeDelivery override, or a compatibility mapping from mergeQueue.batchSize (and with what precedence when both exist)? This blocks a truthful failing acceptance case; the old batchSize=3/platform report alone does not establish a current missing override.
