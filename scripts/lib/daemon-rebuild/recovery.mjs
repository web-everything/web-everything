/** Timed recovery of environment holds and unadopted registrations. */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from '../policy-cascade.mjs';
import { OVERLAY_ADOPTION_OVERDUE_MS, OVERLAY_ADOPTION_TTL_MS } from '../overlay-adoption.mjs';

export function resolveRecovery({ env = process.env, log = console.error, tool } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(new URL('../daemon-rebuild-settings.json', import.meta.url), 'utf8')).recovery; } catch { tool = {}; }
  }
  const standard = { envTimeoutBaseMs: 600_000, envTimeoutMaxMs: 2_400_000, overlayOverdueMs: OVERLAY_ADOPTION_OVERDUE_MS };
  const envValues = Object.fromEntries(Object.keys(standard).map(k => [k, env[`WE_DAEMON_RECOVERY_${k.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]])
    .filter(([, v]) => v !== undefined).map(([k, v]) => [k, Number(v)]));
  return cascadePolicy('recovery', tool, { env, log, standard, envValues,
    valid: Object.fromEntries(Object.keys(standard).map(k => [k, v => Number.isSafeInteger(v) && v > 0 && v <= OVERLAY_ADOPTION_TTL_MS])) }).value;
}

export function envTimeoutRetry(held, nowMs, settings) {
  const attempts = (held?.reason === 'smoke-env-timeout' && Number.isSafeInteger(held.attempts) && held.attempts > 0 ? held.attempts : 0) + 1;
  const delay = Math.min(settings.envTimeoutBaseMs * 2 ** Math.min(attempts - 1, 32), settings.envTimeoutMaxMs);
  return { attempts, retryAt: new Date(nowMs + delay).toISOString() };
}

// Old holds had no deadline: recover them from their last observed timeout, across restarts.
export function timeoutRetryAt(held, settings) {
  if (held?.reason !== 'smoke-env-timeout') return NaN;
  return held.retryAt != null ? Date.parse(held.retryAt) : Date.parse(held.updatedAt || held.since || '') + Math.min(settings.envTimeoutBaseMs, settings.envTimeoutMaxMs);
}

export function recoveryDue({ state, pending, nowMs, settings }) {
  const retry = timeoutRetryAt(state?.held, settings);
  if (state?.held?.reason === 'smoke-env-timeout') return Number.isFinite(retry) && nowMs >= retry;
  return pending.some(rec => {
    const age = nowMs - Date.parse(rec.at || '');
    return age >= settings.overlayOverdueMs && age < OVERLAY_ADOPTION_TTL_MS;
  });
}
