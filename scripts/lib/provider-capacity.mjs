/** Pure capacity arithmetic. All observations and clocks are supplied by the caller; times are epoch ms. */
import { planCapacity } from './capacity-planner.mjs';
import defaults from '../settings/provider-capacity.json' with { type: 'json' };
export const PROVIDER_DEFAULTS = defaults.providerCapacity;
export const PROVIDERS = PROVIDER_DEFAULTS.providers.map(p => p.id);
export const CAPACITY_DEFAULTS = {
  staleHours: 6, rateLookbackHours: 24, exhaustedPercent: 98, urgencyWeight: 4, urgencyHorizonHours: 24,
  reserveReleaseHours: 6, fixedTargetPercent: 100, paceTolerance: 10,
  aheadPenalty: 0.7, behindBoost: 1.2, burnWindowHours: 24, burnUnusedPercent: 40,
  longKinds: [], resetAtPercent: 95, maxBurnBoost: 3,
  workingHours: { start: '09:00', end: '20:00', tz: 'America/New_York', days: [1, 2, 3, 4, 5] },
  claudeUsageAccount: null, expectedDemandPerDay: null, activateAfterShortfallDays: 3,
  criticalKinds: ['critical', 'security', 'audit', 'audit-full'], allowUnknownEmergency: false,
};
const HOUR = 3600000;
const lengths = { five_hour: 5, seven_day: 168, daily: 24, weekly: 168 };
const epoch = v => typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
const options = s => ({ ...CAPACITY_DEFAULTS, ...(s?.routing?.capacity ?? s ?? {}) });
export const bindingWindow = cap => cap.windows.filter(w => Number.isFinite(w.usedPercent))
  .reduce((a, b) => !a || b.usedPercent > a.usedPercent ? b : a, null);

/** Bounded minute search handles IANA zones, DST gaps/folds and half-hour offsets without a dependency. */
export function calendarReset(rule, now) {
  const match = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?(\d{2}):(\d{2}) (\S+)$/.exec(rule ?? '');
  if (!match || +match[2] > 23 || +match[3] > 59) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: match[4], weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (let t = Math.floor(now / 60000) * 60000 + 60000, end = t + 8 * 24 * HOUR; t < end; t += 60000) {
      const p = Object.fromEntries(fmt.formatToParts(t).map(p => [p.type, p.value]));
      if ((!match[1] || p.weekday === match[1]) && p.hour === match[2] && p.minute === match[3]) return t;
    }
  } catch { /* malformed calendars remain unknown */ }
  return null;
}

