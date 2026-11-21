/** Pure percent-of-window planning. Clocks, observations and projected routed demand are inputs. */
export const HOUR = 3600000;
export const WORKING_HOURS = { start: '09:00', end: '20:00', tz: 'America/New_York', days: [1, 2, 3, 4, 5] };
const time = v => typeof v === 'number' ? v : Date.parse(v);
const iso = v => new Date(v).toISOString();
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const plannerWindow = cap => (cap.windows ?? []).filter(w => finite(w.usedPercent))
  .reduce((a, b) => !a || b.usedPercent > a.usedPercent ? b : a, null);
export function bankedBuckets(cap, now) {
  const buckets = cap.bankedResets ?? (cap.manualResets?.count != null ? [cap.manualResets] : []);
  return (buckets ?? []).filter(b => Number.isSafeInteger(b.count) && b.count > 0 && (!b.expiresAt || time(b.expiresAt) > now))
    .map(b => ({ ...b, expiry: b.expiresAt ? time(b.expiresAt) : Infinity })).sort((a, b) => a.expiry - b.expiry);
}

function workClock(rule) {
  try {
    if (!/^\d{2}:\d{2}$/.test(rule.start) || !/^\d{2}:\d{2}$/.test(rule.end) || rule.start >= rule.end
      || !rule.days?.length || rule.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return () => false;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: rule.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return t => {
      const p = Object.fromEntries(fmt.formatToParts(t).map(p => [p.type, p.value]));
      const hhmm = `${p.hour}:${p.minute}`;
      return rule.days.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)) && hhmm >= rule.start && hhmm < rule.end;
    };
  } catch { return () => false; }
}
/** Bounded search: invalid calendars produce an explicit operator fallback, never an outside-hours reset. */
export function workingSlot(at, direction = 1, workingHours = WORKING_HOURS) {
  const open = workClock(workingHours);
  for (let t = Math.floor(at / 60000) * 60000, i = 0; i <= 8 * 24 * 60; i++, t += direction * 60000) {
    if (open(t)) return t;
  }
  return null;
}
export function resetSlot({ at, now, usedPercent, rate, buckets = [], workingHours = WORKING_HOURS }) {
  const previous = workingSlot(at, -1, workingHours), next = workingSlot(at, 1, workingHours);
  if (previous === null || next === null) return { at: null, choice: 'operator-input', forfeitPercent: null, throttleWastePercent: null };
  if (workClock(workingHours)(at)) return { at, choice: 'natural', forfeitPercent: Math.max(0, 100 - usedPercent - rate * (at - now) / HOUR), throttleWastePercent: 0 };
  const projected = Math.min(100, usedPercent + rate * Math.max(0, previous - now) / HOUR);
  const forfeitPercent = 100 - projected;
  // Delay consumes deadline slack. Lost banked capacity is bounded by the expiring bucket sizes.
  const throttleWastePercent = buckets.reduce((sum, b) => sum + (b.expiry <= next ? b.count * 100
    : Math.min(b.count * 100, Math.max(0, b.count * 100 - rate * Math.max(0, b.expiry - next) / HOUR))), 0);
  const early = previous >= now && forfeitPercent < throttleWastePercent;
  return { at: early ? previous : next, choice: early ? 'early-reset' : 'throttle', forfeitPercent, throttleWastePercent };
}

