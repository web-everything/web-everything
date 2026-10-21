---
kind: story
size: 5
parent: "6386"
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/overlay-strategies.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Held daemon clone builds its own stack-top + main merge candidate and adopts it when smoke passes (x9diisp auto-refresh half)

Live case 2026-10-20: review clone held on 71d837a67 from 19:54Z and drain clone held from 20:06Z with established-overlay-conflict after main merged #5755 (we:scripts/lib/gh-throttle.mjs) and #5747 (we:scripts/conveyor/nightly-coroner-job.mjs, we:docs/agent/testing.md). Each stack top conflicted ONLY on those files; a manual merge of origin/main into the top (main for graduated hunks, stricter side for the attempts<=1 cap plus main's runTimeoutMin) audited OK and adopted. Health-watch, which lacks the hold (PR 5757 still open), instead DROPPED its 4 overlays at 20:01Z and ran plain main. Slice: when we:scripts/lib/daemon-rebuild/prepare.mjs reaches the established-overlay hold, build a candidate = registered stack top(s) + 3-way merge of origin/main, auto-resolving only hunks where exact byte-preserving evidence proves current main already carries the overlay change (see proof rule below); any other conflict keeps the hold. Run the existing smoke (we:scripts/lib/daemon-rebuild/smoke.mjs) plus touched tests via heavy-admission, and a guard-diff check (no numeric cap/timeout/validator weaker than both parents); adopt only if all pass, else stay held with the needs-you. Also: mechanism-pinned overlays contained in the adopted top are still replayed alone and log pinned-overlay-conflict-skipped noise. Do NOT reuse lane/build-x9diisp (087e37339, fails verify); lane/build-x9diisp-wip (f1742d48e, 2035 lines, 2 open audit findings) is reference only. Prerequisite: PR 5757 hold lands on main so every clone holds instead of dropping.

**Exact-content proof rule:** `git cherry` / `git patch-id --stable` may locate possible matches, but their equality never authorizes conflict resolution: patch IDs discard whitespace, including meaningful whitespace inside literals. Require matching paths and file types/modes, byte-identical preimages and replacements for the entire conflict region, and an unambiguous mapping to that region in the current stack top and current main. Compare raw repository bytes, preserving spaces, tabs, line endings, quoting and Unicode; verify both current tips still contain the exact replacement (a historical match later reverted or altered is insufficient), and preserve all overlay edits outside the resolved region. If that proof cannot be established, including ambiguous context, rename, binary or mode conflicts, keep the hold. Smoke and guard-diff passing cannot substitute for this proof.

## Acceptance

- [A1] **Executable** — a fixture test in we:scripts/lib/__tests__/daemon-rebuild.test.mjs replays today's case: stack top T conflicts with main only on a hunk main already carries, established by the exact-content proof rule above. Before: the rebuild returns held / established-overlay-conflict. After: it builds T+main, smokes it, and adopts it; the adopted HEAD contains T and main and retains unrelated overlay edits.
- [A2] **Must refuse** — a conflict hunk that main does NOT already carry keeps the hold and the needs-you; no candidate is adopted.
- [A3] **Must refuse** — a candidate whose guard-diff shows a numeric cap, timeout or validator weaker than BOTH parents is never adopted (today's case: attempts<=1 vs main's attempts 3 must keep 1). Docs, config and settings JSON hunks get the same exact-content proof requirement as code; a patch-ID match alone never permits taking main.
- [A4] **Live proof** — on the next real hold, the log shows the candidate built, smoked and adopted (or held with the reason), with before/after HEAD.
- [A5] **Whitespace-collision regression** — start with fixture `we:parser.json` containing `{"delimiter":","}`. Overlay changes it to `{"delimiter":"a b"}` and adds an unrelated commit; independent main changes it to `{"delimiter":"ab"}`. Both delimiter patches have the same stable patch ID, but splitting `lefta bright` yields two fields with the overlay and one with main. The rebuild must keep held / established-overlay-conflict, emit the needs-you, and adopt no candidate even if smoke and guard-diff would pass. Add sibling fixtures for meaningful tabs, line endings and whitespace in code literals, plus a historical exact match subsequently reverted or altered on main; each must refuse when current exact-content proof fails.

## Non-goals

- [N1] No Codex or model call inside the rebuild; resolution is deterministic (clean 3-way or the exact-content proof rule only; patch-id / git cherry are discovery hints).
- [N2] Not the hold itself (PR 5757) and not the parked full redesign on lane/build-x9diisp-wip.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are git objects from registered refs only; no free text is parsed.
2. **Truncated reads** — a git command that fails or times out reads as "cannot prove main carries it" and keeps the hold.
3. **Shared state files** — the candidate is built in the existing detached rebuild job scratch tree; the clone and rebuild state are only written by the existing locked finalize.
4. **Fail closed** — any error, smoke failure or guard-diff failure keeps the last-good build and the needs-you.
5. **Identity scoping** — the candidate carries only overlays still registered on THIS clone; a removed overlay is never brought back.
6. **State over time** — if main or the top moves while the candidate smokes, the candidate is discarded and re-planned (same rule as the ready-candidate matcher).
7. **Who wrote it** — the auto-merge commit is attributed to the daemon rebuild and logged with both parent shas.
