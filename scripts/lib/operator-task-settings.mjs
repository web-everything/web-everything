/** Operator brief admission: the shared build policy cascade, with leaf source logging. */
import { platformPreference, logCascadeSources, resolveCascade } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

// edgeLoad and liveProof default off; planOperatorPostBuild never emits them in any case (PR 5242 send-back).
const OPERATOR_TASK_DEFAULTS = Object.freeze({ enabled: true,
  postBuild: Object.freeze({ edgeLoad: false, liveProof: false, report: true }) });
const valid = { enabled: v => typeof v === 'boolean', postBuild: v => typeof v === 'boolean' };

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
