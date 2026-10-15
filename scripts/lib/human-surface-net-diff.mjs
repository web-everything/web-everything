/** Human-only re-parks judge the pinned head's net contribution against current origin/main (#5381). */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';
import { normOnOff, REVIEW_SETTINGS_FILE } from './review-seat-settings.mjs';
import { defaultGitDirFor, gitExec, readNetFileSets } from '../operations/free-scope-io.mjs';

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
 * required on every read; neither the GitHub list nor a memoized net set can establish absence of a surface.
 * No checkout, branch switch or working-tree change. The fetch updates only origin/main and fetches PR objects.
 */
export function readHumanSurfaceNetFiles({ repo, number, headRefOid }, {
  git = gitExec(), gitDirFor = defaultGitDirFor,
} = {}) {
  let fetchFailure;
  try {
    const result = readNetFileSets({ dir: gitDirFor(repo), rows: [{ number, headRefOid }], git: (dir, args) => {
      try { return git(dir, args); }
      catch (error) {
        if (args[0] === 'fetch') fetchFailure = `fetch failed: ${String(error?.stderr || error?.message || error).trim().split('\n')[0]}`;
        throw error;
      }
    } }).get(number);
    return fetchFailure ? { ok: false, reason: fetchFailure } : result ?? { ok: false, reason: 'net file set not read' };
  } catch (error) { return { ok: false, reason: String(error?.message ?? error).split('\n')[0] }; }
}
