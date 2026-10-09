/**
 * @file scripts/lib/delivery-priority.mjs
 * @description Card xjddimd (epic x8juafk, rulings Q1/Q2 of 2026-10-08) — the delivery priority class rule.
 *   ONE pure rule gives a PR or job a class P0-P4 plus an in-class score, from plain facts and declared settings.
 *   Every queue will sort by class first, then by score (slice x3r5fzx). Shape follows card 5468: a pure function,
 *   no IO, clock, network or forge strings inside; `now` and every threshold arrive as inputs; the settings' off
 *   value (mode `off`) makes every item P3 and keeps today's order.
 *
 *   Classes:
 *     P0 incident        — repairs the delivery system: owns the fix for an open main-red episode, repairs a down
 *                          service, or the operator said urgent.
 *     P1 unblocks others — stacked base of an open change, a scope waiter, or >= 2 open items blocked by it.
 *     P2 operator asked  — an operator answer or send-back waits on it.
 *     P3 normal          — default.
 *     P4 housekeeping    — changes no code, or the operator said low.
 *
 *   Operator overrides: urgent → P0, now → P1, low → P4. P1 via `now` is the operator's "build now"
 *   (ruling 2026-10-09): next free slot, never interrupts running work (only P0 does, ruling Q4).
 *
 *   Aging (Q1): waiting longer than `agingHours` moves an item up one class, never into P0.
 *   Score (Q2): `unblocks * unblockWeightMinutes + minutesWaited` — the fix-queue score in minutes.
 *   Cap: at most `maxLiveP0` derived P0 per ranked queue (oldest kept); the excess falls to P1. An operator
 *   override is never capped.
 */

export const PRIORITY_CLASSES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);
export const PRIORITY_OVERRIDE_CLASSES = Object.freeze({ urgent: 'P0', now: 'P1', low: 'P4' });
export const PRIORITY_MODES = Object.freeze(['off', 'shadow', 'enforce']);

/** The off value of every setting: today's behaviour (every item P3, order unchanged). */
export const PRIORITY_SETTINGS_OFF = Object.freeze({
  mode: 'off', agingHours: null, maxLiveP0: 2, unblockWeightMinutes: 60,
});

const classIndex = (c) => PRIORITY_CLASSES.indexOf(c);
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const positiveOrNull = (v) => (v === null ? null : (Number.isFinite(v) && v > 0 ? v : undefined));

/**
 * Validate declared settings. Each field that is missing or malformed falls back to its OFF value (fail closed).
 * @param {object} [raw]
 * @returns {{mode:'off'|'shadow'|'enforce', agingHours:number|null, maxLiveP0:number, unblockWeightMinutes:number, invalid:string[]}}
 */
export function resolvePrioritySettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...PRIORITY_SETTINGS_OFF, invalid: [] };
  if ('mode' in src) {
    if (PRIORITY_MODES.includes(src.mode)) out.mode = src.mode; else out.invalid.push('mode');
  }
  if ('agingHours' in src) {
    const v = positiveOrNull(src.agingHours);
    if (v === undefined) out.invalid.push('agingHours'); else out.agingHours = v;
  }
  if ('maxLiveP0' in src) {
    if (Number.isInteger(src.maxLiveP0) && src.maxLiveP0 >= 0) out.maxLiveP0 = src.maxLiveP0; else out.invalid.push('maxLiveP0');
  }
  if ('unblockWeightMinutes' in src) {
    if (Number.isFinite(src.unblockWeightMinutes) && src.unblockWeightMinutes >= 0) out.unblockWeightMinutes = src.unblockWeightMinutes;
    else out.invalid.push('unblockWeightMinutes');
  }
  return out;
}

/**
 * Minutes an item has waited, or 0 when `waitingSince` is absent or unreadable.
 * @param {string|number|undefined} waitingSince ISO string or epoch ms
 * @param {number} now epoch ms
 */
export function minutesWaited(waitingSince, now) {
  const t = typeof waitingSince === 'number' ? waitingSince : Date.parse(waitingSince);
  if (!Number.isFinite(t) || !Number.isFinite(now) || now < t) return 0;
  return Math.floor((now - t) / 60_000);
}

/**
 * Class one PR or job. PURE.
 *
 * Facts (all optional; a missing fact counts as absent, which can only lower a class, never raise it):
 *   - `incident`              {open:boolean, owner?:boolean} — an open main-red episode, and whether THIS change owns its fix
 *   - `repairsDownService`    boolean — repairs a delivery service that is down
 *   - `stackedDependents`     number  — open changes based on this one
 *   - `scopeWaiters`          number  — changes waiting on this one's scope
 *   - `blockedItems`          number  — open items blocked by this one
 *   - `operatorRequested`     boolean — an operator answer or send-back waits on it
 *   - `changesCode`           boolean — false: records/docs only (P4). Absent counts as true.
 *   - `override`              {value:'urgent'|'now'|'low', byOperator:boolean}
 *   - `waitingSince`          ISO string or epoch ms
 *
 * @param {object} facts
 * @param {object} settings  resolved settings (see {@link resolvePrioritySettings}); raw input is resolved here too
 * @param {number} now       epoch ms
 * @returns {{class:string, derived:string, reasons:string[], score:number, minutesWaited:number, aged:boolean, override:string|null, p0Kind:'derived'|'override'|null}}
 */
