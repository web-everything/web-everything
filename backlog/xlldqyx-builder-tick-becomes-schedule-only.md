---
kind: story
size: 5
parent: "xz2yynk"
status: open
blockedBy: ["xs4ewgh", "xt3sgtl", "xxynru6"]
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/open-pr-fetch.mjs", "we:scripts/conveyor/build-dispatch-claim.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Builder tick becomes schedule-only

Slice S5 of the async-daemons epic. Today we:skills-src/conveyor/build-dispatch-daemon.mjs:328 runs `planTick` (:1146), `fetchOpenPrs` (:1241), `recoverDrafts` (:2088) and prepare reads (:381-394, :824-962) inline; ticks take 236-546 s, target under 30 s. `fetchOpenPrs` reads the pr-snapshot; prepare status, settle and `recoverDrafts` become per-item tasks; `planTick` is a readonly job; build launches use the W1 hand-off.

## Acceptance

- [A1] **Test (a)** — the W1 tests (a)-(d) pass for build launch, with the probe as a run-store lookup.
- [A2] **Test (b)** — recover-draft killed mid-act is not repeated.
- [A3] **Live** — `timings.totalMs` under 30 000 for 5 ticks, and dispatches per hour no lower than baseline.

## Non-goals

- [N1] Changing what the builder picks (queue policy).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: card text reaches only the build brief, as today.
2. **Truncated reads** — A stale snapshot or unreadable queue file schedules nothing that tick.
3. **Shared state files** — Build claims via W1 CAS; lane reservation unchanged.
4. **Fail closed** — Any probe error -> no relaunch, task `failed` and retried under the attempt cap.
5. **Identity scoping** — Tasks keyed by `(kind, repo, card)`.
6. **State over time** — Reattach adopts in-flight builds after restart.
7. **Who wrote it** — Only the builder role resumes its workers (R14).
