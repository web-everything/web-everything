/** Evidence-based prepare failures. Time alone never releases an item or a route. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { readBackoffSettings, backoffVerdict, reasonCodeOf } from './retry-backoff.mjs';

export const INFRA_RETRY_BUDGET = 2;
export function classifyPrepareFailure(evidence = {}) {
  // Match observed error output, never the prompt (which can mention hypothetical failures).
  const error = String(evidence.error ?? evidence.reason ?? '');
  if (/\bHTTP\s+429\b|\b429 Too Many Requests\b|rate.limit(?: exceeded| reached)|ECONNRESET|ENETUNREACH|EAI_AGAIN|network (?:error|unavailable)/i.test(error)) return 'infra-transient';
  if (evidence.sessionAbsent === true) return 'no-session';
  if (evidence.resultDiscarded === true && evidence.resultAuthored === true) return 'result-lost';
  if (evidence.stoppedBeforeCompletion === true) return 'agent-stopped-early';
  // Items 95/96: a known-transient dispatch failure (launch not confirmed, checkout behind origin, ...) is retried
  // with bounded backoff instead of held forever. Unrecognised text stays `unknown` (held + a diagnose card).
  if (reasonCodeOf(error)) return 'dispatch-transient';
  return 'unknown';
}
export function validatePrepareRelease(entry, verifyCommit) {
  if (!entry?.target || !entry?.attempt || !entry?.cause || !['agent-stopped-early', 'no-session', 'result-lost', 'infra-transient'].includes(entry.cause)
      || !entry.evidence || !/^[a-f0-9]{40}$/.test(entry.fixCommit ?? '')) {
    throw new Error('prepare release refused: target, exact attempt, known cause, evidence and full fix commit required');
  }
  if (!verifyCommit(entry.fixCommit)) throw new Error('prepare release refused: fix commit is not an ancestor of this daemon');
  return entry;
}
/** An entry that fails validation (malformed, or its fix commit is not in this daemon's ancestry — a shallow
 * clone, a stale HEAD) is simply NOT a release: the item stays held. It must never throw, because this runs at
 * the top of every build-dispatch tick and one bad entry would halt all daemon work. */
export function readPrepareReleases(path, root, { onInvalid = () => {} } = {}) {
  let entries;
  try { entries = JSON.parse(readFileSync(path, 'utf8')).releases; } catch (error) { onInvalid(null, error); return []; }
  if (!Array.isArray(entries)) return [];
  const releases = [];
  for (const entry of entries) {
    try {
      releases.push(validatePrepareRelease(entry, sha => {
        try { execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, stdio: 'ignore' }); return true; }
        catch { return false; }
      }));
    } catch (error) { onInvalid(entry, error); }
  }
  return releases;
}
export function releasedAttempt(releases, target, attempt) {
  return releases.some(r => r.target === String(target) && r.attempt === attempt);
}
export const failureStatePath = () => join(resolveCoordinationRoot(), 'prepare-failures.json');
export function readFailureState(path = failureStatePath()) {
  if (!existsSync(path)) return { failures: {}, cards: {} };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch {
    // A truncated ledger must not throw out of every daemon tick; keep the bytes for diagnosis and start empty.
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return { failures: {}, cards: {} };
  }
}
function save(state, path) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  renameSync(temp, path);
}
/** Singleton daemon owns this ledger. Persist intent before spawning so a crash cannot double-file. */
export async function recordPrepareFailure({ num, attempt, stage, evidence = {} }, {
  path = failureStatePath(), fileCard, now = Date.now(), settings = readBackoffSettings(),
} = {}) {
  const state = readFailureState(path);
  const key = `${num}:${attempt}:${stage}`;
  if (state.failures[key]) return state.failures[key];
  const cause = classifyPrepareFailure(evidence);
  const previous = Object.values(state.failures).filter(f => f.num === num && f.cause === 'infra-transient').length;
  const retry = cause === 'infra-transient' && previous < INFRA_RETRY_BUDGET;
  const failure = { num, attempt, stage, cause, evidence, retry, held: !retry, recordedAt: new Date(now).toISOString() };
  if (cause === 'dispatch-transient') {
    // Backoff: held until `retryAfter`, then `releaseDuePrepareRetries` lets it be dispatched again. Attempts
    // count every unfinished transient failure of this card; at the cap it stays held (`exhausted`) for a re-arm.
    const attempts = Object.values(state.failures).filter(f => f.num === num && f.cause === 'dispatch-transient' && !f.completed).length + 1;
    Object.assign(failure, { reasonCode: reasonCodeOf(evidence.reason ?? evidence.error), attempts, ...backoffVerdict({ attempts, now, settings }) });
  }
  state.failures[key] = failure;
  if (cause === 'unknown') {
    const signature = evidence.causeKey || `${stage}:${String(evidence.terminal ?? evidence.error ?? evidence.reason ?? 'missing terminal evidence').replace(/#?\d+/g, 'N')}`;
    const fingerprint = createHash('sha256').update(signature).digest('hex').slice(0, 16);
    failure.causeKey = fingerprint;
    if (!state.cards[fingerprint]) {
      state.cards[fingerprint] = { status: 'pending', num, signature };
      save(state, path);
      try {
        const result = await fileCard({ title: `Diagnose unknown prepare ${stage} failure (${fingerprint})`,
          kind: 'task', size: '2', queue: 'false', scope: 'we:skills-src/conveyor/build-dispatch-daemon.mjs',
          digest: `Prepare #${num} is held. Cause is unknown. Evidence is retained in the coordination-root prepare failure ledger under cause key ${fingerprint} and item ${num}; inspect the recorded terminal output before making a diagnosis. Recover the terminal evidence, fix the cause and add a regression. Release requires a reviewed fix commit. Cause key: ${fingerprint}.` });
        state.cards[fingerprint] = { ...state.cards[fingerprint], status: result?.ok ? 'queued' : 'failed', result };
      } catch (error) { state.cards[fingerprint].status = 'failed'; state.cards[fingerprint].error = String(error); }
    }
    failure.prevention = state.cards[fingerprint];
  }
  save(state, path);
  return failure;
}

