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
import { posix } from 'node:path';
import { FLAKY_OUTSIDE_DIFF, STILL_RED_IN_ISOLATION } from './gate-timeout-retry.mjs';

export const RED_CAUSES = Object.freeze(['in-diff-failure', 'out-of-diff-flaky', 'out-of-diff-still-red', 'test-timeout',
  'standards', 'scan', 'killed-superseded', 'refused', 'infra']);

const TIMEOUT = /timed out in \d+\s*ms|Test timed out/i;
const filesOf = (details) => [...new Set((details?.tests ?? []).map(t => t.file))];

// A relative module specifier: `from './x'`, `import './x'`, and any call taking one as its first argument —
// `import('./x')`, `require('./x')`, `vi.mock('./x')`, `vi.importActual('./x')`. Each `\s*` is preceded by a distinct
// literal, so matching is linear (no adjacent quantifiers); the text is also capped per file.
const RELATIVE_SPECIFIER = /(?:\bfrom|\bimport|\()\s*(['"])(\.{1,2}\/[^'"\n]*)\1/g;
const MAX_SOURCE_CHARS = 200_000;
const RESOLVE_SUFFIXES = ['', '.mjs', '.js', '.ts', '.cjs', '.mts', '.jsx', '.tsx', '/index.mjs', '/index.js', '/index.ts'];
// `./foo.js` is often written for a `foo.ts` on disk (TS ESM convention).
const TS_TWINS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.jsx': ['.tsx'] };

/**
 * Does `testFile` import (directly or through other repo files, up to `maxDepth` hops) one of the `changedFiles`?
 * That is what makes a failure in an UNEDITED test the change's own regression: a source-only edit breaks the test
 * that imports it, and the test file itself is not in the diff. Pure over the injected `readFile` (repo-relative path →
 * text, throws when absent); a cycle or an unreadable file ends that branch. False when the diff is unknown. When the
 * walk is cut short by `maxDepth` / `maxFiles` the answer is TRUE: the test is deep in the diff's import graph, and
 * "unknown" must not be read as "outside the diff".
 * @param {{testFile: string, changedFiles: string[]|null|undefined, readFile: (path: string) => string, maxDepth?: number, maxFiles?: number}} a
 */
export function testReachesChanged({ testFile, changedFiles, readFile, maxDepth = 4, maxFiles = 300 }) {
  if (!Array.isArray(changedFiles) || !changedFiles.length || typeof readFile !== 'function') return false;
  const changed = new Set(changedFiles.map(f => posix.normalize(f)));
  if (changed.has(posix.normalize(testFile))) return true;
  const seen = new Set([posix.normalize(testFile)]);
  let frontier = [posix.normalize(testFile)];
  let reads = 0;
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const file of frontier) {
      let text;
      try { text = String(readFile(file)).slice(0, MAX_SOURCE_CHARS); } catch { continue; }
      if (++reads > maxFiles) return true;
      for (const [, , specifier] of text.matchAll(RELATIVE_SPECIFIER)) {
        const base = posix.normalize(posix.join(posix.dirname(file), specifier));
        const ext = Object.keys(TS_TWINS).find(e => base.endsWith(e));
        const candidates = [...RESOLVE_SUFFIXES.map(s => base + s), ...(ext ? TS_TWINS[ext].map(t => base.slice(0, -ext.length) + t) : [])];
        for (const candidate of candidates) {
          if (changed.has(candidate)) return true;
          if (!seen.has(candidate)) { seen.add(candidate); next.push(candidate); }
        }
      }
    }
    frontier = next;
  }
  // Frontier files still unread when the depth cap hit (only those that exist count): unknown → treat as reaching.
  return frontier.some((file) => { try { readFile(file); return true; } catch { return false; } });
}

/**
 * @param {{exitCode?: number|null, signal?: string|null, infrastructure?: {reason?: string}|null,
 *   phaseResults?: {phase: string, result: {exitCode: number, signal?: string|null, failureDetails?: object}}[],
 *   isolatedRetry?: string|null, retriedFailures?: {file: string}[], changedFiles?: string[]|null, refused?: boolean,
 *   touchesDiff?: (file: string) => boolean}} a  `touchesDiff` says an UNEDITED failing test reaches the diff (see
 *   `testReachesChanged`): such a failure is the change's own regression, not one "outside the diff".
 * @returns {{redCause: string, redCauseFiles: string[]}|null} null when nothing was red (and no flake was absorbed)
 */
export function classifyRedCause({ exitCode, signal, infrastructure, phaseResults = [], isolatedRetry, retriedFailures = [], changedFiles, refused, touchesDiff } = {}) {
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
  const changed = new Set(changedFiles ?? []);
  // In the diff: the failing file was edited, or it (transitively) imports an edited file.
  const inDiff = (f) => changed.has(f) || (typeof touchesDiff === 'function' && touchesDiff(f) === true);
  if (isolatedRetry === STILL_RED_IN_ISOLATION) {
    const failing = retried.length ? retried : vitestFiles;
    return { redCause: failing.some(inDiff) ? 'in-diff-failure' : 'out-of-diff-still-red', redCauseFiles: failing };
  }
  if (TIMEOUT.test(first.result.failureDetails?.summary ?? '')) return { redCause: 'test-timeout', redCauseFiles: vitestFiles };
  // A truncated failure list cannot prove every failing file is outside the diff, so it never yields "outside".
  const outside = vitestFiles.length > 0 && Array.isArray(changedFiles) && !first.result.failureDetails?.truncated && vitestFiles.every(f => !inDiff(f));
  return { redCause: outside ? 'out-of-diff-still-red' : 'in-diff-failure', redCauseFiles: vitestFiles };
}
