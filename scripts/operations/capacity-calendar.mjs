/** Read-only quota calendar and burn planner. `run.mjs capacity-calendar [--json]` also exposes this report. */
import { pathToFileURL } from 'node:url';
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { BUILD_KINDS, resolveRoutingSettings } from '../lib/routing-settings.mjs';
import { observeCapacity } from '../lib/provider-capacity-io.mjs';
import { scoreProvider, burnWindows, planLine } from '../lib/provider-capacity.mjs';

export function capacityCalendar({ env = process.env, now = Date.now(), settings = resolveRoutingSettings({ env }).capacity,
  capacities = observeCapacity({ env, now, settings }) } = {}) {
  return { at: new Date(now).toISOString(), settings, providers: capacities.map(cap => ({ ...cap,
    scores: Object.fromEntries(BUILD_KINDS.map(kind => [kind, scoreProvider(cap, kind, { ...settings, now })])),
  })), plan: planLine(capacities, settings, now), burns: burnWindows(capacities, { ...settings, now }) };
}
export function renderCalendar(report) {
  return report.providers.map(cap => {
    const windows = cap.windows.map(w => `${w.name}: ${w.usedPercent ?? 'unknown'}% used, resets in ${((w.resetsAt - Date.parse(report.at)) / 3600000).toFixed(1)}h (${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(w.resetsAt)}), ${w.source}`).join('; ') || 'unknown';
    return `${cap.provider}: ${windows}\n  ${Object.entries(cap.scores).map(([k, v]) => `${k}=${v.score?.toFixed(3) ?? v.label}`).join(' ')}`;
  }).concat(report.plan, `burn windows: ${JSON.stringify(report.burns)}`).join('\n');
}
export const capacityCalendarOperation = () => op('capacity-calendar', { input: {}, verdictFrom: 'read',
  read: compute({ reads: [], fn: () => capacityCalendar() }),
});
export const finishCapacityCalendar = ({ run, code, lines, json }) => json || !run?.verdict ? { code, lines } : { code, lines: [renderCalendar(run.verdict)] };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = capacityCalendar();
  console.log(process.argv.includes('--json') ? JSON.stringify(report) : renderCalendar(report));
}
