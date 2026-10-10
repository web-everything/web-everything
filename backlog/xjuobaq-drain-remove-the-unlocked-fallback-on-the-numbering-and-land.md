---
kind: story
size: 2
parent: "xz2yynk"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/drain-lock.mjs", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Drain: remove the unlocked fallback on the numbering and land locks

Slice S6b of the async-daemons epic; also held item 203 (found by the async-daemons design pass; counts as a safety fix). Drain numbering and merge locks fall back to running UNLOCKED when contended, violating the jobs statute's "no unlocked fallback" (R1). Design read at b2ef34324: we:scripts/merge-ai-prs.mjs:5953 and :6203; on fc8662311 the land-write mutex prints "merge-write mutex not acquired ... merged under the per-PR idempotency guard instead" (:5979) and the numbering lock is at :6151. Fix: a contended lock waits with a bounded budget (cascade setting) then defers the pass (logged); it never runs unlocked. Also check (item 203): `withSelfSync` never renews its clone-lock reader slot (we:scripts/lib/daemon-self-sync.mjs), so a tick over 10 min may lose it (untested).

## Acceptance

- [A1] **Executable** — a contended lock waits or defers; it never runs unlocked (R1).
- [A2] **Test (a)** — two landers contend: exactly one runs, the other defers.
- [A3] **Test (b)** — kill the holder mid-numbering: the next run recovers without double numbering.
- [A4] **Test (c)** — a tick longer than the reader-slot TTL keeps (renews) its clone-lock reader slot, or the gap is shown not to exist.
- [A5] **Live** — a `deferred: numbering-lock-held` line, and no unlocked run in 24 h.

## Non-goals

- [N1] The drain lease itself (R4).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: lock files hold only daemon-written holder ids.
2. **Truncated reads** — An unreadable lock file counts as held: defer, never proceed.
3. **Shared state files** — Numbering and land locks stay the single mutex; the wait budget comes from the cascade.
4. **Fail closed** — Contention or a lock error defers the pass; nothing runs unlocked.
5. **Identity scoping** — Holder identity is pid plus start time; only a dead holder is reclaimed (#4134).
6. **State over time** — A long tick renews its reader slot; a killed holder mid-numbering is recovered by test (b).
7. **Who wrote it** — Only the drain writes these locks.
