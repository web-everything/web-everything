---
kind: story
size: 5
parent: "xz2yynk"
status: open
scope: ["we:scripts/lib/daemon-jobs.mjs", "we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/daemon-item-tasks.mjs", "we:scripts/operations/job-record.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Per-item task core: exclusion, timeout, outcomes, effect declarations and a recording accessor

Slice S2a of the async-daemons epic. New we:scripts/lib/daemon-item-tasks.mjs on the job core. Task contract: kind via `defineJobKind` (planning `readonly-tree`, rebase or push `mutates-tree`); inputs `{daemon, repo, item, snapshotPath, snapshotAt, schedulerGeneration}` (generation for logs only); facts read through a recording accessor that logs every field read with source and age; steps read -> plan -> claim -> (per effect: probe -> fence -> act -> mark), idempotent. Exclusion: enqueue under a short per-item file lock that refuses when any non-terminal task exists on `(kind, repo, item)`; id `<kind>:<repo>:<item>:<seq>` (exclusion comes from the lookup, not the id). Already-applied probe through the run store by `effectId = taskId:effectName`, never a GitHub re-read for local effects. Fence: one live per-PR read re-checks every declared input; any mismatch ends `superseded`. Cap via `admitJobs`/`admit({kind})`, per-repo concurrency 1 for acting kinds (O14), values from `cascadePolicy`. `timeoutMs` (default 5 min) enforced by `reattachTick` (we:scripts/lib/daemon-jobs-runtime.mjs:273) through `stopHandle` and a confirm-gone check (O11). Outcomes `acted | nothing-owed | superseded | deferred-claim-held | deferred-read | failed`; only `failed` consumes an attempt. Result sidecar `{v:1, outcome, effects[], recordedReads[], timings, gh}` plus a `task-timing` log line.

## Effects: declared inputs, applied-probe, server-side precondition

| Effect | Fence re-reads live | Already-applied probe | Server-side precondition |
|---|---|---|---|
| Fix / ci-heal worker dispatch | head sha, base sha, open, draft, `review:*` and hold labels, required checks, latest review id, claim | run store: worker run with this `effectId` in launching/running/done | none (the claim covers it) |
| Promote draft (`gh pr ready`) | head sha, draft, every required check green on that head, withdrawal mark | live `isDraft == false` | none |
| Label write | open, the label set the decision relied on | live label present/absent | none (idempotent) |
| Comment | open, the marker comment id | marker comment with the `effectId` exists | marker dedupe |
| Rebase / push (mutates-tree) | head sha, base sha | remote head equals the planned result sha | `--force-with-lease=<head>` |
| Drain merge (S6a) | live fix or ci-heal claim | already merged | `--match-head-commit` |

Residual window, stated plainly: fence-then-act is a check followed by an action, not an atomic guard, except where a server-side precondition is named. Other daemons are kept out by the per-PR claim; humans and CI changes are today's risk; the next tick reconciles.

## Acceptance

- [A1] **Executable** — the core covers per-item exclusion, `timeoutMs`, outcomes, effect declarations (inputs, probe, precondition), intent/applied marks, the recording accessor, timing lines and the `gh` budget assertion.
- [A2] **Crash test (a)** — scheduling the same `(kind, repo, item)` twice with a different seq is refused (J2-13). Fails before, passes after.
- [A3] **Crash test (b)** — every field read in `plan` is in the effect's fence list, and every effect declares a probe (J2-9, J2-24).
- [A4] **Crash test (c)** — kill between `act` and `applied` for each effect kind: the resume probe finds the effect and does not repeat it (J2-4, J2-24).
- [A5] **Crash test (d)** — a PR is merged or drafted between plan and fence: no effect happens.
- [A6] **Crash test (e)** — inject a change between fence and act: behaviour matches today's and the next tick reconciles (J2-8, J2-17).
- [A7] **Crash test (f)** — a task that ignores SIGTERM: its timeout escalates to SIGKILL, it is confirmed gone, and only then is its claim released (J2-1, J2-19).
- [A8] **Live** — the proof harness we:scripts/operations/daemon-jobs-proof/ runs one double-schedule (launched once) and one over-time task (killed once).

## Non-goals

- [N1] No daemon adopts the core here (S3, S4, S5, S9 do).
- [N2] No lease change (that is L1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Task ids and lock paths are built only from kind, repo slug and item number, sanitized; PR titles and bodies never reach an id or path.
2. **Truncated reads** — A missing snapshot, one older than `snapshotMaxAgeMs`, or an unreadable sidecar ends the task `deferred-read`; nothing acts on a partial read.
3. **Shared state files** — Enqueue runs under the per-item file lock; records are written atomically (tmp + rename) under ~/.claude/daemon-jobs/<daemon>/ (R2).
4. **Fail closed** — Any fence mismatch or probe error ends `superseded` or `failed` with no effect.
5. **Identity scoping** — The exclusion key is `(kind, repo, item)`, so the same PR number in two repos never collides; the handle is host:pid:procStart so pid reuse does not match.
6. **State over time** — Timeout escalates SIGTERM -> SIGCONT -> SIGKILL with confirm-gone; tasks from an older process or generation are adopted on reattach, not fenced.
7. **Who wrote it** — Only the role holding a run record resumes it (R14); records carry the launching handle.
