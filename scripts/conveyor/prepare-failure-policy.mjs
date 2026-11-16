/** Evidence-based prepare failures. Time alone never releases an item or a route. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const INFRA_RETRY_BUDGET = 2;
export function classifyPrepareFailure(evidence = {}) {
  // Match observed error output, never the prompt (which can mention hypothetical failures).
  const error = String(evidence.error ?? evidence.reason ?? '');
  if (/\bHTTP\s+429\b|\b429 Too Many Requests\b|rate.limit(?: exceeded| reached)|ECONNRESET|ENETUNREACH|EAI_AGAIN|network (?:error|unavailable)/i.test(error)) return 'infra-transient';
  if (evidence.sessionAbsent === true) return 'no-session';
  if (evidence.resultDiscarded === true && evidence.resultAuthored === true) return 'result-lost';
  if (evidence.stoppedBeforeCompletion === true) return 'agent-stopped-early';
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
export function readPrepareReleases(path, root) {
  const entries = JSON.parse(readFileSync(path, 'utf8')).releases;
  return entries.map(entry => validatePrepareRelease(entry, sha => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, stdio: 'ignore' }); return true; }
    catch { return false; }
  }));
}
export function releasedAttempt(releases, target, attempt) {
  return releases.some(r => r.target === String(target) && r.attempt === attempt);
}
export const failureStatePath = () => join(resolveCoordinationRoot(), 'prepare-failures.json');
export function readFailureState(path = failureStatePath()) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { failures: {}, cards: {} };
}
function save(state, path) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  renameSync(temp, path);
}
/** Singleton daemon owns this ledger. Persist intent before spawning so a crash cannot double-file. */
export async function recordPrepareFailure({ num, attempt, stage, evidence = {} }, {
  path = failureStatePath(), fileCard,
} = {}) {
  const state = readFailureState(path);
  const key = `${num}:${attempt}:${stage}`;
  if (state.failures[key]) return state.failures[key];
  const cause = classifyPrepareFailure(evidence);
  const previous = Object.values(state.failures).filter(f => f.num === num && f.cause === 'infra-transient').length;
  const retry = cause === 'infra-transient' && previous < INFRA_RETRY_BUDGET;
  const failure = { num, attempt, stage, cause, evidence, retry, held: !retry };
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
