/** Prepare policy: standard → platform → feature settings → environment. */
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy, resolveCascade, platformPreference } from '../lib/policy-cascade.mjs';

const standard = Object.freeze({ retryUnstampedOnce: true, autoSize: true, runner: 'codex' });
const bool = v => typeof v === 'boolean';
const valid = { retryUnstampedOnce: bool, autoSize: bool, runner: v => ['codex', 'claude', 'scope'].includes(v) };
const parseBool = v => {
  if (bool(v)) return v;
  if (typeof v !== 'string') return undefined;
  const text = v.trim().toLowerCase();
  return ['true', '1'].includes(text) ? true : ['false', '0'].includes(text) ? false : undefined;
};
// Select only valid known leaves: malformed nested objects must not become cascade leaves.
const block = value => Object.fromEntries(Object.keys(standard)
  .filter(key => valid[key](value?.[key])).map(key => [key, value[key]]));
const envValues = env => ({
  retryUnstampedOnce: parseBool(env?.WE_PREPARE_RETRY_UNSTAMPED_ONCE),
  autoSize: parseBool(env?.WE_PREPARE_AUTO_SIZE),
  runner: env?.WE_PREPARE_RUNNER,
});
const result = resolved => ({
  retryUnstampedOnce: resolved.value.retryUnstampedOnce,
  autoSize: resolved.value.autoSize,
  runner: resolved.value.runner,
  sources: {
    retryUnstampedOnce: resolved.sources.retryUnstampedOnce,
    autoSize: resolved.sources.autoSize,
    runner: resolved.sources.runner,
  },
});

/** PURE: invalid leaves are ignored independently at each layer. */
export function resolvePreparePolicy({ platform, tool, env = {} } = {}) {
  return result(resolveCascade({ standard, platform: block(platform), tool: block(tool), envValues: envValues(env), valid }));
}

/** IO: discover the feature file and let the shared cascade log the effective sources. */
export function readPreparePolicy({ env = process.env, read = readSettings } = {}) {
  let tool;
  try { tool = read()?.prepare; } catch { /* unreadable settings are an absent layer */ }
  return result(cascadePolicy('prepare', block(tool), { standard, platform: block(platformPreference('prepare', { env })), envValues: envValues(env), valid, env }));
}
