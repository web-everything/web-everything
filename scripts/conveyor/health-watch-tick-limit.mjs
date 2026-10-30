import { loadavg, cpus } from 'node:os';
import { DEFAULT_HEALTH_CONFIG } from './health-watch-core.mjs';
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from '../lib/policy-cascade.mjs';

/** Resolve a bounded parent-process deadline; OS readings are injectable without touching host load. */
export function resolveTickWatchdogLimit({ config = {}, env = process.env,
  platform = platformPreference('healthWatchTickWatchdog', { env }),
  readLoad = () => ({ load1: loadavg()[0], cores: cpus().length }), log = console.error,
} = {}) {
  const standard = { tickBudgetMs: DEFAULT_HEALTH_CONFIG.tickBudgetMs, tickKillLoadScaleMax: 3, tickKillCeilingMs: 540_000 };
  const pick = block => Object.fromEntries(Object.keys(standard).filter(k => block?.[k] !== undefined)
    .map(k => [k, typeof block[k] === 'object' ? JSON.stringify(block[k]) : block[k]]));
  const number = raw => raw === undefined ? undefined : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
  // Node timers above this bound overflow to 1ms. Reject rather than silently changing the deadline.
  const validMs = v => Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647;
  const result = cascadePolicy('healthWatchTickWatchdog', pick(config), {
    standard, platform: pick(platform), env,
    envValues: { tickKillLoadScaleMax: number(env.WE_HEALTH_TICK_KILL_LOAD_SCALE_MAX),
      tickKillCeilingMs: number(env.WE_HEALTH_TICK_KILL_CEILING_MS) },
    valid: { tickBudgetMs: validMs, tickKillCeilingMs: validMs,
      tickKillLoadScaleMax: v => Number.isFinite(v) && v >= 1 },
    log: () => {}, // Log once below, after applying the explicit standard fallback.
  });
  for (const key of Object.keys(standard)) {
    if (result.invalid.some(entry => entry.startsWith(`platform.${key}=`) || entry.startsWith(`tool.${key}=`) || entry.startsWith(`env.${key}=`))) {
      result.value[key] = standard[key]; result.sources[key] = 'standard'; result.leafValues[key] = standard[key];
    }
  }
  log(formatCascadeSourcesLine('healthWatchTickWatchdog', result));
  let loadScale = 1;
  try {
    const { load1, cores } = readLoad();
    if (!Number.isFinite(load1) || load1 < 0 || !Number.isSafeInteger(cores) || cores <= 0) throw new Error('invalid reading');
    loadScale = Math.min(result.value.tickKillLoadScaleMax, Math.max(1, load1 / cores));
  } catch {
    log('health-watch: load reading invalid or unavailable; using bounded idle deadline (scale=1).');
  }
  const killAfterMs = Math.min(result.value.tickKillCeilingMs, Math.ceil(result.value.tickBudgetMs * 3 * loadScale));
  log(`health-watch: tick watchdog killAfterMs=${killAfterMs}, loadScale=${loadScale}`);
  return { ...result, killAfterMs, loadScale };
}

