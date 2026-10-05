/** @file scripts/lib/daemon-rebuild/index.mjs — the daemon-clone rebuild's public surface. Re-exports ONLY; no
 * code lives here. `scripts/lib/daemon-rebuild.mjs` (the compatibility entry and CLI) re-exports this, so every
 * existing import path keeps working. The design notes are in that entry file's header.
 */

export { rebuildClone } from './rebuild.mjs';
export {
  DAEMON_STATE_FILES, findUnsafeLocalState, isClaimStampOnlyEdit, migrateDaemonStateFiles,
  restoreStrayClaimStamps,
} from './local-state.mjs';
export {
  HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV, SLOW_SMOKE_ALERT_MS, failsSameChecks, isExternalOnlyFailure,
  rejectRetryDelayMs,
} from './smoke.mjs';
export {
  DEFAULT_ENV_LOAD_RETRY_BASE_MS, DEFAULT_ENV_LOAD_RETRY_MAX_MS, ENV_LOAD_RETRY_BASE_ENV,
  ENV_LOAD_RETRY_MAX_ENV, LOAD_CONTENTION_SIGNATURES, SMOKE_LOAD_DIFFERENTIAL_ENV, envLoadRetryDelayMs,
  isLoadShapedRow, loadDifferentialEnabled,
} from './smoke-classify/index.mjs';
export {
  DEFAULT_FINALIZE_LOCK_WAIT_MS, DEFAULT_READY_MAX_AGE_MS, DEFAULT_REBUILD_LEASE_STALE_MS,
  DEFAULT_REBUILD_LOCK_WAIT_MS, DEFAULT_STARVED_LOCK_WAIT_MS, DEFAULT_STARVE_ESCALATE_AFTER,
  FINALIZE_LOCK_WAIT_ENV, READY_MAX_AGE_ENV, REBUILD_LEASE_STALE_ENV, REBUILD_LOCK_WAIT_ENV,
  STARVED_LOCK_WAIT_ENV, STARVE_ESCALATE_AFTER_ENV, buildLeaseIsLive, readRebuildStarvation, starvationLockWaitMs,
} from './lease.mjs';
export { matchReadyCandidate, readyBuildVerified } from './adopt.mjs';
export {
  DISPATCH_CWD_ROOT_ENV, SMOKE_LIVE_CLONE_ENV, candidateSmokeEnv, candidateWorktreePath, materializeCandidate,
  removeCandidate,
} from './candidate.mjs';
export { OVERLAY_EDGE_RESOLVE_ENV, REBUILD_IDENTITY_ENV } from './shared.mjs';
export {
  PINNED_OVERLAY_GONE_MESSAGE, PINNED_OVERLAY_MESSAGE, REBUILD_MECHANISM_PATHS, planRebuild,
} from './plan.mjs';
export {
  WE_DAEMON_STATE_DIR_ENV, isDaemonManagedClone, readReadyCandidate, readRebuildState, readyCandidatePath,
  rebuildStatePath,
} from './state.mjs';
export { defaultPrState, recordedEdgeSha } from './edge-fetch.mjs';
export { dryRunRebuild, previewOverlayConflict } from './preview.mjs';
export { resolveOverlayConflict } from './overlay-strategies.mjs';

// {@link daemonConveyorStateRoot} now lives in `../daemon-last-good.mjs` (import-light — see that file's own
// header) and is re-exported here UNCHANGED, so every existing importer of it from `daemon-rebuild.mjs`
// (`run-scorecard-store.mjs`, `local-state.mjs`'s own use) sees no change; `health-watch-section.mjs` imports it
// straight from `daemon-last-good.mjs` instead, so pulling in the health watch's state-root resolution never
// drags in the rebuild's much heavier build/smoke/child_process import graph (#4077 live regression: it broke
// the operator-queue CLI entry guard's symlink tests — see that fix's own commit).
export { daemonConveyorStateRoot } from '../daemon-last-good.mjs';
