---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/advisor-trial.mjs", "we:scripts/advisor-trial-settings.json", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/advisor-trial-report.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Advisor trial: Opus advisor on sampled Sonnet FIX workers, with on/off rework comparison

Operator-approved trial (2026-10-08): add the Claude Code --advisor flag (Opus) to a deterministic hash-sampled share of background Sonnet FIX worker launches, behind we:scripts/advisor-trial-settings.json (mode off|sample|on, model, sampleRate, kinds). Record advisor on/off per run and report fix rounds per PR, post-fix review findings, tokens/cost for advisor vs no advisor. Worker model stays Sonnet.

The live fix workers launch through `claude --bg` in we:scripts/conveyor/reconcile-fix-dispatch.mjs (`dispatchFix`, via `buildAgentArgv` in we:scripts/operations/dispatch-lane-io.mjs). The Sonnet spawn in we:scripts/operations/deliver-item-wrapper.mjs is the converge editor, not a fix worker, so it is untouched.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/advisor-trial.test.mjs` passes (sampling is deterministic per run id, the settings file fails off, `buildAgentArgv` adds `--advisor opus` plus the one brief line only for a sampled run and never changes `--model`).
2. A live sampled fix run on the fix daemon launches with `--advisor opus`, and an unsampled one without it; both appear in the per-run ledger (`advisor-trial.jsonl` next to the perf snapshot store).
3. `node we:scripts/operations/advisor-trial-report.mjs` compares the arms: fix rounds per PR, findings in the next review, tokens and cost (worker + advisor).

## Edge cases this change must handle

1. **Untrusted text** — the advisor model comes from the checked-in settings file and must match a strict model-name pattern (never a flag, never Fable); review comment bodies are only regex-matched for a verdict and a findings count.
2. **Truncated reads** — bad ledger or transcript lines are skipped; a run with no transcript reports `n/a`, never 0 cost.
3. **Shared state files** — the ledger is append-only, one JSON line per launch; under test, with no explicit override, the settings read as off and no ledger row is written.
4. **Fail closed** — a missing, unreadable or malformed settings file turns the advisor OFF; a ledger write fault never fails a dispatch that already started.
5. **Identity scoping** — n/a: no auth or per-user state; the run id is the dispatcher-minted session id.