export function planCapacity(cap, config = {}, { now = cap.now ?? Date.now(), queuedDemand = 0, demandRatePerHour = null } = {}) {
  const w = plannerWindow(cap), model = cap.windowModel ?? 'fixed';
  const hours = w ? Math.max(0, (time(w.resetsAt) - now) / HOUR) : null;
  const length = w?.lengthHours, used = w?.usedPercent;
  const target = config.fixedTargetPercent ?? 100, tolerance = config.paceTolerance ?? 10;
  const expected = finite(length) && length > 0 ? target * Math.max(0, 1 - hours / length) : null;
  const pace = expected === null ? 'unknown' : used > expected + tolerance ? 'ahead' : used < expected - tolerance ? 'behind' : 'on';
  const fixed = { pace, desiredRatePerHour: w && hours > 0 ? Math.max(0, target - used) / hours : null,
    action: pace === 'ahead' ? 'slow' : pace === 'behind' && hours <= (config.burnWindowHours ?? 24) ? 'burn' : 'normal' };
  if (model === 'rolling') {
    const allowedRatePerHour = finite(length) && length > 0 ? 100 / length : null;
    const current = demandRatePerHour ?? cap.recentRatePerHour ?? cap.currentRatePerHour ?? null;
    const pace = allowedRatePerHour === null || !finite(current) ? 'unknown' : current > allowedRatePerHour * (1 + tolerance / 100) ? 'ahead'
      : current < allowedRatePerHour * (1 - tolerance / 100) ? 'behind' : 'on';
    return { pace, allowedRatePerHour, currentRatePerHour: current, action: pace === 'ahead' ? 'slow' : pace === 'behind' ? 'use' : 'normal' };
  }
  if (model !== 'restartOnReset') return fixed;
  const buckets = bankedBuckets(cap, now), bankedCount = buckets.reduce((n, b) => n + b.count, 0);
  const currentRatePerHour = demandRatePerHour ?? cap.currentRatePerHour ?? null;
  let cumulative = 0, requiredRatePerHour = 0;
  for (const b of buckets) {
    cumulative += b.count * 100;
    if (Number.isFinite(b.expiry) && w) requiredRatePerHour = Math.max(requiredRatePerHour, (100 - used + cumulative) / ((b.expiry - now) / HOUR));
  }
  if (!w || buckets.some(b => !Number.isFinite(b.expiry))) requiredRatePerHour = null;
  const onTrack = requiredRatePerHour === null || !finite(currentRatePerHour) ? null : currentRatePerHour >= requiredRatePerHour;
  const threshold = config.resetAtPercent ?? 95, resetPlan = [], resetChoices = [];
  let at = now, projectedUsed = used, rate = currentRatePerHour;
  // Reject oversized reset inventories instead of allocating unbounded plans. Operator can split/correct the inventory.
  const incomplete = bankedCount > 1000;
  if (!incomplete && w && finite(rate) && rate > 0) for (const b of buckets) for (let i = 0; i < b.count; i++) {
    const natural = at + Math.max(0, threshold - projectedUsed) / rate * HOUR;
    const choice = resetSlot({ at: natural, now: at, usedPercent: projectedUsed, rate,
      buckets: [{ ...b, count: b.count - i }, ...buckets.slice(buckets.indexOf(b) + 1)], workingHours: config.workingHours ?? WORKING_HOURS });
    resetChoices.push({ ...choice, at: choice.at === null ? null : iso(choice.at), expiresAt: b.expiresAt ?? null });
    if (choice.at === null || choice.at >= b.expiry) continue;
    resetPlan.push(iso(choice.at)); at = choice.at; projectedUsed = 0;
  }
  const burnAggressively = bankedCount > 0 && onTrack === false;
  const boost = burnAggressively ? Math.min(config.maxBurnBoost ?? 3, requiredRatePerHour / Math.max(currentRatePerHour, 0.01) - 1) : 0;
  const canReset = w && used >= threshold && queuedDemand > 0 && bankedCount > 0;
  const open = workClock(config.workingHours ?? WORKING_HOURS)(now);
  const bankPace = requiredRatePerHour === null || !finite(currentRatePerHour) ? 'unknown'
    : currentRatePerHour < requiredRatePerHour ? 'behind'
      : currentRatePerHour > requiredRatePerHour * (1 + tolerance / 100) ? 'ahead' : 'on';
  return { ...fixed, pace: bankedCount ? bankPace : fixed.pace, action: bankedCount ? canReset && open ? 'reset-now' : 'hold-reset' : 'pace',
    pacingAction: bankedCount ? bankPace === 'behind' ? 'burn' : bankPace === 'ahead' ? 'slow' : 'normal' : fixed.action, resetPlan, resetChoices, burnAggressively, scoreBoost: boost,
    resetValue: w ? used / 100 : null, bankedCount, earliestExpiry: buckets[0]?.expiresAt ?? null, requiredRatePerHour, currentRatePerHour, onTrack,
    ...(incomplete ? { needsOperatorInput: 'reset inventory exceeds 1000; correct or split inventory' } : {}),
    ...(burnAggressively ? { pullWork: ['audits', 'red-teams', 'backlog-builds'] } : {}) };
}

