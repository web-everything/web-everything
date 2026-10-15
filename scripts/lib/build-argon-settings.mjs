/** Argon build probation: shared cascade, with source logging; read once per routing process. */
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { resolvePolicyModel } from './dispatch-routing-policy.mjs';

const STANDARD = { argon: { enabled: true, model: 'gemini-4-argon-high' } };
/** Both cascade leaves and injected routing settings must name a catalogued Gemini model. */
export function resolveBuildArgonModel(model) {
  if (typeof model !== 'string' || !/^gemini-[a-z0-9.-]+$/.test(model)) return null;
  try {
    const resolved = resolvePolicyModel('antigravity', model);
    return resolved.startsWith('gemini-') ? resolved : null;
  } catch { return null; }
}

// Project only our leaves; unrelated build settings must not enter this reader's source log.
function layer(build) {
  const argon = {};
  if (typeof build?.argon?.enabled === 'boolean') argon.enabled = build.argon.enabled;
  const model = resolveBuildArgonModel(build?.argon?.model);
  if (model) argon.model = model;
  return { argon };
}

export function readBuildArgonSettings({ env = process.env, read = readSettings, platform, log } = {}) {
  let tool;
  try { tool = read()?.build; } catch { /* retain lower layers */ }
  const resolved = cascadePolicy('build', layer(tool), {
    standard: STANDARD,
    platform: layer(platform ?? platformPreference('build', { env })),
    env, log,
  });
  return {
    value: resolved.value.argon,
    sources: { enabled: resolved.sources['argon.enabled'], model: resolved.sources['argon.model'] },
  };
}
