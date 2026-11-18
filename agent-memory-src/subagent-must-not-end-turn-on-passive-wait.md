---
name: subagent-must-not-end-turn-on-passive-wait
description: "A subagent that starts a gating check (verify-lane, a CI/merge poll, a backgrounded test run) must never end its turn assuming a notification will wake it — that exists only for a Task/Agent-type background job the harness itself tracks, never for a subagent's own backgrounded Bash command or an untracked nested child."
metadata:
  type: feedback
---

**A subagent (or any agent) that kicks off a long-running gating check — a test suite, `verify-lane`,
a CI/merge poll, anything whose completion decides the next step — must not end its turn assuming
something will wake it up later, unless it is specifically a Task/Agent-type background job the
harness itself tracks (that does generate a real completion notification).** A backgrounded Bash
command, or an ad hoc "I'll check back," generates no such notification.

**Why:** hit live 2026-09-04, across one long session on epic #3383. FOUR separate subagents were
dispatched to do real work (land a PR, author a memory note, extract a skill, fix a bug), each
involving a gating step — `verify-lane`, a merge-status poll, a background check. In every one of
the four cases, the subagent ran the gating step via a backgrounded Bash call (or delegated it to a
further nested subagent) and then ended its own turn with language like "I'll wait for the
background task notification before continuing" — but no such notification exists for a subagent's
own backgrounded Bash command or a nested child it isn't tracking as a live background agent. The
orchestrating session had to notice each stall (sometimes only because the user pointed out "seems
to have stopped"), then explicitly resume each one with a message telling it to check state
directly instead of waiting. Same failure shape, four times in a row — a systemic gap in how
subagents reason about backgrounding, not a one-off.

**How to apply:**
1. Run the gating command (test suite, `verify-lane`, a CI/merge poll) in the FOREGROUND and block on
   its actual completion within the same turn — this is the default.
2. If backgrounding is genuinely necessary (the command is very long), actively poll it yourself in
   a loop within your own turn rather than ending the turn early.
3. If ending the turn is truly unavoidable, say so EXPLICITLY — "I am stopping mid-task and need to
   be resumed with a follow-up message" — never imply a notification will arrive on its own.
4. When authoring an Agent-tool/Task-tool prompt that asks a subagent to run a multi-step pipeline
   ending in a gate (verify-lane, tests, a review/merge wait), instruct it up front: run gating
   checks in the foreground; do not end your turn on a passive wait; if you must background
   something, poll it yourself before ending your turn. Standing practice for any Agent-tool dispatch
   that involves a build/verify/land pipeline, not just this one instance.

**Escalation, 2026-09-04 (#3383 cont'd):** landing this note alone did not fix the recurrence — it is
pull-based (a fresh subagent has no reason to open `agent-memory-src/` unless told), and the SAME
failure hit at least 3 more times on different subagents afterward. The load-bearing instruction (the
"How to apply" bullets above, condensed) is now also **pinned directly in `we:CLAUDE.md`** — the one
file confirmed to auto-load into every session and every Agent-tool subagent's context regardless of
cwd (main checkout, lane clone, or VM). Keep the full story here; keep `CLAUDE.md` terse and pointing
back to this file — don't let the two drift apart.

**Update 2026-10-31 (Claude Code 2.1.316):** the harness-tracking line moved. A subagent's foreground Bash call
that runs longer than ~180s is MOVED to the background by the harness, and the subagent IS resumed when it
completes (proven 08:05:49 to 08:09:09 ET with a 200s sleep). So harness-moved calls and `run_in_background`
calls are harness-tracked and wake the agent; it may end its turn on them. Only self-detached shell jobs
(`&`, `nohup`, `setsid`) and untracked nested children do not wake it, and those stay forbidden as a passive
wait. Unchanged: pass `timeout: 600000`; don't poll; don't start a second copy; `codex-direct-task.mjs` and
`gemini-direct-task.mjs` are synchronous. The poll-blocking hook stays.
