/** Pure capacity arithmetic. All observations and clocks are supplied by the caller; times are epoch ms. */
export const PROVIDERS = ['codex', 'claude', 'agy-gemini', 'agy-claude'];
export const CAPACITY_DEFAULTS = {
  staleHours: 6, exhaustedPercent: 98, urgencyWeight: 4, urgencyHorizonHours: 24,
  reservePercent: 10, reserveReleaseHours: 6, targetPercent: 95, paceTolerance: 10,
  aheadPenalty: 0.7, behindBoost: 1.2, burnWindowHours: 4, burnUnusedPercent: 40,
  calendar: {}, tiers: {}, kindMinTier: {}, allowed: {}, longKinds: [],
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

export function readProviderCapacity({ env = {}, now = Date.now(), readers = {}, settings = {} } = {}) {
  const s = options(settings);
  return PROVIDERS.map(provider => {
    let raw;
    try { raw = readers[provider]?.(env); } catch { /* unknown */ }
    const windows = [];
    const add = (name, w) => {
      const usedPercent = w?.used_percent ?? w?.used_percentage;
      const resetsAt = epoch(w?.resets_at);
      if (typeof usedPercent === 'number' && usedPercent >= 0 && usedPercent <= 100 && resetsAt > now) {
        windows.push({ name, usedPercent, resetsAt, source: 'live', lengthHours: w.window_minutes / 60 || lengths[name] });
      }
    };
    if (provider === 'codex') { add('five_hour', raw); add('seven_day', raw?.secondary); }
    else if (provider !== 'agy-claude') {
      const at = epoch(raw?.at ?? raw?.mtime);
      if (at <= now && now - at <= s.staleHours * HOUR) {
        add('five_hour', raw?.five_hour); add('seven_day', raw?.seven_day);
      }
    }
    if (!windows.length) for (const [name, rule] of Object.entries(s.calendar[provider] ?? {})) {
      const resetsAt = calendarReset(rule, now);
      if (resetsAt) windows.push({ name, usedPercent: null, resetsAt, source: 'configured', lengthHours: lengths[name] });
    }
    let held = false;
    try { held = Boolean(readers.hold?.(provider, now)); } catch { held = true; }
    // Scorecards have model/rubric-specific quality scores, no cheap provider error-rate reader.
    return { provider, windows, held, health: held ? 0 : 1, known: windows.some(w => Number.isFinite(w.usedPercent)), now };
  });
}

export function scoreProvider(cap, kind, settings = {}) {
  const s = options(settings), now = settings.now ?? cap.now ?? Date.now();
  const w = bindingWindow(cap), hoursToReset = w ? Math.max(0, (w.resetsAt - now) / HOUR) : null;
  const critical = s.criticalKinds.includes(kind) || /security|critical|audit/.test(kind);
  const reserved = cap.windows.filter(w => Number.isFinite(w.usedPercent)).map(w =>
    w.usedPercent + (!critical && (w.resetsAt - now) / HOUR > s.reserveReleaseHours ? s.reservePercent : 0));
  const usedPercent = w?.usedPercent ?? null, effectiveUsed = reserved.length ? Math.max(...reserved) : null;
  const spare = effectiveUsed === null ? null : Math.max(0, 1 - effectiveUsed / 100);
  const urgency = hoursToReset === null ? 1 : 1 + s.urgencyWeight * Math.max(0, 1 - hoursToReset / s.urgencyHorizonHours);
  const fit = (s.tiers[cap.provider] ?? 0) >= (s.kindMinTier[kind] ?? 0) ? 1 : 0;
  const expected = w ? s.targetPercent * Math.max(0, 1 - hoursToReset / (w.lengthHours || lengths[w.name] || 5)) : null;
  const pace = w ? usedPercent - expected : null;
  const paceFactor = pace > s.paceTolerance ? s.aheadPenalty : pace < -s.paceTolerance ? s.behindBoost : 1;
  const label = cap.held ? 'held' : !w || w.resetsAt <= now ? 'unknown' : usedPercent >= s.exhaustedPercent ? 'exhausted'
    : !fit ? 'tier-excluded' : effectiveUsed >= 100 ? 'reserve-only' : pace > s.paceTolerance ? 'ahead' : pace < -s.paceTolerance ? 'behind' : 'normal';
  const excluded = ['held', 'unknown', 'exhausted', 'tier-excluded', 'reserve-only'].includes(label);
  const remaining = spare * hoursToReset;
  return { provider: cap.provider, usedPercent, effectiveUsed, resetsAt: w?.resetsAt ?? null,
    spare, urgency, health: cap.health, fit, pace, paceFactor, remaining, label,
    score: excluded ? null : spare * urgency * cap.health * fit * paceFactor * (s.longKinds.includes(kind) ? remaining : 1) };
}

export function chooseBuilder({ kind = 'build', capacities, settings = {}, fallback }) {
  const s = options(settings), allowed = s.allowed[kind] ?? ['codex', 'claude'];
  const inputs = capacities.map(cap => ({ ...scoreProvider(cap, kind, settings), allowed: allowed.includes(cap.provider) }));
  const ranked = inputs.filter(i => i.allowed && i.provider !== 'agy-claude' && i.score !== null).sort((a, b) => b.score - a.score);
  if (ranked.length) return { provider: ranked[0].provider, reason: 'capacity-score', inputs };
  const emergency = inputs.find(i => i.provider === 'agy-claude' && i.allowed && i.label === 'unknown' && i.fit);
  if (emergency && s.allowUnknownEmergency) return { provider: emergency.provider, reason: 'unknown-emergency', inputs };
  if (!capacities.some(c => c.known) && !capacities.some(c => c.held)) return { provider: fallback, reason: 'all-readers-unknown', inputs };
  return { provider: null, reason: 'no-eligible-capacity', inputs };
}

export function burnWindows(capacities, settings = {}) {
  const s = options(settings);
  return capacities.flatMap(cap => {
    const w = bindingWindow(cap), now = settings.now ?? cap.now ?? Date.now();
    return !cap.held && w && w.resetsAt > now && w.resetsAt - now <= s.burnWindowHours * HOUR && 100 - w.usedPercent > s.burnUnusedPercent
      ? [{ provider: cap.provider, usedPercent: w.usedPercent, resetsAt: w.resetsAt }] : [];
  });
}

export function planLine(capacities, settings = {}, now = Date.now()) {
  const burns = burnWindows(capacities, { ...settings, now });
  return capacities.map(cap => {
    const w = bindingWindow(cap) ?? cap.windows[0], input = scoreProvider(cap, 'build', { ...settings, now });
    const hours = w ? Math.max(0, (w.resetsAt - now) / HOUR) : null;
    const reset = !w ? 'unknown' : hours <= 24 ? `in ${Math.round(hours * 10) / 10}h` :
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(w.resetsAt);
    const label = burns.some(b => b.provider === cap.provider) ? 'burn' : input.label;
    return `${cap.provider}: ${w?.usedPercent ?? 'unknown'}% used, resets ${reset} -> ${label}`;
  }).join('; ');
}
