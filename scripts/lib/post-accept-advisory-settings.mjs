/** Shadow-only post-accept advisory settings: standard → platform → tool → environment. */
import { readFileSync } from 'node:fs';
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';
import { REVIEW_SETTINGS_FILE } from './review-seat-settings.mjs';

export function resolvePostAcceptAdvisorySettings({ env = process.env, platform,
  file = REVIEW_SETTINGS_FILE, readFile = path => readFileSync(path, 'utf8'), log = line => console.error(line) } = {}) {
  let invalid = false;
  const warn = message => { invalid = true; try { log(`post-accept-advisory warning: ${message}; using shadow`); } catch { /* telemetry */ } };
  const project = (value, layer) => {
    if (value === undefined) return {};
    if (['off', 'shadow', 'on'].includes(value)) return { mode: value };
    warn(`invalid ${layer} mode`);
    return { mode: 'shadow' };
  };
  let tool;
  try {
    const data = JSON.parse(readFile(file));
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || (data.postAcceptAdvisory !== undefined && (!data.postAcceptAdvisory
        || typeof data.postAcceptAdvisory !== 'object' || Array.isArray(data.postAcceptAdvisory)))) {
      throw new Error('invalid settings shape');
    }
    tool = data.postAcceptAdvisory?.mode;
  }
  catch { warn('unreadable review settings'); tool = 'shadow'; }
  let plat = platform;
  if (plat === undefined) {
    try { plat = platformPreference('review', { env })?.postAcceptAdvisory; }
    catch { warn('unreadable platform settings'); plat = { mode: 'shadow' }; }
  }
  const result = cascadePolicy('review.postAcceptAdvisory', project(tool, 'tool'), {
    standard: { mode: 'shadow' }, platform: project(plat?.mode, 'platform'), env,
    envValues: project(env.WE_REVIEW_POST_ACCEPT_ADVISORY_MODE, 'env'),
  });
  if (invalid) result.value.mode = 'shadow';
  try { log(formatCascadeSourcesLine('review.postAcceptAdvisory', result)); } catch { /* telemetry */ }
  return { ...result, invalid };
}
