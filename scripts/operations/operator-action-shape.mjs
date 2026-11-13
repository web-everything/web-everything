/**
 * The exact shape of the `op: "refresh"` operator-action record and of the manual R247 pass note, as their producers write
 * them (operator-controls.mjs#planOperatorControl, manual-daemon-pass-io.mjs#createManualDaemonPassSinks). A LEAF module (no
 * imports): the accept carry-forward reader (scripts/lib/accept-carry-forward.mjs) must recognise these two notes by their
 * producer's fixed fields, never by free text, and cannot import the producers (operator-controls reaches review-set-label,
 * which imports the reader). The manual pass note is BUILT with `manualPassNote` below; the refresh record's shape is pinned
 * against the real `planOperatorControl('refresh', …)` output by a named test in accept-carry-forward.replay.test.mjs, so a
 * producer edit that drops or adds a key fails there instead of silently making real notes hold.
 */

/** Keys of a refresh record, exactly as `planOperatorControl('refresh', …)` writes them (a refresh target is always a PR). */
export const REFRESH_RECORD_KEYS = Object.freeze(['version', 'op', 'repo', 'pr', 'actor', 'channel', 'reason', 'at', 'key', 'details']);
/** Keys of `record.details` for a refresh: `undo` plus the refresh-only `previousHead`, `headRef`, `main`. */
export const REFRESH_DETAILS_KEYS = Object.freeze(['undo', 'previousHead', 'headRef', 'main']);
/** Bounds: `reason` is the operator's verbatim words (free text); every other field is a short machine value. */
export const OPERATOR_ACTION_REASON_MAX = 4000;
export const OPERATOR_ACTION_FIELD_MAX = 512;

const isScalar = (value, max) => (typeof value === 'string' && value.length <= max)
  || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
const hasExactKeys = (object, keys) => {
  const own = Object.keys(object);
  return own.length === keys.length && keys.every(key => Object.hasOwn(object, key));
};
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Pure: is this parsed marker exactly a refresh record (no extra key, no missing key, only bounded scalars)? */
export function isRefreshRecordShape(record) {
  if (!isPlainObject(record) || !hasExactKeys(record, REFRESH_RECORD_KEYS)) return false;
  if (record.version !== 1 || record.op !== 'refresh' || !Number.isSafeInteger(record.pr) || record.pr <= 0) return false;
  for (const key of REFRESH_RECORD_KEYS) {
    if (key === 'details') continue;
    if (!isScalar(record[key], key === 'reason' ? OPERATOR_ACTION_REASON_MAX : OPERATOR_ACTION_FIELD_MAX)) return false;
  }
  const { details } = record;
  return isPlainObject(details) && hasExactKeys(details, REFRESH_DETAILS_KEYS)
    && REFRESH_DETAILS_KEYS.every(key => isScalar(details[key], OPERATOR_ACTION_FIELD_MAX));
}

/**
 * The manual R247 pass note, exactly as the producer posts it. `reason` is validated by `validateManualPass` (nonempty, no
 * control/format characters); `sha` is the checkout HEAD (40-64 hex).
 */
export function manualPassNote({ daemon, reason, sha }) {
  return `Manual R247 pass — daemon: ${daemon}; reason: ${reason}; checkout sha: ${sha}.`;
}
/** The daemons a manual pass may target (manual-daemon-pass.mjs re-exports this as MANUAL_DAEMONS). */
export const MANUAL_PASS_DAEMONS = Object.freeze(['review', 'red-team', 'fix', 'verify']);
const MANUAL_PASS_NOTE_RE = new RegExp(`^Manual R247 pass — daemon: (${MANUAL_PASS_DAEMONS.join('|')}); reason: (\\S(?:[^\\p{Cc}\\p{Cf}]*\\S)?); checkout sha: ([a-fA-F0-9]{40,64})\\.$`, 'u');

/** Pure: is this whole body (trimmed) exactly the manual R247 pass note the producer writes? */
export function isManualPassNote(text) {
  if (typeof text !== 'string') return false;
  const m = MANUAL_PASS_NOTE_RE.exec(text);
  if (!m || m[2].length > OPERATOR_ACTION_REASON_MAX) return false;
  return manualPassNote({ daemon: m[1], reason: m[2], sha: m[3] }) === text;
}
