/**
 * @file scripts/lib/test-cache-shadow.mjs
 * @description prepare-124 S2 — the pure shadow-mode decisions. Nothing is skipped: the cache only records what it
 * WOULD have skipped, next to what actually happened.
 *
 *   wouldSkip  = the file is cacheable, not quarantined, and the store already holds a PASS for its key.
 *   false-skip = wouldSkip was true but this run was not the same full pass: it failed (assertion), timed out,
 *                crashed, or ran a different number of tests. A false-skip quarantines the file.
 *   store      = only a full pass, from a whole-file run (no -t filter, no shard, no `.only`, no run-level error).
 */

const TIMEOUT_RE = /timed out|timeout of \d+\s*ms|hook timed out/i;

function collectTests(tasks, out = []) {
  for (const t of tasks ?? []) {
    if (t.type === 'test' || t.type === 'custom') out.push(t);
    else if (t.tasks) collectTests(t.tasks, out);
  }
  return out;
}

const hasOnly = (tasks) => (tasks ?? []).some((t) => t.mode === 'only' || hasOnly(t.tasks));

/**
 * Summarise one vitest `File` task (shape tolerant: a missing field reads as 0 / unknown).
 * @returns {{state: 'pass'|'fail'|'skip', passed: number, failed: number, skipped: number, total: number,
 *   durationMs: number, hasOnly: boolean, errors: string[]}}
 */
export function summarizeFile(file) {
  const tests = collectTests(file?.tasks);
  let passed = 0, failed = 0, skipped = 0;
  const errors = [];
  for (const t of tests) {
    const s = t.result?.state;
    if (s === 'fail') failed += 1;
    else if (s === 'pass') passed += 1;
    else skipped += 1;
    for (const e of t.result?.errors ?? []) errors.push(String(e?.message ?? e));
  }
  for (const e of file?.result?.errors ?? []) errors.push(String(e?.message ?? e));
  const fileState = file?.result?.state;
  const state = fileState === 'fail' || failed > 0 || errors.length > 0 ? 'fail' : fileState === 'pass' ? 'pass' : 'skip';
  return { state, passed, failed, skipped, total: tests.length, durationMs: Math.round(file?.result?.duration ?? 0), hasOnly: hasOnly(file?.tasks), errors: errors.slice(0, 5) };
}

/** A full pass: every collected test passed or was skipped on purpose, nothing failed, and at least one test ran. */
export const isFullPass = (s) => s.state === 'pass' && s.failed === 0 && s.passed > 0;

/** Why a would-skip file was a false-skip, or null when this run matches the stored pass. */
export function falseSkipCategory(summary, stored) {
  if (isFullPass(summary)) {
    return stored && (summary.passed !== stored.passed || summary.skipped !== stored.skipped) ? 'count-changed' : null;
  }
  const text = summary.errors.join('\n');
  if (TIMEOUT_RE.test(text)) return 'timeout';
  if (summary.failed > 0) return 'assertion';
  return 'crash';
}

/**
 * Decide the shadow record for one file.
 * @param {{row: {file: string, key: string|null, cacheable: boolean, tier: string, reason: string|null},
 *   summary: ReturnType<typeof summarizeFile>, stored: object|null, quarantined: boolean,
 *   run: {runId: string, lane: string, baseSha: string|null, storeAllowed: boolean, now?: string}}} a
 * @returns {{record: object, store: object|null, quarantine: {category: string}|null}}
 */
export function decideShadow({ row, summary, stored, quarantined, run }) {
  let reason;
  if (!row.cacheable) reason = `not-cacheable: ${row.reason ?? 'unknown'}`;
  else if (quarantined) reason = 'quarantined';
  else if (!stored || stored.outcome !== 'pass') reason = 'no-entry';
  else reason = 'hit';
  const wouldSkip = reason === 'hit';
  const category = wouldSkip ? falseSkipCategory(summary, stored) : null;
  const now = run.now ?? new Date().toISOString();
  const record = {
    runId: run.runId, lane: run.lane, baseSha: run.baseSha, file: row.file, key: row.key, tier: row.tier,
    wouldSkip, reason, outcome: summary.state, falseSkip: category,
    tests: { passed: summary.passed, failed: summary.failed, skipped: summary.skipped },
    durationMs: summary.durationMs, storedDurationMs: wouldSkip ? stored.durationMs ?? null : null,
  };
  const canStore = run.storeAllowed && row.cacheable && !quarantined && !summary.hasOnly && isFullPass(summary) && !category;
  const store = canStore
    ? { file: row.file, outcome: 'pass', passed: summary.passed, skipped: summary.skipped, durationMs: summary.durationMs, recordedAt: now, lane: run.lane, baseSha: run.baseSha }
    : null;
  return { record, store, quarantine: category ? { category } : null };
}

/** Run-level gate for writing the store: a filtered, sharded or errored run records nothing. */
export function storeAllowedForRun({ testNamePattern, shard, runErrors = [], watch = false } = {}) {
  return !testNamePattern && !shard && !watch && runErrors.length === 0;
}
