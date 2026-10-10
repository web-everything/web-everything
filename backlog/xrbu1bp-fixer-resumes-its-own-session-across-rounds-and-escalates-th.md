---
kind: story
size: 5
priority: high
parent: "xx0055i"
status: resolved
scope: ["we:scripts/settings/fix.json", "we:scripts/conveyor/fix-takeover.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-resume.mjs", "we:scripts/conveyor/__tests__/fix-resume.test.mjs"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Fixer resumes its own session across rounds and escalates the model from round 3

Items 2 and 3 of making the fixer as good as a focused worker (after #4756 / card xx0055i). (2) When round N>1 of a fix is dispatched and the previous round's fixer session (claude agents row named fix-<pr>, its job record in ~/.claude/jobs) is still resumable, resume it with the new round's findings + history instead of a cold start; bound: only when the session's own lane (lease ownerSession = that session) is still at the PR head and the base was not rebased under it, else cold start with the history brief. Setting fix.resumeAcrossRounds on|off (default on). (3) The fixer ladder's stronger-model rung starts at round 3 (fix.strongerModelFromRound, default 3) for ordinary fix rounds, not only after ruling misses. Both are settings under the policy cascade in we:scripts/settings/fix.json (env > settings > built-in). The dry-run (we:scripts/conveyor/reconcile-fix-dispatch.mjs --dry-run --replay-pr=N) shows the round, model route and resume decision for a live PR with no side effects.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/fix-resume.test.mjs` (resume chosen / declined
  per bound, rung by round, loop wiring) fails before this item (the module does not exist) and passes after.
- [A2] **Live replay** — `WE_WORKER_WRAPPER=off node we:scripts/conveyor/reconcile-fix-dispatch.mjs --dry-run --replay-pr=<n>`
  shows a round ≥3 PR on the `stronger-model` route (`--model opus`), and a round-2 replay of a PR whose previous
  fixer session is resumable shows `resume <session>` instead of a cold start. Read-only (no claim, post, spawn, resume).
- [A3] A declined resume always falls back to the cold start with the round-history brief and logs the reason; a
  throwing resume read never aborts the pass.

## Non-goals

- [N1] No round resume for the wrapped (`claude -p`) fix launch yet (declined `wrapped-launch`); the live fix daemon
  runs `WE_WORKER_WRAPPER=off` (`claude --bg`), which is what resumes.
- [N2] A takeover, a conflict bounce (it has its own resume), a restack and a borrowed slot never round-resume.
- [N3] The lane checkout is not held between rounds (the lease reaper frees it when the session ends); the resumed
  session re-takes its old lane when it is untouched, else acquires a fresh one at the PR ref.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the round history in the resume prompt is the xx0055i section (trusted comments only, scrubbed, capped, marked as DATA); journal/lease/job JSON is parsed defensively and a bad line is skipped.
2. **Truncated reads** — the pool journal is read as a 4 MB tail with the torn first line dropped; any unreadable input (listing, job record, lease, gh compare) is null, which declines the resume.
3. **Shared state files** — leases, journal and job records are only read; the resume takes the existing fix-dispatch claim before `--resume` (no double resume) and releases it in every outcome.
4. **Fail closed** — every unknown (base not provable, head unknown, lane not found) is a cold start with the history brief, never a resume; a fork from `--resume` is stopped.
5. **Identity scoping** — the session is the latest `fix-<pr>` listing row; its lane is bound by the lease/journal `ownerSession`/actor session = that session id AND session slug; the PR head must equal what that session left.
6. **State over time** — the PR branch moving (another push, a rebase) or a stacked base being rewritten since the session declines the resume; the resumed session re-checks HEAD itself before working.
7. **Who wrote it** — journal events and leases are written by `we:scripts/lane-pool.mjs` (no PR author input); the session listing and job records are the Claude CLI's own.