/** Expand models into account observations; aliases inherit the owner's readings and inventory. */
export function readProviderCapacity({ env = {}, now = Date.now(), readers = {}, settings = {} } = {}) {
  const s = options(settings), providers = settings.providers ?? PROVIDER_DEFAULTS.providers;
  return providers.flatMap(entry => {
    const owner = providers.find(p => p.id === entry.quotaOf) ?? entry;
    return (owner.accounts ?? [{ id: owner.id }]).map(account => {
      const def = { ...owner, ...entry, ...account }, windows = [];
      let raw;
      try { raw = readers[account.id]?.(env) ?? readers[owner.id]?.(env); } catch { /* unknown */ }
      // The shared Claude file cannot identify an account. Never attribute it to both accounts.
      if (owner.id === 'claude' && owner.accounts && s.claudeUsageAccount !== account.id) raw = null;
      const at = epoch(raw?.at ?? raw?.asOf ?? raw?.mtime);
      const seed = def.operatorReading, seedAt = epoch(seed?.asOf);
      const liveUsable = owner.readers?.some(r => r.type === 'codex-rollout') || (at <= now && now - at <= s.staleHours * HOUR);
      const add = (name, w, source = 'live') => {
        const usedPercent = w?.usedPercent ?? w?.used_percent ?? w?.used_percentage;
        const resetsAt = epoch(w?.resetsAt ?? w?.resets_at);
        const configured = def.windows?.find(x => x.name === name || (['weekly', 'seven_day'].includes(name) && ['weekly', 'seven_day'].includes(x.name)));
        if (typeof usedPercent === 'number' && usedPercent >= 0 && usedPercent <= 100 && resetsAt > now) windows.push({ name, usedPercent, resetsAt, source,
          lengthHours: w.lengthHours ?? (w.window_minutes > 0 ? w.window_minutes / 60 : null) ?? configured?.lengthHours ?? lengths[name] ?? null });
      };
      if (seed && seedAt <= now && (!raw || !Number.isFinite(at) || at < seedAt)) add(def.windows?.[0]?.name ?? 'weekly', seed, 'operator');
      else if (liveUsable) {
        if (owner.readers?.some(r => r.type === 'codex-rollout')) {
          const name = (w, fallback) => w?.window_minutes > 0
            ? def.windows?.find(x => x.lengthHours * 60 === w.window_minutes)?.name
              ?? ({ 10080: 'weekly', 300: 'five_hour' })[w.window_minutes] ?? `${w.window_minutes}_minutes`
            : fallback;
          add(name(raw, def.readers?.find(r => r.window)?.window ?? def.windows?.[0]?.name ?? 'five_hour'), raw);
          add(name(raw?.secondary, 'weekly'), raw?.secondary);
        } else {
          add('five_hour', raw?.five_hour); add('seven_day', raw?.seven_day);
          for (const w of raw?.windows ?? []) add(w.name, w);
          for (const spec of def.readers ?? []) if (spec.window) add(spec.window, raw);
        }
      }
      if (!windows.length) for (const [name, rule] of Object.entries(def.calendar ?? s.calendar?.[owner.id] ?? {})) {
        const resetsAt = calendarReset(rule, now);
        if (resetsAt) windows.push({ name, usedPercent: null, resetsAt, source: 'configured', lengthHours: lengths[name] ?? null });
      }
      let held = false;
      try { held = Boolean(readers.hold?.(owner.id, now)); } catch { held = true; }
      return { ...def, provider: entry.id, account: account.id, configuredWindows: def.windows, windows, held, health: held ? 0 : 1,
        known: windows.some(w => Number.isFinite(w.usedPercent)), now };
    });
  });
}

export function scoreProvider(cap, kind, settings = {}) {
  const s = options(settings), now = settings.now ?? cap.now ?? Date.now();
  const w = bindingWindow(cap), hoursToReset = w ? Math.max(0, (w.resetsAt - now) / HOUR) : null;
  const critical = s.criticalKinds.includes(kind) || /security|critical|audit/.test(kind);
  const reserved = cap.windows.filter(w => Number.isFinite(w.usedPercent)).map(w =>
    w.usedPercent + (!critical && (w.resetsAt - now) / HOUR > s.reserveReleaseHours ? (cap.reservePercent ?? 10) : 0));
  const usedPercent = w?.usedPercent ?? null, effectiveUsed = reserved.length ? Math.max(...reserved) : null;
  const spare = effectiveUsed === null ? null : Math.max(0, 1 - effectiveUsed / 100);
  const urgency = hoursToReset === null ? 1 : 1 + s.urgencyWeight * Math.max(0, 1 - hoursToReset / s.urgencyHorizonHours);
  const def = (settings.providers ?? PROVIDER_DEFAULTS.providers).find(p => p.id === cap.provider);
  const minimumTier = settings.minimumTiers?.[settings.routeKey ?? kind] ?? PROVIDER_DEFAULTS.minimumTiers[settings.routeKey ?? kind] ?? 0;
  const fit = (cap.tier ?? def?.tier ?? 0) >= minimumTier ? 1 : 0;
  const planner = planCapacity(cap, s, { now, queuedDemand: settings.queuedDemand ?? 0, demandRatePerHour: settings.demandRatePerHour });
  const pace = planner.pace;
  const burn = planner.action === 'burn' || planner.pacingAction === 'burn' || planner.burnAggressively;
  const paceFactor = (pace === 'ahead' ? s.aheadPenalty : burn || pace === 'behind' ? s.behindBoost : 1) * (1 + (planner.scoreBoost ?? 0));
  const label = cap.active === false ? 'inactive' : cap.held ? 'held' : !w || w.resetsAt <= now ? 'unknown' : usedPercent >= s.exhaustedPercent ? 'exhausted'
    : !fit ? 'tier-excluded' : effectiveUsed >= 100 ? 'reserve-only' : pace === 'ahead' ? 'ahead' : pace === 'behind' ? 'behind' : 'normal';
  const excluded = ['inactive', 'held', 'unknown', 'exhausted', 'tier-excluded', 'reserve-only'].includes(label);
  const remaining = spare * hoursToReset;
  return { provider: cap.provider, account: cap.account ?? null, planner, model: cap.model ?? def?.model, launcher: cap.launcher ?? def?.launcher, usedPercent, effectiveUsed, resetsAt: w?.resetsAt ?? null,
    spare, urgency, health: cap.health, fit, pace, paceFactor, remaining, label,
    score: excluded ? null : spare * urgency * cap.health * fit * paceFactor * (s.longKinds.includes(kind) ? remaining : 1) };
}

