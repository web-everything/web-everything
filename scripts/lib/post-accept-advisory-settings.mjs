/** Shadow-only post-accept advisory settings: standard → platform → tool → environment. */
import { readFileSync } from 'node:fs';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from './policy-cascade.mjs';
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
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const blockMode = (value, layer) => {
    if (value === undefined) return undefined;
    if (!object(value)) { warn(`invalid ${layer} settings shape`); return 'shadow'; }
    if (Object.hasOwn(value, 'mode') && value.mode === undefined) { warn(`invalid ${layer} mode`); return 'shadow'; }
    return value.mode;
  };
  if (!object(env)) { warn('invalid environment settings shape'); env = {}; }
  else if (Object.hasOwn(env, 'WE_REVIEW_POST_ACCEPT_ADVISORY_MODE') && env.WE_REVIEW_POST_ACCEPT_ADVISORY_MODE === undefined) {
    warn('invalid env mode');
  }
  let tool;
  try {
    const data = JSON.parse(readFile(file));
    if (!object(data)) throw new Error('invalid settings shape');
    tool = blockMode(data.postAcceptAdvisory, 'tool');
  }
  catch { warn('unreadable review settings'); tool = 'shadow'; }
  let plat = platform;
  if (plat === undefined) {
    const { prefs, errors } = readPlatformPreferences({ env, readFile });
    if (errors.length) warn('unreadable platform settings');
    if (prefs.review !== undefined && !object(prefs.review)) warn('invalid platform review shape');
    else plat = prefs.review?.postAcceptAdvisory;
  }
  const result = cascadePolicy('review.postAcceptAdvisory', project(tool, 'tool'), {
    standard: { mode: 'shadow' }, platform: project(blockMode(plat, 'platform'), 'platform'), env,
    envValues: project(env.WE_REVIEW_POST_ACCEPT_ADVISORY_MODE, 'env'),
  });
  if (invalid) result.value.mode = 'shadow';
  try { log(formatCascadeSourcesLine('review.postAcceptAdvisory', result)); } catch { /* telemetry */ }
  return { ...result, invalid };
}
