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

Live case 2026-10-20: review clone held on 71d837a67 from 19:54Z and drain clone held from 20:06Z with established-overlay-conflict after main merged #5755 (we:scripts/lib/gh-throttle.mjs) and #5747 (we:scripts/conveyor/nightly-coroner-job.mjs, we:docs/agent/testing.md). Each stack top conflicted ONLY on those files; a manual merge of origin/main into the top (main for graduated hunks, stricter side for the attempts<=1 cap plus the main-only runTimeoutMin) audited OK and adopted. Health-watch, which lacks the hold (PR 5757 still open), instead DROPPED its 4 overlays at 20:01Z and ran plain main. Slice: when we:scripts/lib/daemon-rebuild/prepare.mjs reaches the established-overlay hold, build a candidate = registered stack top(s) + 3-way merge of origin/main, auto-resolving only hunks where exact byte-preserving evidence proves current main already carries the overlay change (see proof rule below); any other conflict keeps the hold. Run the existing smoke (we:scripts/lib/daemon-rebuild/smoke.mjs) plus touched tests via heavy-admission, and a guard-diff check (every numeric cap, timeout and validator carries the strictest parent value; see A3); adopt only if all pass, else stay held with the needs-you. Also: mechanism-pinned overlays contained in the adopted top are still replayed alone and log pinned-overlay-conflict-skipped noise. Do NOT reuse lane/build-x9diisp (087e37339, fails verify); lane/build-x9diisp-wip (f1742d48e, 2035 lines, 2 open audit findings) is reference only. Prerequisite: PR 5757 hold lands on main so every clone holds instead of dropping.

**Exact-content proof rule:** `git cherry` / `git patch-id --stable` may locate possible matches, but their equality never authorizes conflict resolution: patch IDs discard whitespace, including meaningful whitespace inside literals. Require matching paths and file types/modes, byte-identical preimages and replacements for the entire conflict region, and an unambiguous mapping to that region in the current stack top and current main. Compare raw repository bytes, preserving spaces, tabs, line endings, quoting and Unicode; verify both current tips still contain the exact replacement (a historical match later reverted or altered is insufficient), and preserve all overlay edits outside the resolved region. If that proof cannot be established, including ambiguous context, rename, binary or mode conflicts, keep the hold. Smoke and guard-diff passing cannot substitute for this proof.

## Acceptance

- [A1] **Executable** — a fixture test in we:scripts/lib/__tests__/daemon-rebuild.test.mjs replays today's case: stack top T conflicts with main only on a hunk main already carries, established by the exact-content proof rule above. Before: the rebuild returns held / established-overlay-conflict. After: it builds T+main, smokes it, and adopts it; the adopted HEAD contains T and main and retains unrelated overlay edits.
- [A2] **Must refuse** — a conflict hunk that main does NOT already carry keeps the hold and the needs-you; no candidate is adopted.
- [A3] **Must refuse** — a candidate whose guard-diff shows a numeric cap, timeout or validator weaker than the strictest parent value (that is, weaker than ANY parent: every registered stack top and main, never only "weaker than both") is never adopted: on each guard the candidate must carry the strictest parent value, so taking a weaker side is refused even when it matches one parent exactly (today's case: overlay attempts<=1 vs main's attempts 3 must keep 1; a candidate with 3 is refused). The guard-diff only checks and refuses; it never picks a side in a conflict, which stays governed by A2 and the exact-content proof rule. A guard present in only one parent must survive with that parent's value or a stricter one; a missing guard counts as weakest. Which direction is stricter is declared per guard (lower attempts is stricter; a longer backoff or wait is stricter); a guard with no declared direction keeps the hold. A weakening through any input the guard reads also counts: a settings JSON default, an env override, a fallback validator (e.g. positiveInt relaxed to nonNegativeInt), a widened regex, or a unit change under the same name. If strictness cannot be determined (non-numeric change, different units, a changed comparison operator), keep the hold. Docs, config and settings JSON hunks get the same exact-content proof requirement as code; a patch-ID match alone never permits taking main.
- [A4] **Live proof** — on the next real hold, the log shows the candidate built, smoked and adopted (or held with the reason), with before/after HEAD.
- [A5] **Whitespace-collision regression** — start with a temporary Git fixture containing a JSON parser configuration with `{"delimiter":","}`. Overlay changes it to `{"delimiter":"a b"}` and adds an unrelated commit; independent main changes it to `{"delimiter":"ab"}`. Both delimiter patches have the same stable patch ID, but splitting `lefta bright` yields two fields with the overlay and one with main. The rebuild must keep held / established-overlay-conflict, emit the needs-you, and adopt no candidate even if smoke and guard-diff would pass. Add sibling fixtures for meaningful tabs, line endings and whitespace in code literals, plus a historical exact match subsequently reverted or altered on main; each must refuse when current exact-content proof fails.
- [A6] **Executable refusals** — named fixture cases in we:scripts/lib/__tests__/daemon-rebuild.test.mjs, each asserting held (no candidate adopted, last-good HEAD unchanged, needs-you emitted) unless stated:
  - `A2 conflict hunk main does not carry` — keeps held / established-overlay-conflict.
  - `A3 main weaker: overlay attempts<=1, main attempts 3, candidate carries 3` — refused although 3 matches main exactly.
  - `A3 overlay weaker: main stricter than the top` — a candidate carrying the top's weaker value is refused.
  - `A3 higher is stricter: backoff` — the top's backoff is longer than main's; a candidate carrying main's shorter backoff is refused.
  - `A3 strictest of three parents` — two stack tops and main; a candidate carrying the middle value is refused; one carrying the strictest value passes guard-diff.
  - `A3 guard in one parent only` — a dropped guard is refused; the same or a stricter value passes guard-diff.
  - `A3 undeclared direction` — a guard with no declared strictness direction keeps the hold.
  - `A3 indirect weakening` — one case each: settings JSON default, env override, positiveInt relaxed to nonNegativeInt, widened regex, unit change under the same name.
  - `A3 strictness unknown` — non-numeric change, different units, changed comparison operator.
  - `A3 docs/config patch-ID only` — one case each for a docs hunk, a config hunk and a settings JSON hunk matched only by patch ID; each is refused.
  - `A3 guard-diff never picks a side` — the stricter side exists but the exact-content proof fails; the hold stays.
  - `Proof rule unprovable` — one case each: rename conflict, binary conflict, mode conflict, ambiguous context mapping; each keeps the hold.
  - `A5 siblings` — one case each: meaningful tab, CRLF vs LF line ending, whitespace inside a code string literal, a historical exact match later reverted on main, one later altered on main.
  - `E2 git failure or timeout` — a stubbed failing and a timing-out git call during the proof both keep the hold.
  - `E3 locked finalize` — the candidate is built in the job scratch tree; the clone and rebuild state change only inside the locked finalize.
  - `E4 any failure` — one case each: smoke fails, guard-diff fails, a touched test fails, the candidate merge or build throws; each keeps the last-good build and the needs-you.
  - `E5 removed overlay` — an overlay unregistered after the hold is absent from the candidate (the candidate built without it may still be adopted).
  - `E6 moves during smoke` — one case where main moves and one where the top moves; each discards the candidate and re-plans, never adopts.
  - `E7 attribution` — the adopted merge commit is attributed to the daemon rebuild and the log names both parent shas.

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
