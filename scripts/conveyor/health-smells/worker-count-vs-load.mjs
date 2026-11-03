/** Worker pressure, alert only: lower concurrency or hold dispatch; never kill workers.
 * Health-dir config.json overrides: workerCountVsLoad.{loadPerCore,minWorkersForLoad,workerCap}.
 * Defaults: 2.5 load/core, 4 live workers, existing workerCapacity.ceiling (including
 * WE_WORKER_CAPACITY_CEILING), else 12. Effective values and sources travel in the report.
 * The high episode uses the core's four-hour reminder; escalateAfterMs documents that
 * duration policy (high episodes are already escalated, so cannot escalate again).
 */
import { HOUR } from '../health-watch-core.mjs';
import { readSettings } from '../../lib/settings-files.mjs';
import { resolveWorkerCapacitySettings } from '../../lib/worker-capacity.mjs';
import { isNonTerminal } from './duplicate-live-sessions.mjs';

const platformSettings = readSettings();
const positive = v => Number.isFinite(v) && v > 0;
const count = v => Number.isSafeInteger(v) && v > 0;

export function workerLoadSettings(config = {}, settings = platformSettings, env = process.env) {
  const existing = resolveWorkerCapacitySettings({ settings, env });
  const hasCeiling = existing.sources.ceiling !== 'standard';
  const defaults = { loadPerCore: 2.5, minWorkersForLoad: 4, workerCap: hasCeiling ? existing.ceiling : 12 };
  const overrides = config?.workerCountVsLoad ?? {};
  const sources = {};
  for (const key of Object.keys(defaults)) {
    if ((key === 'loadPerCore' ? positive : count)(overrides[key])) {
      defaults[key] = overrides[key];
      sources[key] = 'health config';
    } else sources[key] = key === 'workerCap' && hasCeiling ? `workerCapacity.ceiling (${existing.sources.ceiling})` : 'default';
  }
  return { ...defaults, sources };
}

export default {
  id: 'worker-count-vs-load', scope: 'host', cadence: 'every-tick',
  probes: ['machineLoad', 'agents'], openAfter: 1, closeAfter: 2,
  severity: 'high', action: 'alert', escalateAfterMs: 4 * HOUR,
  evaluate({ machineLoad, agents }, { config } = {}) {
    if (!Array.isArray(agents) || agents.some(a => !a || typeof a.state !== 'string' || !a.state)
      || !Number.isFinite(machineLoad?.load1) || machineLoad.load1 < 0
      || !count(machineLoad?.cpuCount)) throw new Error('Incomplete worker/load evidence; inspect machineLoad and agents probe errors before resuming dispatch.');
    const { sources, ...settings } = workerLoadSettings(config);
    const liveWorkers = agents.filter(isNonTerminal).length;
    const perCoreLoad = machineLoad.load1 / machineLoad.cpuCount;
    const breach = (perCoreLoad >= settings.loadPerCore && liveWorkers >= settings.minWorkersForLoad)
      || liveWorkers > settings.workerCap;
    return [{
      subject: 'machine', breach,
      measure: { liveWorkers, perCoreLoad, load1: machineLoad.load1, cpuCount: machineLoad.cpuCount, settings, sources },
      summary: `${liveWorkers} live workers (cap ${settings.workerCap}); load/core ${perCoreLoad.toFixed(2)} (threshold ${settings.loadPerCore} with at least ${settings.minWorkersForLoad} workers).`,
      recommendation: 'Lower worker count through reduced concurrency / hold dispatch until pressure subsides; let current workers finish.',
    }];
  },
};
