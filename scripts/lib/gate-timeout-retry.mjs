import { isAbsolute, relative, normalize } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { hostname, loadavg } from 'node:os';
import { join } from 'node:path';
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
export const FLAKY_RETRIED_GREEN = 'flaky-retried-green';
export const STILL_RED_IN_ISOLATION = 'still-red';

/**
 * 75c — which failing test files may be re-run once, alone, before the gate is declared red. Returns one
 * `{file, kind}` per file (`kind`: 'timeout' when every failure in the file was a Vitest timeout, else
 * 'assertion'), or `[]` when no retry is allowed.
 *
 * A complete default-reporter inventory is required: not truncated, no suite/unhandled errors, and the counted
 * failures must match the summary lines and the collector's identities. EVERY failing file must be outside the
 * change's own edited set in legacy modes. 'all' also allows edited files; each still has to pass on this SHA.
 *
 * `mode`: 'untouched' (any failure kind, at most `maxFiles` files), 'timeouts' (the pre-75c rule: only timeouts,
 * no file cap), 'all' (any failure, including edited files, at most maxFiles), 'off' (never).
 */
export function isolatedRetryFailures({ stdout = '', stderr = '', failureDetails, changedFiles, cwd, mode = 'untouched', maxFiles = MAX_ISOLATED_RETRY_FILES }) {
  if (mode !== 'all' && mode !== 'untouched' && mode !== 'timeouts') return [];
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
      if (!file || (mode !== 'all' && edited.has(file))) return [];
      // Vitest groups consecutive FAIL headers sharing one error body.
      if (current.some(f => f.errored)) current = [];
      const failure = { file, name: match[2], errored: false, timeout: false, other: false };
      current.push(failure);
      failures.push(failure);
    } else if (current.length && /^(?:\w*Error|Caused by):/.test(line)) {
      const timeout = /^Error: Test timed out in \d+ms\./.test(line);
      if (!timeout && timeoutsOnly) return [];
      for (const failure of current) {
        failure.errored = true;
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
    kind: failures.filter(f => f.file === file).every(f => f.timeout && !f.other) ? 'timeout' : 'assertion',
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
  if (record.isolatedRetry === FLAKY_RETRIED_GREEN) return ` Retried serially in isolation: ${list}; green-with-flakes (${FLAKY_RETRIED_GREEN}); CI still runs the full suite.`;
  if (failures.some(f => f.phase)) return ` Retried serially in isolation after failures: ${list}; still failed alone — red.`;
  const outcome = record.isolatedRetry === FLAKY_OUTSIDE_DIFF
    ? `each passed alone — recorded ${FLAKY_OUTSIDE_DIFF}; CI still runs the full suite`
    : 'still failed alone — red';
  return ` Retried once serially in isolation after failures only in untouched files: ${list}; ${outcome}.`;
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

/** Best effort host flake telemetry; even root resolution and serialization failures are advisory. */
export function appendTestFlake(entry, { root, append = appendFileSync, mkdir = mkdirSync } = {}) {
  try {
    const dir = join(typeof root === 'function' ? root() : root, '.operations');
    mkdir(dir, { recursive: true });
    append(join(dir, 'test-flakes.jsonl'), `${JSON.stringify({ ...entry, host: hostname(), load: Math.round(loadavg()[0] * 100) / 100, at: new Date().toISOString() })}\n`);
    return true;
  } catch { return false; }
}

/** Require the original failing assertions to PASS, not disappear through skip/config/filter changes. */
export function retryPassedFiles(reportText, failures, cwd) {
  try {
    const report = JSON.parse(reportText);
    if (!Array.isArray(report.testResults)) return [];
    return failures.filter(f => report.testResults.some(r => normalize(relative(cwd, r.name)) === f.file
      && r.status === 'passed' && Array.isArray(r.assertionResults)
      && f.names.every(name => r.assertionResults.some(a => (Array.isArray(a.ancestorTitles) && typeof a.title === 'string'
        ? [...a.ancestorTitles.filter(Boolean), a.title].join(' > ') === name : a.fullName === name) && a.status === 'passed'))));
  } catch { return []; }
}

/** Complete bounded evidence only. Each attempt runs just the remaining red files under the caller's admission. */
export async function retryFailedPhase({ result, attempts, cwd, run, infrastructureFailure, onFlake = () => {} }) {
  const flakes = [], retried = [];
  const requiredNames = new Map();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (result.exitCode === 0 || result.signal || result.timedOut || infrastructureFailure(result) || !result.output) break;
    const files = isolatedRetryFailures({ ...result.output, failureDetails: result.failureDetails, mode: 'all', changedFiles: [], cwd });
    if (!files.length) break;
    for (const f of files) if (!retried.some(r => r.file === f.file)) retried.push(f);
    const initial = result;
    const named = files.map(f => {
      const names = requiredNames.get(f.file) ?? new Set();
      for (const t of initial.failureDetails.tests) {
        if (normalize(isAbsolute(t.file) ? relative(cwd, t.file) : t.file) === f.file) names.add(t.name);
      }
      requiredNames.set(f.file, names);
      return { ...f, names: [...names] };
    });
    result = await run(files.map(f => f.file), attempt + 1);
    if (result.signal || result.timedOut || infrastructureFailure(result)) break;
    const passed = retryPassedFiles(result.retryReportText, named, cwd);
    // A nominal green without positive execution evidence keeps the original red (and stops retrying).
    if (result.exitCode === 0 && passed.length !== files.length) return { result: initial, retried, flakes };
    for (const f of passed) {
      if (!flakes.some(p => p.file === f.file)) {
        flakes.push({ file: f.file });
        onFlake({ file: f.file, test: f.names.length === 1 ? f.names[0] : null });
      }
    }
    // A red attempt must account for every file that did not demonstrably pass.
    if (result.exitCode !== 0) {
      const remaining = isolatedRetryFailures({ ...result.output, failureDetails: result.failureDetails, mode: 'all', changedFiles: [], cwd });
      const escapedScope = remaining.some(r => !files.some(f => f.file === r.file) || passed.some(p => p.file === r.file));
      const unaccounted = files.some(f => !passed.some(p => p.file === f.file) && !remaining.some(r => r.file === f.file));
      if (!remaining.length || escapedScope || unaccounted) break;
    }
  }
  return { result, retried, flakes };
}

/** Keep scan diagnostics useful even for commands that did not produce Vitest failure identities. */
export function scanFailureDiagnostic(result, label) {
  const clean = text => stripVTControlCharacters(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  const test = result.failureDetails?.tests?.[0];
  const lines = `${result.output?.stderr ?? ''}\n${result.output?.stdout ?? ''}\n${result.failureDetails?.summary ?? ''}`.split('\n').map(clean).filter(Boolean);
  const firstError = lines.find(l => /(?:\w*Error:|error|failed|FAIL)/i.test(l) && !/^FAIL\s/.test(l)) ?? lines[0] ?? `exit ${result.exitCode}`;
  return `FAIL ${clean(test ? `${test.file}${test.name ? ` > ${test.name}` : ''}` : label)}: ${firstError}\n`;
}
