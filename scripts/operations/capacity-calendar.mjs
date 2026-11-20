/** Read-only quota calendar declaration; the runner supplies all host observations. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
export function operatorInputs(capacities, settings) {
  const missing = [];
  for (const c of capacities) {
    if (c.quotaOf) continue;
    const key = `${c.provider}/${c.account ?? c.id}`;
    if (c.operatorReadingStale) missing.push(`${key}: operator reading stale — refresh`);
    if (!c.known) missing.push(`${key}: usage unknown; supply a live reading or operatorReading`);
    if (c.provider === 'claude' && !settings.claudeUsageAccount) missing.push(`${key}: shared claude-usage.json account unknown (set routing.capacity.claudeUsageAccount)`);
    if (c.resetSchedule === null) missing.push(`${key}: resetSchedule`);
    for (const w of c.windows ?? []) if (!Number.isFinite(w.lengthHours)) missing.push(`${key}: ${w.name} lengthHours`);
    if (!c.windows?.length) for (const w of c.configuredWindows ?? []) if (w.lengthHours === null) missing.push(`${key}: ${w.name} lengthHours`);
    if (c.bankedResets === null) missing.push(`${key}: bankedResets count and expiry`);
    for (const [i, b] of (c.bankedResets ?? (c.manualResets ? [c.manualResets] : [])).entries()) {
      if (b.count === null) missing.push(`${key}: reset bucket ${i + 1} count`);
      if (b.expiresAt == null) missing.push(`${key}: reset bucket ${i + 1} expiry`);
    }
  }
  if (settings.expectedDemandPerDay == null) missing.push('routing.capacity.expectedDemandPerDay (horizon demand unknown)');
  return missing;
}
export function renderCalendar(report) {
  return report.providers.map(cap => {
    const windows = cap.windows.map(w => `${w.name}: ${w.usedPercent ?? 'unknown'}% used, resets in ${((w.resetsAt - Date.parse(report.at)) / 3600000).toFixed(1)}h (${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(w.resetsAt)}), ${w.source}`).join('; ') || 'unknown';
    const p = cap.planner;
    const planning = `${cap.windowModel ?? 'fixed'}: ${p.action}; reset plan ${JSON.stringify(p.resetPlan ?? [])}`;
    const bank = p.bankedCount === undefined ? '' : `; banked ${p.bankedCount}, earliest expiry ${p.earliestExpiry ?? 'unknown'}, required ${p.requiredRatePerHour ?? 'unknown'} vs current ${p.currentRatePerHour ?? 'unknown'} %/h, on-track ${p.onTrack === null ? 'unknown' : p.onTrack ? 'yes' : 'no'}`;
    return `${cap.provider}${cap.account ? '/' + cap.account : ''}: ${windows}\n  ${planning}${bank}\n  reset choices: ${JSON.stringify(p.resetChoices ?? [])}\n  ${Object.entries(cap.scores).map(([k, v]) => `${k}=${v.score?.toFixed(3) ?? v.label}`).join(' ')}`;
  }).concat(report.plan, `burn windows: ${JSON.stringify(report.burns)}`, `needs operator input: ${(report.needsOperatorInput ?? []).join('; ') || 'none'}`, ...(report.horizon ? [renderHorizon(report.horizon)] : [])).join('\n');
}
export function renderHorizon(horizon) {
  return ['14-day horizon: date | provider/account | available % | expected demand %', ...horizon.days.flatMap(day => day.entries.map(e => `${day.date} | ${e.provider}/${e.account ?? '-'} | ${e.available ?? 'unknown'} | ${e.expectedDemand ?? 'unknown'}`)), ...horizon.recommendations.map(r => `${r.date}: ${r.command}`), ...(horizon.needsOperatorInput ?? []).map(message => `needs operator input: ${message}`)].join('\n');
}
export function capacityCalendarOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('capacity-calendar needs a collect reader');
  return op('capacity-calendar', {
    input: { horizon: { type: 'boolean', required: false, default: false } },
    verdictFrom: 'read',
    read: compute({ reads: ['input.horizon'], fn: ({ input }) => collect({ horizon: input?.horizon ?? false }) }),
  });
}
export const finishCapacityCalendar = ({ run, code, lines, json }) => json || !run?.verdict ? { code, lines } : { code, lines: [renderCalendar(run.verdict)] };
