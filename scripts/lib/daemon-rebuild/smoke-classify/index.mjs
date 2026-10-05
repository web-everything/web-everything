/** @file scripts/lib/daemon-rebuild/smoke-classify/index.mjs — the smoke-failure classifiers, one per file.
 * Split out of daemon-rebuild.mjs (move-only). The verdict classifiers run from ONE ordered array; the row-level
 * classifiers (load-shaped, busy-pool) are called at their existing points in the smoke-and-adopt ladder.
 */

import { authBroken } from './auth-broken.mjs';
import { envTimeout } from './env-timeout.mjs';
import { transient } from './transient.mjs';

/** Ordered: first match wins; each is an ENVIRONMENT fault — no reject record,
 *  no fallback/control smokes, hold on last-good. `transient` matches every non-`code` verdict, so it is last. */
export const SMOKE_ENVIRONMENT_VERDICTS = Object.freeze([authBroken, envTimeout, transient]);

export {
  SMOKE_LOAD_DIFFERENTIAL_ENV, ENV_LOAD_RETRY_BASE_ENV, ENV_LOAD_RETRY_MAX_ENV, DEFAULT_ENV_LOAD_RETRY_BASE_MS,
  DEFAULT_ENV_LOAD_RETRY_MAX_MS, LOAD_CONTENTION_SIGNATURES, loadDifferentialEnabled, envLoadRetryDelayMs,
  isLoadShapedRow,
} from './load-shaped.mjs';
export { busyPoolSkippedChecks } from './busy-pool.mjs';
export { redactDetail } from './redact-detail.mjs';
