/** Worker pressure, alert only: lower concurrency or hold dispatch; never kill workers.
 * Health-dir config.json overrides: workerCountVsLoad.{loadPerCore,minWorkersForLoad,workerCap,maxEvidenceAgeMs}.
 * Defaults: 2.5 load/core, 4 live workers, existing workerCapacity.ceiling (including
 * WE_WORKER_CAPACITY_CEILING), else 12. Effective values and sources travel in the report.
 * Bounds: loadPerCore [0.5,20], integer minWorkersForLoad/workerCap [1,200]. Invalid
 * overrides use defaults; an out-of-bounds inherited ceiling falls back to 12.
 * Freshness: maxEvidenceAgeMs defaults to 3 health-watch tick cadences, bounded to
 * [1 minute,1 hour]; invalid values fall back through the policy cascade. Sources:
 * standard → platform workerCountVsLoad → health config →
 * WE_WORKER_COUNT_VS_LOAD_MAX_EVIDENCE_AGE_MS. Missing or stale pool readings throw;
 * inspect/refresh every configured pool log before resuming dispatch.
 * Worker count is the sum of leased lanes from the existing local per-tick lanePools
 * probe, so this check runs between gh samples and under --no-gh without extra IO.
 * The high episode uses the core's four-hour reminder; escalateAfterMs documents that
 * duration policy (high episodes are already escalated, so cannot escalate again).
 */
import { MINUTE, HOUR } from '../health-watch-core.mjs';
import { readSettings } from '../../lib/settings-files.mjs';
import { resolveWorkerCapacitySettings } from '../../lib/worker-capacity.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { DAEMON_MANIFEST } from '../../../skills-src/conveyor/daemon-manifest.mjs';
import { cascadePolicy } from '../../lib/policy-cascade.mjs';

const platformSettings = readSettings();
const evidenceAge = v => Number.isSafeInteger(v) && v >= MINUTE && v <= HOUR;
const defaultEvidenceAgeMs = Math.max(MINUTE, Math.min(HOUR, 3 * DAEMON_MANIFEST['health-watch'].intervalMs));
const count = v => Number.isSafeInteger(v) && v > 0;
const workerCount = v => count(v) && v <= 200;
const loadThreshold = v => Number.isFinite(v) && v >= 0.5 && v <= 20;

export function workerLoadSettings(config = {}, settings = platformSettings, env = process.env) {
  const existing = resolveWorkerCapacitySettings({ settings, env });
  const hasCeiling = existing.sources.ceiling !== 'standard' && workerCount(existing.ceiling);
  const defaults = { loadPerCore: 2.5, minWorkersForLoad: 4, workerCap: hasCeiling ? existing.ceiling : 12 };
  const overrides = config?.workerCountVsLoad ?? {};
  const sources = {};
  for (const key of Object.keys(defaults)) {
    if ((key === 'loadPerCore' ? loadThreshold : workerCount)(overrides[key])) {
      defaults[key] = overrides[key];
      sources[key] = 'health config';
    } else sources[key] = key === 'workerCap' && hasCeiling ? `workerCapacity.ceiling (${existing.sources.ceiling})` : 'default';
  }
  const freshness = cascadePolicy('workerCountVsLoad', { maxEvidenceAgeMs: overrides.maxEvidenceAgeMs }, {
    standard: { maxEvidenceAgeMs: defaultEvidenceAgeMs },
    valid: { maxEvidenceAgeMs: evidenceAge },
    envValues: { maxEvidenceAgeMs: env.WE_WORKER_COUNT_VS_LOAD_MAX_EVIDENCE_AGE_MS === undefined
      ? undefined : Number(env.WE_WORKER_COUNT_VS_LOAD_MAX_EVIDENCE_AGE_MS) },
    env,
  });
  return { ...defaults, maxEvidenceAgeMs: freshness.value.maxEvidenceAgeMs,
    sources: { ...sources, maxEvidenceAgeMs: freshness.sources.maxEvidenceAgeMs } };
}

export default {
  id: 'worker-count-vs-load', scope: 'host', cadence: 'every-tick',
  probes: ['machineLoad', 'lanePools'], openAfter: 1, closeAfter: 2,
  severity: 'high', action: 'alert', escalateAfterMs: 4 * HOUR,
  evaluate({ machineLoad, lanePools }, { config, now } = {}) {
    const { sources, ...settings } = workerLoadSettings(config);
    if (!Array.isArray(lanePools) || !lanePools.length
      || Object.keys(CONSTELLATION_REPOS).some(repo => !lanePools.some(p => p?.repo === repo))
      || !Number.isFinite(now)
      || lanePools.some(p => !Number.isSafeInteger(p?.health?.leased) || p.health.leased < 0
        || !Number.isFinite(p.at) || p.at < 0 || p.at > now || now - p.at > settings.maxEvidenceAgeMs)
      || !Number.isFinite(machineLoad?.load1) || machineLoad.load1 < 0
      || !count(machineLoad?.cpuCount)) throw new Error('Incomplete worker/load evidence (missing, invalid, or stale); inspect machineLoad and all configured lanePools logs and refresh readings before resuming dispatch.');
    // Known running workers include lanes with a live worker but no lease (`workerWithoutLease`).
    const unleased = p => (Array.isArray(p.workerWithoutLease) ? new Set(p.workerWithoutLease.filter(Number.isSafeInteger)).size : 0);
    const liveWorkers = lanePools.reduce((sum, p) => sum + p.health.leased + unleased(p), 0);
    const perCoreLoad = machineLoad.load1 / machineLoad.cpuCount;
    const breach = (perCoreLoad >= settings.loadPerCore && liveWorkers >= settings.minWorkersForLoad)
      || liveWorkers > settings.workerCap;
    return [{
      subject: 'machine', breach,
      measure: { liveWorkers, perCoreLoad, load1: machineLoad.load1, cpuCount: machineLoad.cpuCount, settings, sources },
      summary: `${liveWorkers} live lane workers, leased or unleased (cap ${settings.workerCap}); load/core ${perCoreLoad.toFixed(2)} (threshold ${settings.loadPerCore} with at least ${settings.minWorkersForLoad} workers).`,
      recommendation: 'Lower worker count through reduced concurrency / hold dispatch until pressure subsides; let current workers finish.',
    }];
  },
};
