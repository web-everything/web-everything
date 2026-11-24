---
name: why-not-dispatching
description: Explain why an item or the cleared queue is not dispatching when the runner looks alive but nothing moves. Use the declared dispatch-eligibility operation to identify admission holds; runner liveness and activity are separate questions.
---

# Why is nothing dispatching?

An alive runner with no progress is an admission question. The answer is usually one named gate,
not a mystery requiring a manual trace. The method and output contract live in
[we:docs/agent/testing.md → Dispatch eligibility reports](../../docs/agent/testing.d/047-dispatch-eligibility-reports.md#dispatch-eligibility-reports).

## Quick path

1. **Read** the item: `node scripts/operations/run.mjs dispatch-eligibility --item=NNN --json`.
   Omit `--item` for the whole queue. Add `--bookkeepingFile=<path>` for the runner's live guards.
2. **Inspect** `verdict.items`: each item names its `firstBlockingGate`, ordered `gates`, and observed
   values. The upstream build trace is under `buildAdmission`; a build hold may route to preparation.
3. **File** a starvation bug through the `file-item` operation when the named hold contradicts expected
   progress. Use this JSON as the evidence, with the item, observation time, and expected progress.

## Reading the result

A completed report exits successfully even when items are held. Reader failures are errors, not an empty
queue. Preserve partial-read and bookkeeping fields when sharing the output. Investigate runner activity
separately when the question is whether a runner exists or is ticking at all.
