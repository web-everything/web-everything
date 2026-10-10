---
kind: story
size: 3
parent: "xz2yynk"
status: open
blockedBy: ["xs4ewgh"]
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Drain: per-PR gate reads as tasks (optional)

Optional slice S6 of the async-daemons epic, after S2a and PR #4761 (drain after-merge as a job). The drain's per-PR gate reads run as per-item readonly tasks so a pass does not wait on them serially. Filed unqueued: the operator decides whether it is still owed after S3t.

## Acceptance

- [A1] **Live** — drain `pass timings total` under 30 000 ms.

## Non-goals

- [N1] Any change to merge order or the drain lease (R4).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: gate reads only.
2. **Truncated reads** — A failed or partial read defers that PR, never merges it.
3. **Shared state files** — Readonly tasks; no shared write.
4. **Fail closed** — Read errors defer.
5. **Identity scoping** — Keyed by repo and PR.
6. **State over time** — Results are bound to the head sha read.
7. **Who wrote it** — n/a: no writes.
