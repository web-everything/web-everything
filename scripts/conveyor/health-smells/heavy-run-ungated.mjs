/**
 * @file scripts/conveyor/health-smells/heavy-run-ungated.mjs
 * @description Sustained heavy runs outside admission. Combines the current process snapshot with the
 * ~60s sampler's history; attribution names the program that should route runs through admission.
 * Counts are run observations across samples, not distinct invocations. Shadow by default.
 */
import { MINUTE } from '../health-watch-core.mjs';
import { findUngatedHeavyRuns, summarizeSample } from '../heavy-run-ungated.mjs';

export default {
  id: 'heavy-run-ungated',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['processes', 'heavyRunSamples'],
  severity: 'high',
  action: 'alert',
  openAfter: 1,
  closeAfter: 2,
  minRuns: 1,
  minSamples: 2,
  windowMs: 10 * MINUTE,
  recommendationHint: 'Route heavy test and standards runs through heavy-admission.',
  evaluate({ processes, heavyRunSamples }, { now, config = {} }) {
    const minRuns = config.heavyRunUngatedMinRuns ?? this.minRuns;
    const minSamples = config.heavyRunUngatedMinSamples ?? this.minSamples;
    const windowMs = config.heavyRunUngatedWindowMs ?? this.windowMs;
    const current = summarizeSample(findUngatedHeavyRuns(processes), new Date(now).toISOString());
    const samples = (Array.isArray(heavyRunSamples) ? heavyRunSamples : []).filter((s) => {
      const at = Date.parse(s?.at);
      return !s?.error && Number.isFinite(s?.count) && at >= now - windowMs && at <= now;
    }).concat(current);
    const breachingSamples = samples.filter((s) => s.count >= minRuns).length;
    const grouped = new Map();
    for (const sample of samples) for (const run of sample.runs || []) {
      const name = run.programName || 'unknown';
      if (!grouped.has(name)) grouped.set(name, { programName: name, runs: 0, pids: new Set() });
      const group = grouped.get(name); group.runs++; group.pids.add(run.pid);
    }
    const programs = [...grouped.values()].sort((a, b) => b.runs - a.runs || a.programName.localeCompare(b.programName))
      .slice(0, 5).map((p) => ({ ...p, pids: [...p.pids] }));
    const total = samples.reduce((n, s) => n + s.count, 0);
    return [{
      subject: 'host', breach: breachingSamples >= minSamples,
      measure: { samplesInWindow: samples.length, breachingSamples, current: current.count, programs },
      summary: `${total} ungated heavy runs in ${samples.length} samples over ${windowMs / MINUTE}m — ${programs.map((p) => `${p.programName} ×${p.runs}`).join(', ') || 'none'}`,
      recommendation: `Route ${programs[0]?.programName || 'the parent program'}'s test/standards runs through node scripts/readiness/heavy-admission.mjs run -- <cmd>.`,
    }];
  },
};
