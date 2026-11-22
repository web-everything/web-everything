/** Host observations for the read-only quota calendar and burn planner. */
import { pathToFileURL } from 'node:url';
import { BUILD_KINDS, resolveRoutingSettings } from '../lib/routing-settings.mjs';
import { observeCapacity } from '../lib/provider-capacity-io.mjs';
import { planCapacity, planHorizon } from '../lib/capacity-planner.mjs';
import { scoreProvider, burnWindows, planLine } from '../lib/provider-capacity.mjs';
import { operatorInputs, renderCalendar } from './capacity-calendar.mjs';

export function capacityCalendar({ env = process.env, now = Date.now(), settings = resolveRoutingSettings({ env }).capacity,
  capacities = observeCapacity({ env, now, settings }), horizon = false } = {}) {
  return { at: new Date(now).toISOString(), settings, providers: capacities.map(cap => ({ ...cap,
    planner: planCapacity(cap, settings, { now, queuedDemand: settings.queuedDemand ?? 0, demandRatePerHour: settings.demandRatePerHour }),
    scores: Object.fromEntries(BUILD_KINDS.map(kind => [kind, scoreProvider(cap, kind, { ...settings, now })])),
  })), plan: planLine(capacities, settings, now), burns: burnWindows(capacities, { ...settings, now }),
    needsOperatorInput: operatorInputs(capacities, settings),
    ...(horizon ? { horizon: planHorizon({ capacities, config: settings, now }) } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = capacityCalendar({ horizon: process.argv.includes('--horizon') });
  console.log(process.argv.includes('--json') ? JSON.stringify(report) : renderCalendar(report));
}
