---
name: use-codex
description: Delegate ONE real coding task to Codex CLI's agentic (tool-bearing) mode as a personal escape hatch, when the operator's own Claude usage is running low and the task is well-scoped enough not to need deep repo-specific judgment. Use when the operator says "use codex for this", "I'm low on usage, hand this to codex", or "delegate this to codex". NOT part of the product's own dispatch pipeline (that's `we:scripts/lib/codex-judge-spawn.mjs`, a tool-FREE schema-constrained judge role) and NOT for anything the operator wants committed/pushed automatically — this NEVER commits, NEVER pushes.
---

# Delegate a task to Codex CLI, agentic mode (a personal escape hatch)

**The method lives in `we:scripts/codex-direct-task.mjs`'s own header** — argv construction, the real
`codex exec --help` flags this was built from (not assumed from the tool-free judge-role probe, `#3371`),
the JSONL event-stream shape a real agentic run produces (`command_execution`/`file_change`/`agent_message`
items, confirmed live — not just a coarse final blob), and why the log file lives inside `.git/`. Don't
restate that here; if the argv or parsing changes, edit that file's header, not this skill.

## When to reach for this

- Your own Claude usage is running low and you still have a well-scoped coding task to get done tonight.
- The task doesn't need deep repo-specific judgment a fresh agent would lack — a scratch clone of this repo
  carries `we:AGENTS.md`, so Codex sees the same doctrine you do, but it hasn't seen this conversation.
- You want a real diff to review, not an auto-committed change. If you want something committed and PR'd
  without your review, this is the wrong tool — use the normal `/pr` flow yourself once you're happy with
  the diff this produces.

## The loop

1. Pick a target: an **existing lane/checkout** you already have (`--dir=<path>`), or let it make a
   **fresh scratch clone** of this repo (omit `--dir`; needs `--repo-root=<path>` unless run from inside a
   checkout, in which case it derives one from `git rev-parse --show-toplevel`).
2. Run it, with a real task description:
   ```
   node scripts/codex-direct-task.mjs --task="<what you want done>" [--dir=<checkout>] [--gate=standards|full]
   ```
   Long or multi-paragraph tasks: write them to a file and pass `--task-file=<path>` instead of fighting
   shell quoting.
3. **Watch it work.** The JSONL event stream prints to stdout live (unless `--no-stream`) and is always
   logged to `<dir>/.git/codex-direct-task.jsonl` — `tail -f` that file from another terminal to poll a
   long-running task instead of waiting on this one blocking.
4. **Read the report.** It ends with the real `git diff`/`git status` in the target dir — nothing more.
   If Codex made any commits despite being told not to (rare; belt-and-braces, not expected), the report
   flags it explicitly so you know there's a commit boundary inside the diff before you use it.
5. **You decide what happens next** — review the diff, `cd` into the dir and keep editing by hand, or land
   it yourself through the normal lane/PR flow. Nothing here does that for you.

## Safety note — read before running

**This script never runs `git commit`, `git add` (beyond a content-free `--intent-to-add` so new files show
up in the diff), or `git push`, and never opens a PR.** That is a hard property of the script, not a
default you need to opt into. The task prompt also tells Codex itself not to commit/push, but Codex has
real shell access in `workspace-write` mode and could in principle disobey — the diff capture is written to
be correct either way (it diffs against the commit that existed before the run started, regardless of what
happened in between), and the CLI report says plainly if that happened.

## Flags worth knowing

`--gate=none` (default, fastest) | `standards` (`check:standards` only) | `full` (`check:standards` +
the whole `vitest run` suite — this does **not** try to scope tests to what changed; that's a real gap,
not a silent claim). `--timeout-ms=` (default 30 min) is a parent-imposed wall — Codex has no CLI-side
timeout of its own. `--ephemeral` skips Codex's own session persistence (default: persisted, so a stalled
run is resumable by hand via `codex exec resume <thread-id>` — the report prints the thread id).

**Model / effort — per-task routing** (operator re-ratification, 2026-10-12):

- `--task-kind=<kind>` defaults to `worker`, or `review` with `--review`.
  `fix`, `ci-heal`, `build`, `worker`, and `review` default to `gpt-6.1-sol` / `medium`;
  `trivial` to `gpt-6-luna` / `low`; `prepare` to `gpt-6-astra` / `medium`;
  `prepare-complex`, `takeover`, `design`, and `review-mandatory` to `gpt-6-astra` / `high`.
- `--size=<n>`, `--epic`, `--decision`, and `--care=low|normal|elevated|high` classify preparation:
  size ≥ 8, epic, decision, or elevated/high care selects `prepare-complex`.
  Aliases: `stronger`/`stronger-model` → `takeover`; card filing/rename/prevention and conflict → `trivial`;
  `delivery` → `build`; `heal` → `ci-heal`.
- `--model=<slug>` overrides the route's model. `CODEX_MODEL` remains the Astra registry identity and
  strong rung, while launch defaults come from `codex.modelByTask`.
- `--effort=low|medium|high|xhigh|max|ultra` overrides effort unchanged. Known unsupported pairs
  (for example Luna + ultra) throw; unknown caller-pinned models defer entitlement to Codex.
- `--tier=haiku|sonnet|opus` selects `low`/`medium`/`high` effort only; explicit `--effort` wins.
  With neither flag, the task route supplies effort.

Cascade: standard defaults → platform `codexModelByTask` → `scripts/settings/codex.json`
→ `WE_CODEX_MODEL_BY_TASK` JSON → explicit caller pins. Each launch logs its task, model, effort,
per-leaf sources and usage bucket. `--json` includes the full route. Bucket attribution is observed
rollout evidence, not a field supplied by the model catalogue.

**`--clear-rollout-after-run`** (default off) — `#3635` Fork 4. Every non-`--ephemeral` run reads a real
quota signal (`used_percent` / `window_minutes` / `resets_at` / `plan_type`) out of Codex's persisted rollout
file and prints it in the report; there is no USD figure anywhere in Codex's output, this is the closest
thing. This flag switches that read to the ratified **read-then-delete** shape: read the one record, then
delete the rollout file — same net cleanliness as `--ephemeral`, but the signal gets read first. **It costs
you `codex exec resume`**, which is exactly why it is off by default here (a personal escape hatch's stalled
run is worth resuming). Turn it on only for a fire-and-forget run you will never resume. It is a no-op
alongside `--ephemeral`, which writes no rollout to read or delete in the first place.
