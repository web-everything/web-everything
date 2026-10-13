/** Drain's human-only workflow boundary, sharing the merge-gate's path predicate. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { workflowEditHold } from './merge-queue-enqueue.mjs';

const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'drain-gate-settings.json');
const normalize = (v) => {
  const value = String(v ?? '').trim().toLowerCase();
  return value === 'on' || value === 'off' ? value : null;
};

/** Built-in → platform preference → drain tool settings → environment. Invalid layers fall through. */
export function resolveDrainWorkflowEditHuman({ env = process.env, file = SETTINGS_FILE } = {}) {
  const key = 'drainWorkflowEditHuman';
  let tool;
  try { tool = JSON.parse(readFileSync(file, 'utf8'))?.[key]; } catch { /* layer not set */ }
  const fromEnv = normalize(env?.WE_DRAIN_WORKFLOW_EDIT_HUMAN);
  const c = cascadePolicy(key, tool, {
    env, standard: 'on', envValues: { '': fromEnv ?? undefined }, valid: (v) => normalize(v) !== null,
    log: () => {}, // The drain logs the winning source once per pass, including unchanged watch passes.
  });
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const layer = c.sources[''];
  if (layer === 'tool') return { value: normalize(c.value), source: 'settings' };
  if (layer === 'platform') return { value: normalize(c.value), source: 'platform' };
  return { value: 'on', source: 'default' };
}

/** Pure. Unknown file evidence is never cleared by a human SHA; only explicit off disables this gate. */
export function decideDrainWorkflowEditHold({ files, filesComplete, headSha, humanClearedSha, setting = 'on' } = {}) {
  if (setting === 'off') return { hold: false };
  const hold = workflowEditHold({ files, expectedCount: filesComplete === true ? files?.length : undefined });
  if (!hold.hold) return { hold: false };
  if (!hold.humanOnly) return { hold: true, defer: true, reason: `workflow-edit check deferred: ${hold.error}` };
  const cleared = String(humanClearedSha || '').toLowerCase();
  if (cleared && cleared === String(headSha || '').toLowerCase()) return { hold: false };
  return { hold: true, reason: `human-only: the diff at ${String(headSha || 'unknown').slice(0, 9)} touches ${hold.paths.join(', ')} — workflow files decide the required checks, so only a clear-human ceremony at this exact head can accept it${cleared ? ` (human clearance is for ${cleared.slice(0, 9)})` : ''}` };
}
