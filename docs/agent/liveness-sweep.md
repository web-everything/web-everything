# Liveness sweep

Gather optional observations, detect stalls, print plans; dry-run is the default.
A failed source is reported in `errors`, never treated as a fatal sweep failure.

Detected kinds:
- `pr-no-movement`: no meaningful check/comment movement or live owner past 120 minutes.
- `pr-red-unowned`: red checks without review labels or a live owner past 60 minutes.
- `pr-past-cap-fix-waiting`: changed head awaits review at or beyond the granted round cap.
- `daemon-update-refused`: rejected self-update without retry or newer activity past 30 minutes.
- `verify-lane-held`: finished gate still holds a lane past 30 minutes, with fresh log evidence.
- `claim-holder-gone`: stale-state proves a claim/lane holder dead past 60 minutes.

| Kind | Ladder |
| --- | --- |
| daemon-update-refused | retry-self-update → refresh-stale-base (when overlay PR known) → notify-operator |
| verify-lane-held | release-dead-lane → notify-operator |
| claim-holder-gone | release-dead-claim → notify-operator |
| All three PR kinds | notify-operator |

Only `retry-self-update` and `release-dead-lane` execute under `--apply`.
Retry takes the clone write lock, rechecks rejection and schedules one retry; adoption
still requires passing smoke. Lane release requires no gate process carrying the lane
argv, refuses unreadable ps, and delegates remaining safety checks to operator release.
Neither action loosens gates or human review. Each rung gets at most `maxRungAttempts`
attempts per episode before escalation. A recovery that succeeded after the finding's latest
evidence is treated as taking effect and is not re-planned (new evidence re-opens it). Disabled rungs notify via their fallback;
any rung with `requires` is never executed, regardless of settings.

Settings cascade: standard → platform `livenessSweep` →
`scripts/settings/liveness-sweep.json` → env. Each valid leaf wins independently.

| Setting | Default | Environment override suffix |
| --- | --- | --- |
| prNoMovementMinutes | 120 | PR_NO_MOVEMENT_MINUTES |
| prRedUnownedMinutes | 60 | PR_RED_UNOWNED_MINUTES |
| selfUpdateRefusedMinutes | 30 | SELF_UPDATE_REFUSED_MINUTES |
| laneHeldMinutes | 30 | LANE_HELD_MINUTES |
| claimHolderGoneMinutes | 60 | CLAIM_HOLDER_GONE_MINUTES |
| reviewRoundCap | 5 | REVIEW_ROUND_CAP |
| maxRungAttempts | 2 | MAX_RUNG_ATTEMPTS |
| rungs.retry-self-update | true | RUNG override via RUNGS JSON |
| rungs.release-dead-lane | true | RUNG override via RUNGS JSON |
| rungs.refresh-stale-base | false | RUNG override via RUNGS JSON |
| rungs.release-dead-claim | false | RUNG override via RUNGS JSON |

Env names begin `WE_LIVENESS_SWEEP_`; `RUNGS` accepts a JSON object.
Human output logs the source line beneath the header; JSON includes settings, sources,
and invalid values. Health smell resolves settings once when loaded, with no new probe.

Recovery ledger: `~/.claude/liveness-sweep/recoveries.jsonl`, overridden by `--ledger=`
or `WE_LIVENESS_SWEEP_LEDGER`. Rows: `{at, actor:'system', kind, subject, rung,
enabled, reason, outcome, detail}`. Execution outcomes are succeeded/failed/refused;
escalation detail contains the exact `op` plus any notification error. One escalated
row per kind+subject episode suppresses repeated notifications. Dry-run adds no rows.
Movement memory: `~/.claude/liveness-sweep/pr-movement.json` (`--movement-store=` or
`WE_LIVENESS_SWEEP_MOVEMENT_STORE`); fingerprints head, labels and latest check results.
It writes even in dry-run; `--no-movement-store` disables it. Closed PRs are dropped;
failed repo observations preserve their memory. First sight falls back to check/comments.

```bash
node scripts/conveyor/liveness-sweep.mjs                    # dry-run
node scripts/conveyor/liveness-sweep.mjs --apply            # enabled recoveries
node scripts/conveyor/liveness-sweep.mjs --json             # one JSON object
node scripts/conveyor/liveness-sweep.mjs --with-stale-state # slow holder proof
```

`--self-sync-dir=` overrides daemon state/alerts; `--verify-log=` overrides the verify log.
Default logs/state derive from `homedir()`; tails are bounded to 256/512 KiB.

Follow-ups: wire `--apply` into the health-watch tick (health-watch.mjs is held by an
open PR today); route notify-operator rows into the operator queue and the PR #5169
operator ops (`refresh`, `grant-rounds`). Until those land, requires rungs stay off.
Tracked in card `xozb05m`.
