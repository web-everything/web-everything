/**
 * Build dispatch failure ledger with bounded exponential backoff (item 96).
 *
 * Before: a failing build card was re-dispatched every tick and left only an empty in-memory failure row. Now each
 * failure is persisted with its reason code and the child output, and the card is withheld until `retryAfter`.
 * After `maxAttempts` the card stays withheld (`exhausted`) until re-armed. A dispatched build clears its record.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { readBackoffSettings, backoffVerdict, evidenceReasonCode, isCloneWideReasonCode } from './retry-backoff.mjs';
import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';

export const buildFailurePath = () => join(resolveCoordinationRoot(), 'build-dispatch-failures.json');
const OUTPUT_CAP = 2000;

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

/** Record one failed build dispatch. `output` is the captured child output (falls back to `reason`). */
export function recordBuildFailure({ num, reason, output }, { path = buildFailurePath(), now = Date.now(), settings = readBackoffSettings() } = {}) {
  const state = read(path);
  const key = String(num);
  const attempts = (state.items[key]?.attempts ?? 0) + 1;
  // Redact BEFORE cutting: a cut taken first can slice a credential's recognisable prefix off and leave its tail
  // unredactable. The reason code is read off the raw text — redaction never changes what a code pattern matches.
  const rawText = String(output ?? reason ?? '').trim();
  const text = redactSpawnText(rawText);
  const reasonCode = evidenceReasonCode({ reason: reason ?? rawText }) ?? (rawText ? 'dispatch-failed' : 'empty-failure-output');
  // builder-starved — a clone-wide refusal (the daemon's own clone is behind origin/main) is not the card's
  // failure: nothing is persisted, no attempt is charged, and the card is not withheld.
  if (isCloneWideReasonCode(reasonCode)) {
    return { num: key, attempts: state.items[key]?.attempts ?? 0, reasonCode, cloneWide: true, reason: redactSpawnText(reason ?? '').slice(0, 400),
      output: text.slice(0, OUTPUT_CAP), recordedAt: new Date(now).toISOString(), retryAfter: null, exhausted: false };
  }
  const record = {
    num: key, attempts,
    reasonCode,
    reason: redactSpawnText(reason ?? '').slice(0, 400),
    output: text.slice(0, OUTPUT_CAP),
    recordedAt: new Date(now).toISOString(),
    ...backoffVerdict({ attempts, now, settings }),
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
