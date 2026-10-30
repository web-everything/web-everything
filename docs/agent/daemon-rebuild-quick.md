# Daemon rebuild quick mode

`daemonRebuild.quick` defaults to false in `scripts/lib/daemon-rebuild-settings.json` and resolves
through the policy cascade; `WE_DAEMON_REBUILD_QUICK=1|0` overrides it. Quick candidates defer only
`dispatch-dry-run` and `reconcile-dry-run`, take one smoke attempt without confirmation, and use a
60-second finalize wait unless `WE_DAEMON_FINALIZE_LOCK_WAIT_MS` overrides it. The pure policy and
protected path list live in `scripts/lib/daemon-rebuild/quick.mjs`. Unknown, malformed or oversized
change sets select full smoke. Gate code, dispatch entries, the shared dispatch core paths,
dispatch settings and package manifests/locks always select full smoke. Transitive-only imports
and unknown import closures do not block quick mode: the deferred checks still run after adoption
with rollback. Each rebuild logs one `daemon-rebuild: quick=on|off reason=...` line and records a
`quick-decision` alert, including the triggering protected file or disabled setting provenance.

Keep quick provenance on ready records: adopting a partial pass as a full pass loses its owed soak.
An already-HEAD quick fallback still persists its unverified marker and schedules the deferred checks;
HEAD equality supplies no soak proof. Snapshot the last-good record before marking adoption unverified.
The soak uses the shared job runtime with `maxAttempts: 1`; its detached launcher prepares the pinned
code/dependency snapshot off-tick and records its PID/start-time identity during that preparation.
The worker holds a read slot while running both deferred dry runs and then `tree-stays-clean` last,
then settles under the write lock. All three rows must provide fresh, unskipped evidence; the
pre-adopt deferred list remains exactly the two dry runs.
Its token/SHA-bound result is durable before the completion lock is attempted. Later ticks
consume that result or recover a missing/dead/expired worker as `quick-soak-unavailable`; the
one-hour deadline is derived from the exact recorded `adoptedAt`. Failure/unavailability rolls
back to the previous last-good record; an unsafe rollback quarantines rather than discarding dirt.
Quick partial passes never enter the full-smoke proof cache.
Quick quarantine retries and interrupted-adoption recovery use the same untracked-aware guarded rollback
as soak settlement; ignored files and ancestor-path collisions must survive recovery with quarantine and a needs-you page.
Regression home:
`scripts/lib/__tests__/daemon-rebuild-quick.test.mjs` (private state/lock roots and injected children).

Pipeline fixtures keep dispatch entry bytes identical while renaming, removing or adding a
referenced dependency, and assert quick smoke and a marked ready record. Entry and gate-code
changes retain full-smoke assertions. Decision visibility fixtures check enabled, disabled and
protected-path outcomes in both the log and alerts file, with one decision across fallback stages.

Cache-exclusion fixtures need complete, unskipped evidence and a full-mode positive control that actually
inserts a proof; incomplete rows would independently prevent caching and mask a missing quick guard.
Deadline-bound fixtures need a live worker whose recorded deadline is still ahead of now but exceeds
`adoptedAt + QUICK_SOAK_MAX_MS`; simple expiry does not exercise the adoption-relative bound.

### Quick soak contention and recovery

`daemon-rebuild-quick.test.mjs` covers the post-adopt read barrier (ten one-minute retries),
three durable soak attempts relaunched only at tick boundaries, and the original one-hour adoption
budget across retries. Historical markers with no `soakAttempts` count as attempt one; malformed
or exhausted counters fail closed. Rotate the token before scheduling a retry so late worker evidence
cannot settle its successor. Terminal unavailable outcomes and refused rollbacks emit
`quick-soak-needs-you` with the rollback result as well as the normal outcome alert.
Quick settlement opts into `rollbackToSha`'s untracked-file exception; its default still refuses
untracked dirt, and tracked changes always refuse. Keep the real-Git sidecar-preservation cases.

The untracked exception must reject collisions with the rollback target, including a sidecar at
an exact target path, a file obstructing a target directory, or a directory obstructing a target
file. Include ignored files in the collision inventory. The named real-Git collision regressions
assert refusal, unchanged HEAD, preservation of binary sidecar bytes, quarantine and paging.
Failed, missing, truncated or oversized path inventories refuse rollback as `status-failed`;
keep the named evidence-refusal cases alongside the preservation cases.
