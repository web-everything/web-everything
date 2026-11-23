## Remote client import failures

Importing a host-selected remote client executes its top-level code. Neither an import exception nor
a missing or non-callable `runRemote` export establishes that remote work never started: preserve
exit 124 and the operator instruction to confirm termination before retrying. Changes to this boundary must run
`scripts/readiness/__tests__/heavy-admission-remote-client.test.mjs` and
`scripts/readiness/__tests__/heavy-admission-remote.test.mjs` through the host heavy-run queue.
Only the real host preferences file may select `heavyAdmission.remote.clientPath`; fixtures use
`loadAdmissionPolicy({ home })` for this trust boundary, never an env-selected executable path.
An env-selected preferences file keeps its other settings but strips this leaf after last-good fallback,
logs the ignored path with bounded diagnostics, and uses a separate policy cache key from host selection.
Keep the named regression **refuses local rerun when import starts work before throwing**: it observes
an initialization side effect before the throw and requires exit 124 without local fallback.
Also keep **refuses local rerun when import starts work before a missing runRemote export**: it
observes initialization before export validation fails and requires the same refusal.

Remote override provenance runs after client invocation as a detached, best-effort task. SHA lookup
uses asynchronous Git so it cannot block the execution timer; neither its one-second bound nor the
100 ms persistence bound belongs on the client path. The never-resolving SHA/event regressions require
client invocation and success before advancing fake time. Provenance assertions must await background
writes explicitly while preserving once-per-process logs and change-only events.
Identify path changes with the persisted SHA-256 `pathKey` of the raw resolved client path plus the SHA;
sanitized display paths can collide. Legacy state without `pathKey` emits fresh provenance once, while
event details keep only sanitized paths and SHAs.
The real CLI drains tracked provenance only after the remote decision, for at most 1500 ms, with
an unref'd timer cleared on completion. Set the remote exit code before awaiting so natural exit
also preserves nonzero results. Keep native CLI regressions for fast event/state persistence and
never-settling provenance both with and without another live handle; fake timers separately prove
the drain cap, oversized/invalid budget clamping, timer cleanup, and removal of settled tasks.

The persistence deadline cannot cancel a filesystem open blocked on a FIFO. Before reading override
state, use `lstat` to reject symlinks and special files, and skip reads above the 4096-byte cap.
Open descriptors with `O_NONBLOCK | O_NOFOLLOW` where supported and verify the descriptor is regular.
Publish through an exclusive sibling temp file plus rename, checking the destination is still absent
or regular before replacement. Unreadable or special state skips persistence while the client runs.
The native FIFO regression in `heavy-admission-import-boundary.test.mjs` must let its subprocess exit
naturally under a timeout: observing the client result alone misses a live, abandoned filesystem request.
For the default override event append, resolve the destination with `daemonEventsPath`, then open it
with `O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK | O_NOFOLLOW` (guard optional flags). Check the
opened descriptor with `fstat` and write only to a regular file, always closing it. A path `lstat`
before a blocking append leaves a swap-to-FIFO race that the persistence timeout cannot cancel.
Skip errors and non-regular destinations without recording the pair as emitted; injected event
writers retain their IO seam. Keep the existing parent-directory restriction. Compare the emitted
JSON line byte-for-byte with `appendDaemonEvent` for the same input and timestamp.
Keep the separate native daemon-events FIFO case, including client success and absent pair state,
alongside symlink, directory and invalid-parent cases and real missing/existing regular-file writes.

