## Dispatch eligibility reports

When the runner is alive but an item does not move, use
`node scripts/operations/run.mjs dispatch-eligibility --item=NNN --json` (omit `--item` for
all cleared queue entries). Supply the runner's `--bookkeepingFile=<path>` when available.
The report reuses `dispatch-lane-io.mjs#readTick` and `dispatch-lane.mjs#shapeDispatchRead`.
`verdict.items[].gates` records the executed short-circuit path; later gates were not evaluated.
`buildAdmission.selection` records the existing `selectClearedRows` / `clearedNotReady` checks;
`buildAdmission.gates` is `dispatchPlan`'s ordered build trace. A build hold can route to preparation
or PR repair; `buildAdmission.prepare` records `planPrepareSpawns`'s guard, existing-PR and lane checks.
The first blocking gate names the failing recorded condition, including that alternate prepare route. `markers` are observed values, not additional
admission rules: a missing `deliveryAgent` is not a refusal in this path, and an omitted
`deliveryTarget` resolves to `main`.

Attach the JSON, observation time, item id, and expected progress to a starvation bug filed
through the `file-item` operation. Preserve `guardsFrom`, dropped bookkeeping and unreadable
record counts: an incomplete observation must not read as a complete guard check.

Eligibility reads explicitly send `config.verbose: false` to the tick CLI: omitting it advances
and persists the runner's bounded diagnostic verbose window, even if liveness recording is disabled.
The prepare trace records `dispatch-paused` before its other gates so an unscoped item's build
`scope` hold does not mask the pause. Whole-queue shaping errors appear on the affected entry as
`error` with `eligible: false`; single-item invariant failures retain the CLI error contract.

### Standalone worker declines

No-change already-done reports must reach `planHoldRouting` before the decline prefix is added.
The shared classifier requires `spec already done on main: commit <sha>`; the worker verifies
Done-when against main and supplies that citation. Exercise the existing `landRoute` with a temporary
Git origin: assert `graduatedTo`, unchanged scope, unrelated-citation refusal, and launch-checkout
isolation. A bare already-exists assertion is insufficient and retains the decline path.

Standalone no-change builds (#4552): replay with an empty implementation diff and a launcher report (Codex `lastMessage` or Gemini `events.finalResponse`). Assert the Findings note and scope removal on disk, the `worker-declined` dispatch hold, and the router lease that prevents duplicate landing. The card stays open; the existing verified PR path parks it `review:pending`. Missing final text must exercise the same path with a generic finding. Codex `--json` can emit JSONL before its pretty-printed report: replay that mixed stdout, prefer the report, and fall back to completed agent-message events or a fresh lane log before cleanup. Gemini uses result responses or per-step agent-response deltas. Never reuse an untouched prior-run log. Blocker references in decline Findings are advisory (`possible blocker: #NNN`); prepare verifies them before setting `blockedBy`.

