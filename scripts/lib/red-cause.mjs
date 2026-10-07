/**
 * @file scripts/lib/red-cause.mjs
 * @description Why a verify-lane gate was red (item 99). Pure: the marker had no cause field, so the coroner could
 * not split red runs into "my change broke it" vs "a flaky test outside my diff" vs "a guard / standards failure".
 *
 * `redCause` values:
 *   in-diff-failure        a vitest failure in a file the change touched (or no file could be named)
 *   out-of-diff-flaky      failing files outside the diff passed when re-run alone (the run itself went green)
 *   out-of-diff-still-red  failing files outside the diff, still red alone / not retried
 *   test-timeout           the failing tests timed out
 *   standards              the check:standards phase was red
 *   scan                   a repo-scanning or always-run guard phase was red
 *   killed-superseded      the gate process was killed by a signal (a newer request, daemon restart)
 *   refused                the gate was refused before it ran
 *   infra                  the verification infrastructure failed (dispatcher ceiling, no verdict)
 */
import { FLAKY_OUTSIDE_DIFF, STILL_RED_IN_ISOLATION } from './gate-timeout-retry.mjs';

export const RED_CAUSES = Object.freeze(['in-diff-failure', 'out-of-diff-flaky', 'out-of-diff-still-red', 'test-timeout',
  'standards', 'scan', 'killed-superseded', 'refused', 'infra']);

const TIMEOUT = /timed out in \d+\s*ms|Test timed out/i;
const filesOf = (details) => [...new Set((details?.tests ?? []).map(t => t.file))];

/**
 * @param {{exitCode?: number|null, signal?: string|null, infrastructure?: {reason?: string}|null,
 *   phaseResults?: {phase: string, result: {exitCode: number, signal?: string|null, failureDetails?: object}}[],
 *   isolatedRetry?: string|null, retriedFailures?: {file: string}[], changedFiles?: string[]|null, refused?: boolean}} a
 * @returns {{redCause: string, redCauseFiles: string[]}|null} null when nothing was red (and no flake was absorbed)
 */
export function classifyRedCause({ exitCode, signal, infrastructure, phaseResults = [], isolatedRetry, retriedFailures = [], changedFiles, refused } = {}) {
  const retried = (retriedFailures ?? []).map(f => f.file);
  if (refused) return { redCause: 'refused', redCauseFiles: [] };
  if (infrastructure) {
    const killed = infrastructure.reason === 'verify-signal';
    return { redCause: killed ? 'killed-superseded' : 'infra', redCauseFiles: [] };
  }
  const red = phaseResults.filter(p => p.result?.exitCode !== 0 || p.result?.signal);
  if (!red.length) {
    // The gate is green. A red test phase that passed alone is still worth recording: that is the flaky split.
    return exitCode === 0 && isolatedRetry === FLAKY_OUTSIDE_DIFF ? { redCause: 'out-of-diff-flaky', redCauseFiles: retried } : null;
  }
  if (exitCode === 0) return null;
  if (signal || red.some(p => p.result.signal)) return { redCause: 'killed-superseded', redCauseFiles: [] };
  const first = red[0];
  const files = [...new Set(red.flatMap(p => filesOf(p.result.failureDetails)))];
  if (first.phase === 'standards') return { redCause: 'standards', redCauseFiles: files };
  if (first.phase === 'scan') return { redCause: 'scan', redCauseFiles: files };
  const vitestFiles = filesOf(first.result.failureDetails);
  if (isolatedRetry === STILL_RED_IN_ISOLATION) return { redCause: 'out-of-diff-still-red', redCauseFiles: retried.length ? retried : vitestFiles };
  if (TIMEOUT.test(first.result.failureDetails?.summary ?? '')) return { redCause: 'test-timeout', redCauseFiles: vitestFiles };
  const changed = new Set(changedFiles ?? []);
  const outside = vitestFiles.length > 0 && Array.isArray(changedFiles) && vitestFiles.every(f => !changed.has(f));
  return { redCause: outside ? 'out-of-diff-still-red' : 'in-diff-failure', redCauseFiles: vitestFiles };
}
