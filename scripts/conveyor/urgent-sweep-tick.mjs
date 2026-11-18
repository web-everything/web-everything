/** Periodic urgent-load reconciliation; failures never interrupt health-watch. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { urgentSweep } from '../operations/urgent-sweep.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { prSweepTickAllowed } from './pr-sweep-job.mjs';
import { scrubText } from './health-watch-core.mjs';

const SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../settings/urgent-sweep.json');

export const urgentSweepTickAllowed = flags => prSweepTickAllowed(flags, { enabled: true });
export function resolveUrgentSweepSettings({ env = process.env, read = readFileSync, log = console.error } = {}) {
  const tool = JSON.parse(read(SETTINGS_PATH, 'utf8')).urgentSweep;
  const out = cascadePolicy('urgentSweep', tool, {
    standard: { intervalMinutes: 5 }, env,
    envValues: { intervalMinutes: env.WE_URGENT_SWEEP_INTERVAL_MINUTES === undefined ? undefined : Number(env.WE_URGENT_SWEEP_INTERVAL_MINUTES) },
    valid: { intervalMinutes: v => Number.isSafeInteger(v) && v > 0 },
  });
  log(formatCascadeSourcesLine('urgentSweep', out));
  return out;
}

export async function runUrgentSweepTick({ flags = {}, now, state = {}, sweep = urgentSweep,
  settings = resolveUrgentSweepSettings, log = console.error } = {}) {
  if (!urgentSweepTickAllowed(flags)) return state;
  try {
    const { value } = settings();
    if (Number.isFinite(state.lastAttemptAt) && state.lastAttemptAt <= now
      && now - state.lastAttemptAt < value.intervalMinutes * 60000) return state;
    const result = await sweep();
    if (result?.ok !== true) throw new Error(result?.detail ?? result?.fallback ?? 'urgent-sweep failed');
    return { lastAttemptAt: now };
  } catch (e) {
    const error = scrubText(String(e?.message ?? e));
    log(`urgent-sweep: ${error}`);
    return { lastAttemptAt: now, error };
  }
}