/** Successful main observation closes failures, preserving their audit history. */
export function completePrepareFailures(num, path = failureStatePath()) {
  const state = readFailureState(path);
  for (const failure of Object.values(state.failures)) if (failure.num === num) failure.completed = true;
  save(state, path);
}

/** Held transient failures whose backoff has elapsed become retryable again. Returns the card numbers that now have
 * NO remaining held failure (their hold files can be released). Exhausted failures are never released here. */
export function releaseDuePrepareRetries({ path = failureStatePath(), now = Date.now() } = {}) {
  const state = readFailureState(path);
  const touched = new Set();
  for (const f of Object.values(state.failures)) {
    if (f.held && !f.completed && !f.exhausted && f.retryAfter && Date.parse(f.retryAfter) <= now) {
      Object.assign(f, { held: false, retry: true, retriedAt: new Date(now).toISOString() });
      touched.add(f.num);
    }
  }
  if (!touched.size) return [];
  save(state, path);
  return [...touched].filter(num => !Object.values(state.failures).some(f => f.num === num && f.held && !f.completed));
}

/** The pre-#4148 launch-confirmation bug recorded healthy launches as "not confirmed" and held the card for good. */
export const NOT_CONFIRMED_FIX_LANDED_AT = '2026-10-07T00:25:38Z'; // merge of #4148 (2026-10-06 20:25 ET)

/** One-shot re-arm: clear held failures whose reason code is in `codes` and which were recorded before `before`
 * (`recordedAt`, else an ISO `attempt`, else unknown = written by older code = before). Returns the re-armed numbers. */
export function rearmFalseHolds({ path = failureStatePath(), before = NOT_CONFIRMED_FIX_LANDED_AT, codes = ['launch-not-confirmed'], now = Date.now(), dryRun = false } = {}) {
  const state = readFailureState(path);
  const cutoff = Date.parse(before);
  const rearmed = [];
  for (const f of Object.values(state.failures)) {
    if (!f.held || f.completed) continue;
    if (!codes.includes(reasonCodeOf(f.evidence?.reason ?? f.evidence?.error))) continue;
    const at = Date.parse(f.recordedAt ?? f.attempt);
    if (Number.isFinite(at) && at >= cutoff) continue;
    rearmed.push(f);
  }
  if (!dryRun && rearmed.length) {
    for (const f of rearmed) Object.assign(f, { held: false, retry: true, rearmedAt: new Date(now).toISOString(), rearmedBefore: before });
    save(state, path);
  }
  return { count: rearmed.length, nums: [...new Set(rearmed.map(f => f.num))] };
}
