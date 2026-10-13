/** Operator brief admission: the shared build policy cascade, with leaf source logging. */
import { platformPreference, logCascadeSources, resolveCascade } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

const OPERATOR_TASK_DEFAULTS = Object.freeze({ enabled: true, maxPriority: 'P0',
  postBuild: Object.freeze({ edgeLoad: true, liveProof: true, report: true }) });
const valid = { enabled: v => typeof v === 'boolean', maxPriority: v => /^P[0-4]$/.test(v),
  postBuild: v => typeof v === 'boolean' };

export function resolveOperatorTaskSettings({ platform, tool } = {}) {
  return resolveCascade({ standard: OPERATOR_TASK_DEFAULTS,
    platform: platform?.operatorTask, tool: tool?.operatorTask, valid });
}

export function readOperatorTaskSettings({ env = process.env, read = readSettings, tool, platform, log } = {}) {
  if (tool === undefined) {
    try { tool = read()?.build; } catch { /* retain lower layers */ }
  }
  const resolved = resolveOperatorTaskSettings({ platform: platform ?? platformPreference('build', { env }), tool });
  logCascadeSources('build.operatorTask', resolved, { env, ...(log ? { log } : {}) });
  return resolved.value;
}
