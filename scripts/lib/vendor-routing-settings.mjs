/**
 * Preferred vendors per task: standard → platform → tool → environment, with source logging.
 * "Gemini" means the LOCAL Antigravity CLI (`agy`, see scripts/gemini-direct-task.mjs),
 * which runs on this machine and counts against Mac load (run one at a time, only under
 * the host load cap) - it is not a remote service. agy can hit a quota hold; this reader
 * only names the preferred vendor, callers must fall back per their own rules.
 */
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

const STANDARD = Object.freeze({
  'backlog-sort': 'gemini',
  'backlog-triage': 'gemini',
  'prepare-research': 'gemini',
  'second-opinion-audit': 'gemini',
  'report-draft': 'gemini',
  'code-edit': 'codex',
  'test-fix': 'codex',
  build: 'codex',
  judgment: 'claude',
  decision: 'claude',
  'design-review': 'claude',
  orchestration: 'claude',
});
export const VENDOR_TASK_TYPES = Object.freeze(Object.keys(STANDARD));
export const VENDORS = Object.freeze(['gemini', 'codex', 'claude']);

// Project known, valid leaves only: malformed containers never erase lower layers.
function layer(byTaskType) {
  const result = {};
  if (!byTaskType || typeof byTaskType !== 'object' || Array.isArray(byTaskType)) return result;
  for (const task of VENDOR_TASK_TYPES) {
    if (Object.hasOwn(byTaskType, task) && VENDORS.includes(byTaskType[task])) result[task] = byTaskType[task];
  }
  return result;
}

/** Never throws on unreadable settings or malformed JSON. value/sources are keyed by task type.
 * WE_VENDOR_ROUTING is a JSON object mapping task type directly to vendor.
 */
export function readVendorRoutingSettings({ env = process.env, read = readSettings, platform, log } = {}) {
  let tool, team, overrides;
  try { tool = layer(read()?.vendorRouting?.byTaskType); } catch { /* retain lower layers */ }
  try { team = layer((platform ?? platformPreference('vendorRouting', { env }))?.byTaskType); }
  catch { /* retain standard */ }
  try { overrides = layer(JSON.parse(env?.WE_VENDOR_ROUTING)); } catch { /* retain lower layers */ }
  const resolved = cascadePolicy('vendorRouting.byTaskType', tool ?? {}, {
    standard: STANDARD, platform: team ?? {}, envValues: overrides ?? {}, env, log,
  });
  return { value: resolved.value, sources: resolved.sources };
}

/** Unknown task types return null; known types return the preferred vendor and its cascade source. */
export function resolveVendorForTask(taskType, opts) {
  if (!VENDOR_TASK_TYPES.includes(taskType)) return null;
  const { value, sources } = readVendorRoutingSettings(opts);
  return { vendor: value[taskType], source: sources[taskType] };
}
