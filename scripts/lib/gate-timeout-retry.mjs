import { isAbsolute, relative, normalize } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const MAX_TIMEOUT_LOG_BYTES = 2 * 1024 * 1024;

/** 75c — more failing files than this is not a flake; the gate stays red with no retry. */
export const MAX_ISOLATED_RETRY_FILES = 3;

export function isolatedRetryArgv(files, timeoutFlags = []) {
  return ['npx', 'vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism',
    ...timeoutFlags, ...files.map(f => `./${f}`)];
}

/** The marker label for a retry that passed alone: every failure was in an untouched file and went green in isolation. */
export const FLAKY_OUTSIDE_DIFF = 'flaky-outside-diff';
/** The marker label for a retry that still failed alone: the gate stays red. */
export const STILL_RED_IN_ISOLATION = 'still-red';

/**
 * 75c — which failing test files may be re-run once, alone, before the gate is declared red. Returns one
 * `{file, kind}` per file (`kind`: 'timeout' when every failure in the file was a Vitest timeout, else
 * 'killed' when every error explicitly identifies killed-child infrastructure, otherwise 'assertion'), or `[]` when no retry is allowed.
 *
 * A complete default-reporter inventory is required: not truncated, no suite/unhandled errors, and the counted
 * failures must match the summary lines and the collector's identities. EVERY failing file must be outside the
 * change's own edited set: an in-diff failure is never re-run away.
 *
 * `mode`: 'untouched' (any failure kind, at most `maxFiles` files), 'timeouts' (the pre-75c rule: only timeouts,
 * no file cap), 'off' (never).
 */
export function isolatedRetryFailures({ stdout = '', stderr = '', failureDetails, changedFiles, cwd, mode = 'untouched', maxFiles = MAX_ISOLATED_RETRY_FILES }) {
  if (mode !== 'untouched' && mode !== 'timeouts') return [];
  if (!failureDetails || failureDetails.truncated || !Array.isArray(failureDetails.tests) || !Array.isArray(changedFiles)
      || Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_TIMEOUT_LOG_BYTES) return [];
  const timeoutsOnly = mode === 'timeouts';
  const localPath = (file) => {
    const path = normalize(isAbsolute(file) ? relative(cwd, file) : file);
    return path === '..' || path.startsWith('../') || isAbsolute(path) ? null : path;
  };
  const edited = new Set(changedFiles.map(localPath));
  const failures = [];
  let current = [], summaries = 0, failedCount = 0, fileSummaries = 0, failedFiles = 0, duration = false;
  // Vitest prints failure blocks to stderr and totals to stdout. Keep each stream's own ordering.
  for (const raw of `${stderr}\n${stdout}`.split('\n')) {
    if (raw.length > 4096) return [];
    const line = stripVTControlCharacters(raw).trim();
    if (/Failed Suites|Unhandled Errors|Unhandled Rejection|Uncaught Exception|^Errors\s+\d+ errors/i.test(line)) return [];
    const summary = /^Tests\s+(\d+) failed\b/.exec(line);
    if (summary) { summaries++; failedCount = Number(summary[1]); current = []; }
    const files = /^Test Files\s+(\d+) failed\b/.exec(line);
    if (files) { fileSummaries++; failedFiles = Number(files[1]); current = []; }
    if (/^Duration\s+[\d.]+/.test(line)) duration = true;
    if (/^[⎯─]+\[\d+\/\d+\]/.test(line)) current = [];
    if (/^FAIL\s/.test(line)) {
      const match = /^FAIL\s+(?:\[[^\]]+\]\s+)?(.+?\.(?:[cm]?[jt]sx?))\s+>\s+(.+)$/.exec(line);
      if (!match) return [];
      const file = localPath(match[1]);
      if (!file || edited.has(file)) return [];
      // Vitest groups consecutive FAIL headers sharing one error body.
      if (current.some(f => f.errored)) current = [];
      const failure = { file, name: match[2], errored: false, timeout: false, other: false, killed: true };
      current.push(failure);
      failures.push(failure);
    } else if (current.length && /^(?:\w*Error|Caused by):/.test(line)) {
      const timeout = /^Error: Test timed out in \d+ms\./.test(line);
      if (!timeout && timeoutsOnly) return [];
      for (const failure of current) {
        failure.errored = true;
        failure.killed &&= isKilledFailureMessage(line);
        if (timeout) failure.timeout = true; else failure.other = true;
      }
    }
  }
  const files = [...new Set(failures.map(f => f.file))];
  if (summaries !== 1 || fileSummaries !== 1 || !duration || !failures.length
      || failures.length !== failedCount || files.length !== failedFiles
      || (timeoutsOnly && failures.some(f => !f.timeout))
      || (!timeoutsOnly && files.length > maxFiles)
      || failureDetails.tests.length !== failures.length
      || failures.some(f => !failureDetails.tests.some(t => localPath(t.file) === f.file && t.name === f.name))) return [];
  return files.map(file => ({
    file,
    kind: failures.filter(f => f.file === file).every(f => f.timeout && !f.other) ? 'timeout'
      : failures.filter(f => f.file === file).every(f => f.errored && f.killed) ? 'killed' : 'assertion',
  }));
}

