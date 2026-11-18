---
name: keep-prototype-branch-synced-after-each-merge
description: "Standing instruction — sync the mechanical-dispatcher prototype branch (origin/lane/mechanical-dispatcher) against main proactively, after each merge that touches shared files, not only when a livelock forces it."
metadata:
  type: feedback
---

**The operator's own instruction (2026-09-03): "we have to keep prototype better up to date after
each merge."** Epic #3383's prototype checkout (`origin/lane/mechanical-dispatcher`, run from
`~/workspace/wev-scratch-dispatcher-4` or an equivalent live checkout) must be
synced against `main` proactively — not left to drift until something breaks.

**Why this is a standing instruction, not a one-off:** it happened TWICE in one overnight session.
First, an ~8-hour silent drift (a stray uncommitted local diff blocked the auto-sync cron, which
nobody noticed until a livelock forced investigation) caused real dispatch capacity to burn on
already-resolved items for hours. Fixed by hand. Roughly 10 hours later, the SAME checkout had
drifted 86 commits behind `main` again — this time with a much bigger, riskier diff (`main` had
fully DELETED several files the prototype branch still referenced: `supervisor.mjs`,
`route-pr-outcome*.mjs`, a test file, a `.plist.example`). Each time the sync is deferred, the
eventual reconciliation gets larger and riskier, not smaller.

**How to apply, until the real mechanical fix ships:** `we:backlog/3464-a-long-lived-diverged-
prototype-branch-has-no-reconciliation.md` is the filed proposal for an actual reconciliation
cadence independent of a live session — that's the intended end state, not yet built. Until it
ships, whoever is driving a session against this prototype should proactively check
`git fetch origin main && git rev-list --count HEAD..origin/main` on the live checkout at natural
checkpoints (session start, after a batch of PRs land on `main`, or at minimum before leaning on the
checkout for anything load-bearing) — not just when a livelock or a stale-status symptom forces the
question. Do the sync in a SEPARATE clone, never directly in the live checkout while its runner
process is active (see [[verify-session-liveness-before-archiving]] and the #3383 standing doctrine
for why direct edits to a live-read checkout are risky), then push the resolved merge back to
`origin/lane/mechanical-dispatcher` and only then bring the live checkout forward.

**Supersede this note once #3464 ships** — proactive manual checking is a stopgap, not the intended
end state.

**Update (2026-09-04/05, #3472):** the "real mechanical fix" this note deferred to now exists, in two
halves. #3464's PASSIVE half landed first: `we:scripts/conveyor/branch-drift.mjs sweep` runs
automatically every `runner.mjs` tick, dry-run-probes `lane/mechanical-dispatcher` against `main` (no
working tree touched), and persists the verdict as a `git note` any checkout can read back —
`dispatch-plan.mjs` already gates further dispatch on it (`branch-drift-blocked`). #3472 then found the
gap that PASSIVE detection alone doesn't close: the scratch checkout's own ACTIVE sync loop (an ad hoc
`bash -c 'while true; do sleep 180; git fetch; git merge; on conflict: log one line + abort; done'`,
still live and stuck at the time of filing) retried an identical doomed merge forever with no backoff and
no escalation past an untailed log line. `we:scripts/conveyor/branch-sync.mjs` replaces it: a tested
bounded-retry-then-escalate loop (`node scripts/conveyor/branch-sync.mjs loop` in place of the raw bash
one-liner) that never touches the working tree on a real conflict, backs off exponentially for a few
attempts, and — once capped — writes a durable alert file, fires a macOS notification, and refreshes the
`branch-drift.mjs` report immediately, rather than drifting silently. Manual `git fetch`/`rev-list`
checking at session checkpoints is no longer the only mechanism; a scratch checkout should run the new
loop instead.
