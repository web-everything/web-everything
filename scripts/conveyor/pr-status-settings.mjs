import { readFileSync } from 'node:fs';
import { PLATFORM_PREFERENCES_PATH } from '../lib/merge-delivery-policy.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';

const keys = {
  acceptedRedTeamStatus: { standard: 'red-team', values: ['red-team', 'ready-to-merge'], env: 'WE_PR_STATUS_ACCEPTED_RED_TEAM' },
  reviewGateSignal: { standard: 'review', values: ['review', 'ci'], env: 'WE_PR_STATUS_REVIEW_GATE_SIGNAL' },
  stackedMainOnlyChecks: { standard: 'waiting-on-base', values: ['waiting-on-base', 'awaiting-ci'], env: 'WE_PR_STATUS_STACKED_MAIN_ONLY' },
  mainOnlyRequiredChecks: { standard: Object.freeze(['merge-gate']), env: 'WE_PR_STATUS_MAIN_ONLY_CHECKS' },
};

export const PR_STATUS_SETTING_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(keys).map(([key, config]) => [key, config.standard]),
));

/** Each status preference resolves independently; invalid layers are ignored and reported. */
export function resolvePrStatusSettings({ env = {}, platform = {}, repo = {} } = {}) {
  return Object.fromEntries(Object.entries(keys).map(([key, config]) => {
    let result = { value: config.standard, source: 'standard' };
    const ignored = [];
    for (const [source, doc] of [['platform', platform], ['repo', repo], ['env', env]]) {
      const block = doc?.prStatus;
      if (source !== 'env' && (!doc || typeof doc !== 'object' || Array.isArray(doc)
          || (block !== undefined && (!block || typeof block !== 'object' || Array.isArray(block))))) {
        ignored.push({ source, reason: 'invalid prStatus settings block' });
        continue;
      }
      let value = source === 'env' ? doc?.[config.env] : block?.[key];
      if (value === undefined) continue;
      if (key === 'mainOnlyRequiredChecks' && source === 'env' && typeof value === 'string') {
        value = value.split(',').map(name => name.trim());
      }
      const valid = config.values ? config.values.includes(value)
        : Array.isArray(value) && value.every(name => typeof name === 'string' && name.trim().length > 0);
      if (!valid) {
        ignored.push({ source, reason: `invalid prStatus.${key}: expected ${config.values?.join('|') ?? 'a list of non-empty strings'}` });
        continue;
      }
      result = { value, source };
    }
    return [key, ignored.length ? { ...result, ignored } : result];
  }));
}

/** Unreadable settings throw so the shell can retain the pure core's defaults. */
export function loadPrStatusSettings({ env = process.env, readFile = readFileSync, readDeclared = readDeclaredSettings } = {}) {
  let platform = {};
  try { platform = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8')); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const declared = readDeclared();
  if (declared.errors?.length || declared.duplicates?.some(d => /^prStatus(?:\.|$)/.test(d.path))) {
    throw new Error('prStatus declared settings unreadable');
  }
  return resolvePrStatusSettings({ env, platform, repo: declared.settings });
}

/** Plain values for the pure status reducer. */
export function prStatusSettingValues(resolved) {
  return Object.fromEntries(Object.keys(keys).map(key => [key, resolved[key].value]));
}
