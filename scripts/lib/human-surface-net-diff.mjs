/** Human-only re-parks judge the pinned head's net contribution against current origin/main (#5381). */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';
import { normOnOff, REVIEW_SETTINGS_FILE } from './review-seat-settings.mjs';
import { defaultGitDirFor, gitExec, readNetFileSets } from '../operations/free-scope-io.mjs';

// These fixed reasons may cross the public-comment boundary; subprocess diagnostics may not.
const PUBLIC_FAILURES = new Set(['fetch failed', 'net diff failed', 'net read failed',
  'no local checkout of this repo', 'no usable head commit id', 'missing head commit', 'net file set not read',
  'net file set returned no usable array']);
export const publicHumanSurfaceNetFailure = reason => PUBLIC_FAILURES.has(reason) ? reason : 'net read failed';

/** Standard true → platform review preference → review.json → env; cascade logs the source. */
export function resolveHumanSurfaceNetSetting({ env = process.env, readFile = readFileSync, platform, log } = {}) {
  let tool;
  try { tool = JSON.parse(String(readFile(REVIEW_SETTINGS_FILE, 'utf8')))?.humanSurfaceUsesNetDiff; } catch { /* absent layer */ }
  const bool = value => normOnOff(value) === null ? undefined : normOnOff(value) === 'on';
  const resolved = cascadePolicy('review', { humanSurfaceUsesNetDiff: bool(tool) }, {
    standard: { humanSurfaceUsesNetDiff: true }, platform, env, log,
    envValues: { humanSurfaceUsesNetDiff: bool(env.WE_REVIEW_HUMAN_SURFACE_USES_NET_DIFF) },
    valid: { humanSurfaceUsesNetDiff: value => typeof value === 'boolean' },
  });
  return { value: resolved.value.humanSurfaceUsesNetDiff, source: resolved.sources.humanSurfaceUsesNetDiff };
}

/**
 * Reuse the shared merge-base reader, but refuse its offline cached-base fallback. A successful fetch is
 * required on every net read. The sweep may skip on a complete, clean GitHub list if this read fails.
 * No checkout, branch switch or working-tree change. The fetch updates only origin/main and fetches PR objects.
 */
export function readHumanSurfaceNetFiles({ repo, number, headRefOid }, {
  git = gitExec(), gitDirFor = defaultGitDirFor, log = message => console.error(message),
} = {}) {
  let fetchFailure, netDiffFailure;
  const diagnostic = error => {
    try { log(`[human-surface-net-diff] ${String(error?.stderr || error?.message || error)}`); }
    catch { /* A local logging failure must not bypass the failed-read result. */ }
  };
  try {
    const result = readNetFileSets({ dir: gitDirFor(repo), rows: [{ number, headRefOid }], git: (dir, args) => {
      try { return git(dir, args); }
      catch (error) {
        diagnostic(error);
        if (args[0] === 'fetch') fetchFailure = 'fetch failed';
        if (args[0] === 'merge-base' || args[0] === 'diff') netDiffFailure = 'net diff failed';
        throw error;
      }
    } }).get(number);
    if (fetchFailure) return { ok: false, reason: fetchFailure };
    if (netDiffFailure) return { ok: false, reason: netDiffFailure };
    if (!result) return { ok: false, reason: 'net file set not read' };
    if (!result.ok) return { ok: false, reason: PUBLIC_FAILURES.has(result.reason) ? result.reason : 'net diff failed' };
    return result;
  } catch (error) {
    diagnostic(error);
    return { ok: false, reason: 'net read failed' };
  }
}
