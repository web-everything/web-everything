/** Real smoke workers require deliberate opt-in through the shared policy cascade. */
import { resolveCascade, platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function resolveSmokeRealWorker({
  env = process.env, tool = readSettings().smokeRealWorker,
  platform = platformPreference('smokeRealWorker', { env }), log,
} = {}) {
  const raw = String(env?.WE_SMOKE_ALLOW_REAL_WORKER ?? '').trim().toLowerCase();
  const allowSentinel = ['1', 'true'].includes(raw) ? true : ['0', 'false'].includes(raw) ? false : undefined;
  const resolved = resolveCascade({ standard: { allowSentinel: false }, platform, tool,
    envValues: { allowSentinel }, valid: { allowSentinel: value => typeof value === 'boolean' } });
  logCascadeSources('smokeRealWorker', resolved, { env, log: log === false ? () => {} : log });
  return { allowSentinel: resolved.value.allowSentinel, sources: resolved.sources };
}

export function isSmokeSentinelPr(pr) {
  return /^9\d{5}$/.test(String(pr));
}
