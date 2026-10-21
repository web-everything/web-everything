---
bornAs: xqz26k1
kind: story
size: 5
parent: "6386"
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/overlay-strategies.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Held daemon clone builds its own stack-top + main merge candidate and adopts it when smoke passes (x9diisp auto-refresh half)

Live case 2026-10-20: review clone held on 71d837a67 from 19:54Z and drain clone held from 20:06Z with established-overlay-conflict after main merged #5755 (we:scripts/lib/gh-throttle.mjs) and #5747 (we:scripts/conveyor/nightly-coroner-job.mjs, we:docs/agent/testing.md). Each stack top conflicted ONLY on those files; a manual merge of origin/main into the top (main for graduated hunks, stricter side for the attempts<=1 cap plus main's runTimeoutMin) audited OK and adopted. Health-watch, which lacks the hold (PR 5757 still open), instead DROPPED its 4 overlays at 20:01Z and ran plain main. Slice: when we:scripts/lib/daemon-rebuild/prepare.mjs reaches the established-overlay hold, build a candidate = registered stack top(s) + 3-way merge of origin/main, auto-resolving only hunks where git cherry/patch-id shows main already carries the change; any other conflict keeps the hold. Run the existing smoke (we:scripts/lib/daemon-rebuild/smoke.mjs) plus touched tests via heavy-admission, and a guard-diff check (no numeric cap/timeout/validator weaker than both parents); adopt only if all pass, else stay held with the needs-you. Also: mechanism-pinned overlays contained in the adopted top are still replayed alone and log pinned-overlay-conflict-skipped noise. Do NOT reuse lane/build-x9diisp (087e37339, fails verify); lane/build-x9diisp-wip (f1742d48e, 2035 lines, 2 open audit findings) is reference only. Prerequisite: PR 5757 hold lands on main so every clone holds instead of dropping.

## Acceptance

- [A1] **Executable** — a fixture test in we:scripts/lib/__tests__/daemon-rebuild.test.mjs replays today's case: stack top T conflicts with main only on a hunk main already carries (patch-id match). Before: the rebuild returns held / established-overlay-conflict. After: it builds T+main, smokes it, and adopts it; the adopted HEAD contains T and main.
- [A2] **Must refuse** — a conflict hunk that main does NOT already carry keeps the hold and the needs-you; no candidate is adopted.
- [A3] **Must refuse** — a candidate whose guard-diff shows a numeric cap, timeout or validator weaker than BOTH parents is never adopted (today's case: attempts<=1 vs main's attempts 3 must keep 1). Docs, config and settings JSON hunks get the same rule; they are never auto-taken from main unless the patch-id matches.
- [A4] **Live proof** — on the next real hold, the log shows the candidate built, smoked and adopted (or held with the reason), with before/after HEAD.

## Non-goals

- [N1] No Codex or model call inside the rebuild; resolution is deterministic (patch-id / git cherry / clean 3-way only).
- [N2] Not the hold itself (PR 5757) and not the parked full redesign on lane/build-x9diisp-wip.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are git objects from registered refs only; no free text is parsed.
2. **Truncated reads** — a git command that fails or times out reads as "cannot prove main carries it" and keeps the hold.
3. **Shared state files** — the candidate is built in the existing detached rebuild job scratch tree; the clone and rebuild state are only written by the existing locked finalize.
4. **Fail closed** — any error, smoke failure or guard-diff failure keeps the last-good build and the needs-you.
5. **Identity scoping** — the candidate carries only overlays still registered on THIS clone; a removed overlay is never brought back.
6. **State over time** — if main or the top moves while the candidate smokes, the candidate is discarded and re-planned (same rule as the ready-candidate matcher).
7. **Who wrote it** — the auto-merge commit is attributed to the daemon rebuild and logged with both parent shas.
