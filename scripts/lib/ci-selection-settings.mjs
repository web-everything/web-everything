/**
 * @file scripts/lib/ci-selection-settings.mjs
 * @description The `ci.selection.*` policy loader (R1071): standard -> platform -> scripts/settings/ci-selection.json ->
 * WE_CI_SELECTION (JSON block). Kept apart from related-test-selection.mjs on purpose: that module is imported all over
 * the gate and queue code, and importing the policy cascade from it changed module load order enough to break the
 * policy-cascade suite's mocked operator store. Callers that want the configured values import this; the pure graph
 * code uses DEFAULT_SELECTION.
 */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';
import { DEFAULT_SELECTION } from './related-test-selection.mjs';

/** Invalid leaves retain the lower layer; in CI an env/file value can never switch an edge kind off or truncate. */
export function loadCiSelection({ env = process.env, readFile = readFileSync, tool, platform, log } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFile(new URL('../settings/ci-selection.json', import.meta.url), 'utf8')).ci.selection; }
    catch { tool = {}; }
  }
  let override = {};
  try { override = JSON.parse(env.WE_CI_SELECTION || '{}'); } catch { /* defaults */ }
  const integer = v => Number.isSafeInteger(v) && v >= 0;
  const edgeEnabled = v => typeof v === 'boolean' && (!(env.CI || env.GITHUB_ACTIONS) || v);
  const bools = v => v && typeof v === 'object' && ['spawnPath', 'alias', 'literalRead'].every(k => edgeEnabled(v[k]));
  const resolved = cascadePolicy('ci.selection', tool, { standard: DEFAULT_SELECTION, platform, env,
    envValues: override && typeof override === 'object' ? override : {},
    valid: { maxTests: integer, maxTestsInCi: v => v === DEFAULT_SELECTION.maxTestsInCi,
      staticEdges: bools, 'staticEdges.spawnPath': edgeEnabled,
      'staticEdges.alias': edgeEnabled, 'staticEdges.literalRead': edgeEnabled }, ...(log ? { log } : {}) });
  return resolved.value;
}
