---
kind: story
size: 5
status: open
dateOpened: "2026-11-19"
tags: []
---

# Red-team partial-inventory recovery: probe known blocked PRs when the open-PR list read is partial

When the open-PR list read fails as a partial inventory ("pages carried N unique of M open PRs", seen at 15:08 and 16:29 ET on 2026-11-19), the review daemon returns before red-team recovery, so every blocked PR waits another tick. This item lets recovery still probe the PRs already in the red-team queue, from stored state plus per-PR live reads, without admitting any PR it cannot confirm is open. It was cut from the probe-cap slice (PR 7194, lane/redteam-probe-cap, checklist line 14) because every audit round found a new gap on this path. Prior attempt commits: 7d65c2dd9e to 57fead9cf9 on that branch.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs -t "list read partial"`: on a partial-inventory tick, known blocked entries are probed through the SAME normal planner, unknown PRs are never admitted, nothing is evicted, a draft PR never reaches dispatch, and a scope-bloated PR is still held.
- [A2] **Executable** — a negative test per merge-path checklist line (the merge-path prep checklist), including host admission failing closed.

## Non-goals

- [N1] No change to the probe cap setting (that shipped in PR 7194).

## Audit findings from today (verbatim, each must be answered by the design)

- `we:scripts/lib/red-team-dispatch-queue.mjs:395 — Partial-inventory recovery fabricates already-reviewed-head refusals without the normal planner’s draft guard. An in-memory probe with isDraft: true reached the injected dispatcher.`
- `we:skills-src/conveyor/review-daemon.mjs:537 — The new recovery path inherits fail-open host admission: null/undefined admission retains permission, and a missing/nonfinite maxPerTick becomes Infinity.`
- `we:skills-src/conveyor/review-daemon.mjs:540 — Adds recovery execution after inventory completeness fails, bypassing the previous return-before-recovery path; recovery can dispatch jobs when its remaining guards allow.`
- `we:skills-src/conveyor/review-daemon.mjs:541 — Bypasses the previous recovery stop on incomplete PR inventories. Known blocked entries reach recovery, whose existing runner can dispatch full reviews or red-team jobs; these probes are not restricted to read-only checks.`
- `we:scripts/lib/red-team-dispatch-queue.mjs:58 — Partial recovery omits files and baseRefName. Existing scope-bloat enrichment skips validation without files, so replanning can produce recovery eligibility where complete evidence would enforce a scope-bloat hold.`

## Edge cases this change must handle

1. **Untrusted text** — n/a: only PR numbers, shas and labels are read; no text is executed.
2. **Truncated reads** — a per-PR read missing comments, labels, files or baseRefName means that entry is not probed (fail closed).
3. **Shared state files** — the queue file is written only after each effect, as today; recovery never evicts or re-keys entries.
4. **Fail closed** — unreadable host admission or maxPerTick means 0 starts; an unreadable PR read means no probe.
5. **Identity scoping** — each probe is bound to the stored 40-hex head and re-verified live; a moved head is refused.
6. **State over time** — a PR closed or merged between ticks is dropped by the normal maintenance, not by recovery.
7. **Who wrote it** — comments are trusted only through the existing red-team evidence readers, not by name.

## Duplicate admission

cut from lane/redteam-probe-cap (PR 7194) slice; no existing card covers partial-list recovery
