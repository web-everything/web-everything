---
bornAs: x8yishg
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:CLAUDE.md", "we:agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md", "we:scripts/operations/dispatch-lane.mjs"]
dateOpened: "2026-09-22"
tags: []
---

# A dispatched worker ending its turn on an armed Monitor / backgrounded gate is mechanically detectable — hook it

Dispatched workers keep ending their turn on an armed Monitor / a backgrounded gate process
(`we:verify-lane.mjs`, `we:push-if-green.mjs`, a lane-lease poll, etc.) instead of running it to completion in
the foreground, assuming a notification will wake them — despite the rule against this already being
written down in `we:CLAUDE.md`'s pinned section and
`we:agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md`. This happened 5-6 separate times
across different dispatched workers/tasks on 2026-09-22, each caught and corrected individually by the
orchestrating session, none self-caught by the worker. The rule existing in loaded context has not
stopped the recurrence — that gap is what this card closes, not a restatement of the rule.

Per memory rule 51 ("Hookable vs Judgment Rule" — script-decidable compliance moves to a deterministic
hook; judgment stays in context; `we:agent-memory-src/51-feedback_hookable_vs_judgment_rule.md`), this
specific failure shape is mechanically detectable from session/transcript state: a session's LAST tool
call is an armed Monitor or a backgrounded long-running gate process, with no synchronous result
recorded and no tracked notification pending, before the turn ends. That is a pattern a script can
classify from the transcript/tool-call record alone — it does not need judgment — so it is a hook
candidate, not just a stronger instruction. (`we:agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md`'s
own escalation note already records that pinning the rule in `we:CLAUDE.md` alone did not fix a prior
recurrence of the same failure shape on 2026-09-04.)

Scope the build to explore BOTH candidate angles rather than prescribing the mechanism:
(a) a `Stop`-hook-style or session-end check that detects "ended turn with an unresolved backgrounded
gate/Monitor and no notification wiring the harness itself tracks" and blocks or warns before the turn
actually ends; and
(b) whether the dispatch brief template itself (`we:scripts/operations/dispatch-lane.mjs` or wherever it
is sourced from) should carry this rule inline near the top, not just rely on `we:CLAUDE.md`'s auto-load,
since briefs are long and the rule may be getting lost inside them.
Let the build decide which mechanism (or both) actually closes the gap; this card states the requirement
and the two candidate angles, not the implementation.

## Done when

1. **Executable** — a reproducible test/fixture that simulates a dispatched worker ending its turn on an
   armed Monitor (or a backgrounded gate process) with no tracked notification pending, and the new check
   fires: a hook denial, or an automated lint over a sampled transcript — whichever mechanism the build
   settles on.
2. **No false positives** — the same check does NOT fire on the legitimate patterns already in use: a
   genuine backgrounded Agent/Task-type call that the harness itself tracks (generates a real completion
   notification), or a `notify_when_idle`-style subscription established via `SendMessage`. Confirm this
   against at least one fixture per legitimate pattern.

## Held-card additions (2026-11-01, themes: worker-process guards)

- Recurred 3x on 2026-11-01 (perf10, perf5, perf2) despite the pinned rule. Ship a Stop hook for worker subagents that refuses to end while a run_in_background Bash or Monitor the worker started is still live (naming the task), and have we:scripts/worker-brief.mjs state it in the rules block. #6182 did part of this; file the remainder here. See also the async job-id card xqkquxb, which removes the root cause.
