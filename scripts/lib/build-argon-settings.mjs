/** Argon build probation: shared cascade, with source logging; read once per routing process. */
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

const STANDARD = { argon: { enabled: true, model: 'gemini-4-argon-high' } };
// Project only our leaves; unrelated build settings must not enter this reader's source log.
function layer(build) {
  const argon = {};
  if (typeof build?.argon?.enabled === 'boolean') argon.enabled = build.argon.enabled;
  if (typeof build?.argon?.model === 'string' && /^gemini-[a-z0-9.-]+$/.test(build.argon.model)) argon.model = build.argon.model;
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
