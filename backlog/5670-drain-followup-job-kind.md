---
bornAs: xuy5acn
kind: story
size: 3
parent: "4124"
status: resolved
scope: ["we:scripts/lib/drain-followup-job.mjs", "we:scripts/drain-followup-job.mjs", "we:scripts/lib/__tests__/drain-followup-job.test.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# Drain follow-up job kind: the drain-followup job (own worktree, numbering lock, resumable steps) on the 4125 runtime

Slice 1 of 4124 (decision 4120). Defines the drain-followup job kind on the 4125 job model without wiring it into the drain: mutates-tree + serial, runs in its own linked worktree of main (never the daemon clone; refuses to reset a primary clone), each write-to-main step holds the numbering lock with no unlocked fallback and heartbeats it, each step first resets its worktree to origin/main so a crash leaving an unpushed commit is safe to retry, and the record input carries the pass's landed ids, carriers and open head refs that resolve-on-land cannot re-derive. Child entry we:scripts/drain-followup-job.mjs. Wiring into we:scripts/merge-ai-prs.mjs plus the live drain proof is the next slice (5671).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/drain-followup-job.test.mjs` fails before this lands (the module and entry do not exist) and passes after (10 tests). The last test launches a real detached `drain-followup` job through the 4125 runtime, SIGKILLs it mid-job, reattaches it from a fresh store (a simulated daemon restart), and shows it resumes at step 2 and that numbering and its push to a real temp `origin` happened exactly once.

## Non-goals

- [N1] Wiring the job into we:scripts/merge-ai-prs.mjs, the per-kind switch and the live drain proof — slice 5671 (that file is held by open PRs 4624/4631).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the input is built by the drain from its own pass state; it is normalised to plain strings before it is stored.
2. **Truncated reads** — the record store refuses a corrupt record (4125 runtime); a step never infers "nothing to do" from a failed read — a git failure throws and the job retries.
3. **Shared state files** — every write-to-main step holds the numbering lock with `runUnlockedOnContention: false`; a held lock throws and retries, never writes unserialised.
4. **Fail closed** — a rejected push throws so the retry rebuilds on the new tip; a tree that is not a linked worktree is never reset.
5. **Identity scoping** — the job runs only in its own linked worktree, never the daemon clone or a lane clone.
6. **State over time** — each step resets to the fresh `origin/main` first, so a crash that left an unpushed commit is safe to re-run.
7. **Who wrote it** — n/a: the job only writes through the drain's existing numbering, resolve and regen helpers.