/** The pre-75c contract (timeout-only failures in untouched files), kept for its callers and tests. */
export function timeoutRetryFiles(args) {
  return isolatedRetryFailures({ ...args, mode: 'timeouts', maxFiles: Infinity }).map(f => f.file);
}

export function describeTimeoutRetry(files) {
  return files?.length ? ` Retried once serially after timeout-only failures in untouched files: ${files.join(', ')}.` : '';
}

/**
 * One audit sentence for a marker / verdict / CLI result. Falls back to the pre-75c wording for an older
 * record that carries only `retriedTimeouts`.
 */
export function describeIsolatedRetry(record) {
  const failures = Array.isArray(record?.retriedFailures) ? record.retriedFailures : null;
  if (!failures?.length) return describeTimeoutRetry(record?.retriedTimeouts);
  const list = failures.map(f => `${f.file} (${f.kind})`).join(', ');
  const outcome = record.isolatedRetry === FLAKY_OUTSIDE_DIFF
    ? `each passed alone — recorded ${FLAKY_OUTSIDE_DIFF}; CI still runs the full suite`
    : 'still failed alone — red';
  const extra = record.infraKilledRetries ? ` Extra killed-child retries: ${record.infraKilledRetries}.` : '';
  return ` Retried once serially in isolation after failures only in untouched files: ${list}; ${outcome}.${extra}`;
}

/** The marker fields for one isolated retry (empty when none ran). */
export function isolatedRetryAudit(retriedFailures, isolatedRetry) {
  if (!retriedFailures?.length) return {};
  const retriedTimeouts = retriedFailures.filter(f => f.kind === 'timeout').map(f => f.file);
  return {
    retriedFailures,
    ...(isolatedRetry ? { isolatedRetry } : {}),
    // Back-compat: older readers know only `retriedTimeouts`.
    ...(retriedTimeouts.length ? { retriedTimeouts } : {}),
  };
}

/** Explicit infrastructure evidence only; a generic null-valued assertion is not child-process evidence. */
function isKilledFailureMessage(message) {
  return /^Error:\s*(?:child(?: process)?|subprocess)\s+(?:was\s+)?killed[.!]?$/i.test(message)
    || /\bETIMEDOUT\b/.test(message)
    || /\bsignal["']?\s*[:=]?\s*["']?SIG(?:KILL|TERM)\b/.test(message)
    || /\bchild\s+status["']?\s*[:=]?\s*(?:expected\s+)?null\b/i.test(message)
    || (/\b(?:ENOENT|ENOTDIR)\b/.test(message)
      && /(?:\/(?:private\/)?(?:tmp|var\/tmp)\/|\/(?:private\/)?var\/folders\/[^\s"']+\/T\/|[A-Z]:\\[^"'\n]*\\Temp\\)/i.test(message));
}

/** Bounded extra attempts after the first isolated run. IO stays injected so every run uses the caller's admission. */
export async function retryKilledFailures({ result, retriedFailures, maxRetries, classify, run, canRetry = () => true }) {
  const budget = Number.isSafeInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 3 ? maxRetries : 0;
  const authorized = new Set(retriedFailures.map(f => f.file));
  let infraKilledRetries = 0;
  while (true) {
    const passed = result.exitCode === 0 && !result.signal;
    if (passed) return { result, retriedFailures, infraKilledRetries, isolatedRetry: FLAKY_OUTSIDE_DIFF };
    const runnerKilled = !!result.signal || result.code === 'ETIMEDOUT' || result.error?.code === 'ETIMEDOUT';
    const observed = runnerKilled ? retriedFailures.map(f => ({ ...f, kind: 'killed' })) : classify(result);
    const complete = observed.length > 0 && observed.every(f => authorized.has(f.file));
    // Unknown/incomplete evidence must never retain a stale killed label from a previous attempt.
    retriedFailures = complete ? observed : retriedFailures.map(f => ({ ...f, kind: 'assertion' }));
    if (!complete || !retriedFailures.every(f => f.kind === 'killed') || infraKilledRetries >= budget || !canRetry()) {
      return { result, retriedFailures, infraKilledRetries, isolatedRetry: STILL_RED_IN_ISOLATION };
    }
    infraKilledRetries++;
    try { result = await run(); }
    catch (error) {
      if (!error.signal && error.code !== 'ETIMEDOUT') throw error;
      result = { exitCode: null, signal: error.signal, code: error.code };
    }
  }
}
