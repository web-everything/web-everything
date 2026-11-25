/**
 * Generic blue-green handover helpers; the host gate uses the setting and exit codes
 * (BLUE-GREEN-SWAP S1.1; FLOW-DMN-026/029/045/049/050). Pure functions only.
 *
 * Exit codes a daemon uses toward the host gate when swap is enabled:
 *   EX_RELOAD (76)      blue has exited and requests a successor (green).
 *   EX_HANDED_OVER (77) blue has exited; the gate may promote a validated green.
 * A running blue requests a successor through IPC {type: 'reload'}.
 */
export const EX_RELOAD = 76;
export const EX_HANDED_OVER = 77;
/** Dropped greens per active generation (reset on promotion; no digest tracking) before the gate asks for the operator. */
export const MAX_GREEN_DROPS = 3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Setting `daemons.blueGreenSwap.<daemon>`; absent or anything but on/true is off (closed default, FLOW-DMN-022). */
export function swapEnabled(prefs, daemon) {
  const section = prefs?.daemons?.blueGreenSwap;
  if (!isObj(section) || !daemon) return false;
  const v = section[daemon];
  return v === true || v === 'on';
}

// S1.3/S1.4 will wire validateReadyRecord, probationVerdict and switchPauseMs into production handover.

/** Ready record schema written by a green daemon. Returns {ok, reason}. A missing field refuses. */
export function validateReadyRecord(rec, { gen, codeDigest, pid } = {}) {
  if (!isObj(rec)) return { ok: false, reason: 'missing' };
  if (!Number.isSafeInteger(rec.gen)) return { ok: false, reason: 'gen' };
  if (typeof rec.codeDigest !== 'string' || !rec.codeDigest) return { ok: false, reason: 'codeDigest' };
  if (!Number.isSafeInteger(rec.pid) || rec.pid <= 0) return { ok: false, reason: 'pid' };
  if (rec.smoke !== 'ok') return { ok: false, reason: 'smoke' };
  if (gen !== undefined && rec.gen !== gen) return { ok: false, reason: 'gen-mismatch' };
  if (codeDigest !== undefined && rec.codeDigest !== codeDigest) return { ok: false, reason: 'digest-mismatch' };
  if (pid !== undefined && rec.pid !== pid) return { ok: false, reason: 'foreign-pid' };
  return { ok: true, reason: 'ok' };
}

/**
 * Probation verdict (J4): promote after a clean pass inside the window, roll back on a failed pass or silence.
 * `now` is a number (ms). Missing data never promotes.
 */
export function probationVerdict({ startedAt, now, passExitCodes = [], lastHeartbeatAt, staleAfterMs, probationMs }) {
  if (![startedAt, now, staleAfterMs, probationMs].every(Number.isFinite)) return 'rollback';
  if (!Array.isArray(passExitCodes) || Array.from(passExitCodes).some((c) => c !== 0)) return 'rollback';
  if (now - startedAt >= probationMs) return 'rollback';
  if (!Number.isFinite(lastHeartbeatAt) || lastHeartbeatAt > now || now - lastHeartbeatAt > staleAfterMs) return 'rollback';
  if (passExitCodes.length > 0 && now - startedAt >= 0) return 'promote';
  return 'wait';
}

/** Switch pause: handover instant to green's first pass start. null when either end is unknown or reversed. */
export function switchPauseMs(handoverAt, firstPassStartedAt) {
  if (!Number.isFinite(handoverAt) || !Number.isFinite(firstPassStartedAt)) return null;
  const d = firstPassStartedAt - handoverAt;
  return d >= 0 ? d : null;
}