export function chooseBuilder({ kind = 'build', capacities, settings = {}, fallback }) {
  const s = options(settings);
  const inputs = capacities.map(cap => {
    const def = (settings.providers ?? PROVIDER_DEFAULTS.providers).find(p => p.id === cap.provider);
    return { ...scoreProvider(cap, kind, settings), allowed: cap.active !== false && (cap.allowedKinds ?? def?.allowedKinds ?? []).includes(kind), emergencyOnly: cap.emergencyOnly ?? def?.emergencyOnly };
  });
  const ranked = inputs.filter(i => i.allowed && !i.emergencyOnly && i.score !== null).sort((a, b) => b.score - a.score);
  if (ranked.length) return { provider: ranked[0].provider, account: ranked[0].account, model: ranked[0].model, launcher: ranked[0].launcher, reason: 'capacity-score', inputs };
  const emergency = inputs.find(i => i.emergencyOnly && i.allowed && i.label === 'unknown' && i.fit);
  if (emergency && s.allowUnknownEmergency) return { provider: emergency.provider, account: emergency.account, reason: 'unknown-emergency', inputs };
  if (!capacities.some(c => c.known) && !capacities.some(c => c.held) && inputs.some(i => i.provider === fallback && i.allowed && i.fit && i.label === 'unknown')) return { provider: fallback, reason: 'all-readers-unknown', inputs };
  return { provider: null, reason: 'no-eligible-capacity', inputs };
}

export function burnWindows(capacities, settings = {}) {
  return capacities.flatMap(cap => {
    const w = bindingWindow(cap), now = settings.now ?? cap.now ?? Date.now();
    const planner = planCapacity(cap, options(settings), { now, queuedDemand: settings.queuedDemand ?? 0, demandRatePerHour: settings.demandRatePerHour });
    if (cap.active === false || cap.held || !w || w.resetsAt <= now) return [];
    const detail = { provider: cap.provider, account: cap.account ?? null, usedPercent: w.usedPercent, resetsAt: w.resetsAt };
    return [
      ...(planner.burnAggressively || planner.action === 'burn' || planner.pacingAction === 'burn' ? [{ ...detail, kind: 'capacity-burn-window', ...(planner.pullWork ? { pullWork: planner.pullWork } : {}) }] : []),
      ...(planner.action === 'reset-now' ? [{ ...detail, kind: 'capacity-reset-recommended', resetsLeft: planner.bankedCount }] : []),
    ];
  });
}

export function planLine(capacities, settings = {}, now = Date.now()) {
  const burns = burnWindows(capacities, { ...settings, now });
  return capacities.map(cap => {
    const w = bindingWindow(cap) ?? cap.windows[0], input = scoreProvider(cap, 'build', { ...settings, now });
    const hours = w ? Math.max(0, (w.resetsAt - now) / HOUR) : null;
    const reset = !w ? 'unknown' : hours <= 24 ? `in ${Math.round(hours * 10) / 10}h` :
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(w.resetsAt);
    const label = burns.some(b => b.provider === cap.provider && b.account === (cap.account ?? null)) ? 'burn' : input.label;
    return `${cap.account && cap.account !== cap.provider && !cap.quotaOf ? cap.account : cap.provider}: ${w?.usedPercent ?? 'unknown'}% used, resets ${reset} -> ${label}`;
  }).join('; ');
}
