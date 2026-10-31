# Claude Instructions for Web Everything

> **Canonical instructions live in [AGENTS.md](./AGENTS.md).** This stub exists so Claude Code
> auto-loads the pointer. Read `AGENTS.md` (the Tier-0 router), then follow its links into
> `docs/agent/*.md` only as the task requires — this keeps context lean.

## Pinned rule (the one exception to "just a pointer" — see why below)

**Never end a turn on a self-detached job.** A Bash call the harness runs long (over ~180s it moves it to
the background) or that you start with `run_in_background` is harness-tracked: it wakes you when done, so you
may end your turn on it (Claude Code 2.1.316, proven 2026-10-31). A job you detach yourself (`&`, `nohup`,
`setsid`) or an untracked nested child never wakes you. Run gating checks (tests, `verify-lane`) as normal Bash
calls with `timeout: 600000`; don't poll and don't start a second copy. If you must stop mid-task, say so
explicitly. Full rationale + evidence:
[`agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md`](agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md).

The concrete case that has caused this exact violation to recur tonight is dispatching
`scripts/codex-direct-task.mjs` and `scripts/gemini-direct-task.mjs`: BOTH are already synchronous
and block until the delegated model's task completes. Run them as normal foreground Bash calls,
never wrapped in Monitor or a nested wait, and never with a second copy — there is nothing to
watch; the call itself already returns the final result.

*(Pinned here, not in `AGENTS.md`/`docs/agent/`, because those are pull-based — a fresh subagent has
no reason to open them unless told. This file is the one thing confirmed to auto-load into every
session **and** every Agent-tool subagent's context regardless of cwd — main checkout, lane clone, or
VM. The lesson above first landed only in `agent-memory-src/` and the same failure recurred 3+ times
afterward on different subagents, because nothing pulled it in automatically, #3383.)*

See **[AGENTS.md](./AGENTS.md)**.