export function deliveryPriority(facts, settings, now) {
  const s = settings && Array.isArray(settings.invalid) ? settings : resolvePrioritySettings(settings);
  const f = facts && typeof facts === 'object' ? facts : {};
  const waited = minutesWaited(f.waitingSince, now);
  const unblocks = count(f.scopeWaiters) + count(f.stackedDependents);
  const score = unblocks * s.unblockWeightMinutes + waited;
  const base = { score, minutesWaited: waited, aged: false, override: null, p0Kind: null };
  if (s.mode === 'off') return { ...base, class: 'P3', derived: 'P3', reasons: ['priority off'] };

  const reasons = [];
  let derived = 'P3';
  const incidentOpen = f.incident?.open === true;
  if (incidentOpen && f.incident?.owner === true) { derived = 'P0'; reasons.push('owns the fix for the open main-red episode'); }
  else if (f.repairsDownService === true) { derived = 'P0'; reasons.push('repairs a down delivery service'); }
  else if (count(f.stackedDependents) > 0 || count(f.scopeWaiters) > 0 || count(f.blockedItems) >= 2) {
    derived = 'P1';
    if (count(f.stackedDependents) > 0) reasons.push(`${count(f.stackedDependents)} stacked change(s) wait on it`);
    if (count(f.scopeWaiters) > 0) reasons.push(`${count(f.scopeWaiters)} change(s) wait on its scope`);
    if (count(f.blockedItems) >= 2) reasons.push(`${count(f.blockedItems)} open items blocked by it`);
  } else if (f.operatorRequested === true) { derived = 'P2'; reasons.push('an operator answer waits on it'); }
  else if (f.changesCode === false) { derived = 'P4'; reasons.push('changes no code'); }
  else reasons.push('normal');

  let cls = derived;
  let aged = false;
  if (s.agingHours != null && waited >= s.agingHours * 60 && classIndex(cls) > 1) {
    cls = PRIORITY_CLASSES[classIndex(cls) - 1];
    aged = true;
    reasons.push(`waited ${waited} min >= ${s.agingHours} h: up one class`);
  }

  const ov = f.override;
  if (ov && typeof ov.value === 'string' && Object.hasOwn(PRIORITY_OVERRIDE_CLASSES, ov.value)) {
    if (ov.byOperator === true) {
      cls = PRIORITY_OVERRIDE_CLASSES[ov.value];
      reasons.push(`operator override ${ov.value}`);
      return { ...base, class: cls, derived, reasons, aged, override: ov.value, p0Kind: cls === 'P0' ? 'override' : null };
    }
    reasons.push(`override ${ov.value} ignored: not verified as operator-set`);
  }
  return { ...base, class: cls, derived, reasons, aged, p0Kind: cls === 'P0' ? 'derived' : null };
}

/**
 * Rank a whole queue: class each item, cap derived P0 at `maxLiveP0` (oldest kept, the excess falls to P1), then
 * sort by class, score (high first), wait (oldest first), id. PURE. Mode `off` keeps the input order exactly.
 * @param {Array<{id:string|number, facts:object}>} items
 * @param {object} settings
 * @param {number} now
 * @returns {Array<{id:string|number, rank:number} & ReturnType<typeof deliveryPriority>>}
 */
export function rankByDeliveryPriority(items, settings, now) {
  const s = settings && Array.isArray(settings.invalid) ? settings : resolvePrioritySettings(settings);
  const list = (Array.isArray(items) ? items : []).map((item, index) => ({
    id: item?.id, index, ...deliveryPriority(item?.facts, s, now),
  }));
  if (s.mode === 'off') return list.map(({ index, ...r }) => ({ ...r, rank: index + 1 }));
  const derivedP0 = list.filter((r) => r.p0Kind === 'derived')
    .sort((a, b) => b.minutesWaited - a.minutesWaited || String(a.id).localeCompare(String(b.id)));
  for (const r of derivedP0.slice(s.maxLiveP0)) {
    r.class = 'P1';
    r.p0Kind = null;
    r.reasons = [...r.reasons, `P0 cap ${s.maxLiveP0} reached: falls to P1`];
  }
  return list
    .sort((a, b) => classIndex(a.class) - classIndex(b.class) || b.score - a.score
      || b.minutesWaited - a.minutesWaited || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
    .map(({ index, ...r }, i) => ({ ...r, rank: i + 1 }));
}
