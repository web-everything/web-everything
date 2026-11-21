/**
 * @file scripts/lib/ci-selection-settings.mjs
 * @description The `ci.selection.trace` policy loader (R1071): standard -> platform -> scripts/settings/ci-selection.json ->
 * WE_CI_SELECTION (JSON block). Shadow dependency tracing only; nothing here changes which tests run. Kept apart from
 * related-test-selection.mjs because that module is imported all over the gate and queue code.
 */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';

// Tracer defaults belong here so shadow tracing leaves the production selector unchanged.
const DEFAULT_SELECTION = { trace: { enabled: true, maxEdgesPerTest: 5000 } };

/** Invalid leaves retain the lower layer. Returns `{ trace: { enabled, maxEdgesPerTest } }`. */
export function loadCiSelection({ env = process.env, readFile = readFileSync, tool, platform, log } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFile(new URL('../settings/ci-selection.json', import.meta.url), 'utf8')).ci.selection; }
    catch { tool = {}; }
  }
  let override = {};
  try { override = JSON.parse(env.WE_CI_SELECTION || '{}'); } catch { /* defaults */ }
  const integer = v => Number.isSafeInteger(v) && v >= 0;
  const block = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const trace = cascadePolicy('ci.selection.trace', block(tool?.trace), {
    standard: DEFAULT_SELECTION.trace, platform: block(block(platform).trace), env,
    envValues: block(block(override).trace), valid: { enabled: v => typeof v === 'boolean', maxEdgesPerTest: integer },
    ...(log ? { log } : {}),
  }).value;
  return { trace };
}
