/** Operator brief admission: the shared build policy cascade, with leaf source logging. */
import { platformPreference, logCascadeSources, resolveCascade } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

const OPERATOR_TASK_DEFAULTS = Object.freeze({ enabled: true, maxPriority: 'P0' });
const valid = { enabled: v => typeof v === 'boolean', maxPriority: v => /^P[0-4]$/.test(v) };

export function resolveOperatorTaskSettings({ platform, tool } = {}) {
  return resolveCascade({ standard: OPERATOR_TASK_DEFAULTS,
    platform: platform?.operatorTask, tool: tool?.operatorTask, valid });
}

export function readOperatorTaskSettings({ env = process.env, read = readSettings } = {}) {
  let tool;
  try { tool = read()?.build; } catch { /* retain lower layers */ }
  const resolved = resolveOperatorTaskSettings({ platform: platformPreference('build', { env }), tool });
  logCascadeSources('build.operatorTask', resolved, { env });
  return resolved.value;
}
