/**
 * Build dispatch failure ledger with bounded exponential backoff (item 96).
 *
 * Before: a failing build card was re-dispatched every tick and left only an empty in-memory failure row. Now each
 * failure is persisted with its reason code and the child output, and the card is withheld until `retryAfter`.
 * After `maxAttempts` the card stays withheld (`exhausted`) until re-armed. Only observed delivery clears its record; a launch retains the retry history.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { readBackoffSettings, backoffVerdict, buildEvidenceReasonCode, isCloneWideReasonCode, CARD_REFUSAL_CODE, QUICK_RETRY_REASON_CODES } from './retry-backoff.mjs';
import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';

export const buildFailurePath = () => join(resolveCoordinationRoot(), 'build-dispatch-failures.json');
const OUTPUT_CAP = 2000;
// Attempt keys already charged to a card, newest last. Only the newest claim or settled row is ever re-recorded,
// so evicting the oldest keys never lets a live attempt charge again.
const ATTEMPT_KEY_CAP = 32;

function read(path) {
  if (!existsSync(path)) return { items: {} };
  try { const s = JSON.parse(readFileSync(path, 'utf8')); return s && typeof s.items === 'object' ? s : { items: {} }; }
  catch { return { items: {} }; }
}
function save(state, path) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  // Child output can echo credentials: owner-only, like any other file that may hold one.
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/**
 * One dispatch attempt's identity, shared by every path that charges it: the dispatch row's own `startedAt`. Orphan
 * adoption (keyed on the dead claim) and the fail-group pass (keyed on the settled row) can charge the SAME dispatch
 * in one tick; one key means one charge. Null when the row carries no start time — each path then falls back to a
 * key of its own.
 */
export const dispatchAttemptKey = (startedAt) => (typeof startedAt === 'string' && startedAt !== '' ? `dispatch:${startedAt}` : null);

/**
 * Record one failed build dispatch. `output` is the captured child output (falls back to `reason`). `attemptKey`
 * names the attempt (e.g. the dead claim): a repeat of any key already charged to the card charges nothing, so a step
 * that records before a release it may retry never charges one attempt twice — even when another path (orphan
 * adoption, fail-group) records its own attempt for the same card in between. Late-launch (quick-schedule) attempts are counted apart
 * from real failures: the history is retained across a confirmed launch, and lateness must not spend the card's
 * failure budget (PR #5453).
 */
export function recordBuildFailure({ num, reason, output, attemptKey }, { path = buildFailurePath(), now = Date.now(), settings = readBackoffSettings() } = {}) {
  const state = read(path);
  const key = String(num);
  const prev = state.items[key];
  // Every key charged so far, not only the last: interleaved paths must not erase each other's evidence. A record
  // written before the list existed carries one `attemptKey`.
  const chargedKeys = Array.isArray(prev?.attemptKeys) ? prev.attemptKeys : prev?.attemptKey != null ? [prev.attemptKey] : [];
  if (attemptKey != null && chargedKeys.includes(String(attemptKey))) return prev;
  // Redact BEFORE cutting: a cut taken first can slice a credential's recognisable prefix off and leave its tail
  // unredactable. The reason code is read off the raw text — redaction never changes what a code pattern matches.
  const rawText = String(output ?? reason ?? '').trim();
  const text = redactSpawnText(rawText);
  const reasonCode = buildEvidenceReasonCode({ reason: reason ?? rawText }) ?? (rawText ? 'dispatch-failed' : 'empty-failure-output');
  // builder-starved — a clone-wide refusal (the daemon's own clone is behind origin/main) is not the card's
  // failure: nothing is persisted, no attempt is charged, and the card is not withheld.
  if (isCloneWideReasonCode(reasonCode)) {
    return { num: key, attempts: prev?.attempts ?? 0, reasonCode, cloneWide: true, reason: redactSpawnText(reason ?? '').slice(0, 400),
      output: text.slice(0, OUTPUT_CAP), recordedAt: new Date(now).toISOString(), retryAfter: null, exhausted: false };
  }
  // A record written before the split carries one count: it belongs to its own code's schedule.
  const scheduleOf = (code) => (QUICK_RETRY_REASON_CODES.includes(code) ? 'quick' : 'failure');
  const counts = prev ? (prev.scheduleAttempts ?? { [scheduleOf(prev.reasonCode)]: prev.attempts ?? 0 }) : {};
  const schedule = scheduleOf(reasonCode);
  const attempts = (counts[schedule] ?? 0) + 1;
  const record = {
    num: key, attempts,
    scheduleAttempts: { ...counts, [schedule]: attempts },
    ...(attemptKey != null || chargedKeys.length
      ? { attemptKeys: (attemptKey != null ? [...chargedKeys, String(attemptKey)] : chargedKeys).slice(-ATTEMPT_KEY_CAP) } : {}),
    reasonCode,
    reason: redactSpawnText(reason ?? '').slice(0, 400),
    output: text.slice(0, OUTPUT_CAP),
    recordedAt: new Date(now).toISOString(),
    // A card-level refusal is permanent: it is withheld at once (exhausted), not re-tried on a cooldown.
    ...(reasonCode === CARD_REFUSAL_CODE ? { retryAfter: null, exhausted: true } : backoffVerdict({ attempts, now, settings, code: reasonCode })),
  };
  state.items[key] = record;
  save(state, path);
  return record;
}

export function clearBuildFailure(num, { path = buildFailurePath() } = {}) {
  const state = read(path);
  if (!state.items[String(num)]) return false;
  delete state.items[String(num)];
  save(state, path);
  return true;
}

/** Cards withheld from dispatch right now: inside their backoff window, or exhausted. */
export function listBuildBackoffs({ path = buildFailurePath(), now = Date.now() } = {}) {
  // builder-starved — a record written by older code for a clone-wide refusal never withholds the card (self-heal).
  return Object.values(read(path).items)
    .filter(r => !isCloneWideReasonCode(r.reasonCode))
    .filter(r => r.exhausted || (r.retryAfter && Date.parse(r.retryAfter) > now))
    .map(r => ({ num: r.num, reason: r.exhausted ? 'dispatch-backoff-exhausted' : 'dispatch-backoff', reasonCode: r.reasonCode,
      attempts: r.attempts, retryAfter: r.retryAfter ?? null }));
}

/** Operator/product re-arm: drop exhausted (or all) build failure records so the cards dispatch again. */
export function rearmBuildFailures({ path = buildFailurePath(), all = false, dryRun = false } = {}) {
  const state = read(path);
  const nums = Object.values(state.items).filter(r => all || r.exhausted).map(r => r.num);
  if (!dryRun && nums.length) { for (const n of nums) delete state.items[n]; save(state, path); }
  return { count: nums.length, nums };
}
