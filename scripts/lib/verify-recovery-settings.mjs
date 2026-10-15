/** Verify infrastructure recovery, resolved per leaf through the shared policy cascade. */
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function loadVerifyRecoverySettings({ env = process.env, tool = readSettings().verify, platform } = {}) {
  return cascadePolicy('verify', tool, {
    env, platform,
    standard: { infraRetry: { maxAttempts: 3, backoffMinutes: 15 }, gateCeiling: 'load-scaled' },
    valid: { infraRetry: value => Number.isSafeInteger(value) && value >= 0,
      gateCeiling: value => ['fixed', 'load-scaled'].includes(value) },
    envValues: { gateCeiling: env.WE_VERIFY_GATE_CEILING || undefined },
  });
}