/** Zoned midnight boundaries, found independently so DST days may have 23 or 25 hours. */
function horizonBoundaries(now, days, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const date = t => {
    const p = Object.fromEntries(fmt.formatToParts(t).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const first = date(now), base = Date.parse(`${first}T00:00:00Z`);
  return Array.from({ length: days + 1 }, (_, i) => {
    const label = iso(base + i * 24 * HOUR).slice(0, 10);
    let lo = base + i * 24 * HOUR - 36 * HOUR, hi = lo + 72 * HOUR;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (date(mid) < label) lo = mid; else hi = mid;
    }
    return { date: label, at: hi };
  });
}

/** Daily inventory forecast; each quota is counted once (model aliases share it). Future grants are never read.
 * Unknown windows/demand stay null. Calendar schedule observations must supply an actual next reset. */
export function planHorizon({ capacities, config = {}, demandPerDay = config.expectedDemandPerDay, days = 14, now = Date.now() }) {
  if (!Number.isInteger(days) || days < 1 || days > 90) return { days: [], recommendations: [], needsOperatorInput: ['horizon must be 1..90 days'] };
  const unique = capacities.filter(c => c.active !== false && !c.quotaOf);
  let boundaries;
  try { boundaries = horizonBoundaries(now, days, (config.workingHours ?? WORKING_HOURS).tz); }
  catch { return { days: [], recommendations: [], needsOperatorInput: ['invalid workingHours.tz; correct the calendar timezone'] }; }
  const rows = boundaries.slice(0, -1).map(b => ({ date: b.date, entries: [] }));
  for (const cap of unique) {
    const w = plannerWindow(cap), demand = typeof demandPerDay === 'number' ? demandPerDay
      : demandPerDay?.[cap.account] ?? demandPerDay?.[cap.provider] ?? null;
    const rate = finite(demand) && demand >= 0 ? demand / 24 : cap.currentRatePerHour ?? null;
    const bankPlan = planCapacity({ ...cap, windowModel: 'restartOnReset' }, config, { now, queuedDemand: 1, demandRatePerHour: rate });
    const events = bankPlan.resetChoices?.filter(c => c.at && time(c.at) < time(c.expiresAt ?? Infinity))
      .map(c => ({ at: time(c.at), type: 'banked', expiresAt: c.expiresAt, forfeitPercent: c.forfeitPercent })) ?? [];
    const endHorizon = boundaries[days].at;
    if (w && finite(w.lengthHours) && w.lengthHours > 0) {
      const banked = [...events].sort((a, b) => a.at - b.at);
      let bankIndex = 0;
      for (let at = time(w.resetsAt), n = 0; at < endHorizon && n < 1000; n++) {
        // Restarting a window invalidates its old natural reset. Fixed windows
        // keep their original calendar even when a banked reset is consumed.
        if (cap.windowModel === 'restartOnReset' && banked[bankIndex]?.at <= at) {
          at = banked[bankIndex++].at + w.lengthHours * HOUR;
        } else {
          if (at >= now) events.push({ at, type: 'scheduled' });
          at += w.lengthHours * HOUR;
        }
      }
    }
    events.sort((a, b) => a.at - b.at);
    let stock = w ? 100 - w.usedPercent : null, cursor = now, eventIndex = 0;
    for (let i = 0; i < days; i++) {
      const end = boundaries[i + 1].at, scheduled = [];
      let supply = stock, consumed = 0;
      const consume = at => {
        if (stock !== null && rate !== null) {
          const amount = Math.min(stock, rate * (at - cursor) / HOUR); stock -= amount; consumed += amount;
        }
        cursor = at;
      };
      while (eventIndex < events.length && events[eventIndex].at < end) {
        const event = events[eventIndex++]; consume(event.at);
        if (stock !== null) {
          const forfeitPercent = stock;
          supply += 100 - stock; stock = 100;
          if (event.type === 'banked') scheduled.push({ at: iso(event.at), expiresAt: event.expiresAt, forfeitPercent });
        }
      }
      consume(end);
      // Sliding windows release quota continuously at their allowed rate; no artificial periodic grant.
      if (cap.windowModel === 'rolling') {
        supply = w && finite(w.lengthHours) && w.lengthHours > 0 ? Math.min(100, 2400 / w.lengthHours) : null;
      }
      rows[i].entries.push({ provider: cap.provider, account: cap.account ?? null, available: supply,
        expectedDemand: demand, bankedConsumed: scheduled,
        shortfall: supply === null || rate === null || !finite(demand) ? null : cap.windowModel === 'rolling' ? demand > supply : consumed + 1e-8 < demand * (end - Math.max(now, boundaries[i].at)) / (24 * HOUR) });
    }
  }
  const recommendations = [];
  for (const inactive of capacities.filter(c => c.active === false && !c.quotaOf)) {
    let consecutive = 0;
    for (let i = 0; i < days; i++) {
      const start = Math.max(now, boundaries[i].at), rule = config.workingHours ?? WORKING_HOURS;
      let weekday;
      try { weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: rule.tz, weekday: 'short' }).format(start)); } catch { continue; }
      if (!rule.days?.includes(weekday)) continue;
      const entries = rows[i].entries.filter(e => e.provider === inactive.provider);
      const known = entries.length && entries.every(e => e.available !== null && finite(e.expectedDemand));
      const short = known && entries.some(e => e.shortfall);
      consecutive = short ? consecutive + 1 : 0;
      if (consecutive >= (config.activateAfterShortfallDays ?? 3)) {
        recommendations.push({ action: 'activate-account', provider: inactive.provider, account: inactive.account, command: `activate ${inactive.account}`, date: rows[i].date }); break;
      }
    }
  }
  return { days: rows, recommendations };
}
