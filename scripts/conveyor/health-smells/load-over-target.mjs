/**
 * Health smell — R480 load governor. Fires when the 1-min load per core stays above the governor's ceiling
 * (`targetLoadPerCore`) for `overTargetSmellMinutes`, meaning holding/pausing is not pulling load back down. The
 * summary also counts paused owners (live pause flags) and says when the load could not be read at all (the governor
 * then fails open, so that must not be silent).
 */
import { MINUTE } from '../health-watch-core.mjs';
import { GOVERNOR_DEFAULTS, listPauses, resolveGovernorSettings } from '../../lib/load-governor.mjs';
import { readSettings } from '../../lib/settings-files.mjs';

export default {
  id: 'load-over-target',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['machineLoad'],
  openAfter: 10, // ticks; at the ~1-min health tick this is overTargetSmellMinutes
  closeAfter: 3,
  severity: 'medium',
  action: 'alert',
  targetLoadPerCore: GOVERNOR_DEFAULTS.targetLoadPerCore,
  windowMs: 30 * MINUTE,
  recommendationHint: 'Load is over the governor ceiling; check that low-priority owners are held/paused and that nothing exempt is the load.',
  listPaused: () => listPauses().length,
  target: () => resolveGovernorSettings({ settings: readSettings(), env: process.env }).targetLoadPerCore,
  evaluate({ machineLoad }) {
    const load = machineLoad || {};
    const cpu = Math.max(1, Number(load.cpuCount) || 1);
    const lpc = Number(load.load1) / cpu;
    const paused = this.listPaused();
    if (!Number.isFinite(lpc)) {
      return [{ subject: 'machine', breach: true, measure: { perCoreLoad: null, paused },
        summary: `load unreadable: the load governor is failing open (no holds); paused owners: ${paused}.`, recommendation: 'Fix the load probe; until then nothing is held.' }];
    }
    const target = this.target();
    const breach = lpc > target;
    return [{ subject: 'machine', breach, measure: { perCoreLoad: Number(lpc.toFixed(2)), target, paused },
      summary: breach ? `load/core ${lpc.toFixed(2)} over target ${target}; paused owners: ${paused}.`
        : `load/core ${lpc.toFixed(2)} within target ${target}; paused owners: ${paused}.`,
      recommendation: this.recommendationHint }];
  },
};
