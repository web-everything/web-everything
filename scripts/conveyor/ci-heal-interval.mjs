/** CI-heal cadence policy; the daemon owns the in-process timer. */
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';

const DEFAULT_SECONDS = 300;
const validInterval = value => Number.isInteger(value) && value >= 60 && value <= 1800;
const boundedInterval = value => validInterval(value) ? value : DEFAULT_SECONDS;

/** Invalid explicit overrides select the standard bound, never an arbitrary lower-layer value. */
export function resolveCiHealInterval({ env = process.env, settings = readSettings() } = {}) {
  const tool = settings?.ciHeal?.intervalSec;
  const rawEnv = env.WE_CI_HEAL_INTERVAL_SEC;
  const envValue = rawEnv === undefined ? undefined
    : boundedInterval(typeof rawEnv === 'string' && /^\d+$/.test(rawEnv) ? Number(rawEnv) : NaN);
  const resolved = cascadePolicy('ciHeal', tool === undefined ? undefined : { intervalSec: boundedInterval(tool) }, {
    standard: { intervalSec: DEFAULT_SECONDS }, envValues: { intervalSec: envValue }, valid: validInterval, env,
  });
  return { seconds: resolved.value.intervalSec, source: resolved.sources.intervalSec };
}

