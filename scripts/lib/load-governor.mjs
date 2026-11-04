/**
 * @file we:scripts/lib/load-governor.mjs
 * R480 load governor. The 1-min load per core is a CEILING: above `targetLoadPerCore` new heavy jobs from owners at or
 * below `holdFromClass` are held (reason `load-governor`) and those owners get a pause flag; both clear once load is
 * under `resumeBelowPerCore` (hysteresis, no flapping). Running jobs are never killed. Unreadable load fails open
 * (today's behaviour) but is reported, never silent. Pure functions take their IO; the thin fs helpers are at the end.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const GOVERNOR_REASON = 'load-governor';
export const GOVERNOR_DEFAULTS = Object.freeze({
  enabled: true, targetLoadPerCore: 2, resumeBelowPerCore: 1.6, holdFromClass: 'daemon-fix',
  maxPauseMinutes: 90,
  priority: Object.freeze(['main-fix', 'delivery-unblock', 'daemon-fix', 'build', 'report']),
  classPatterns: Object.freeze({
    'main-fix': ['main-fix', 'red-main', 'repair'], 'delivery-unblock': ['unblock', 'drain', 'land', 'conflict'],
    'daemon-fix': ['daemon', 'prototype'], report: ['report', 'metrics', 'bottleneck', 'stray-process', 'coroner', 'audit-sweep'],
  }),
});

const pos = (v) => Number.isFinite(v) && v > 0;
/** PURE: standard -> repo settings (`settings.loadGovernor`) -> env. Invalid leaves are ignored. */
export function resolveGovernorSettings({ settings, env = {} } = {}) {
  const r = { ...GOVERNOR_DEFAULTS, classPatterns: { ...GOVERNOR_DEFAULTS.classPatterns }, priority: [...GOVERNOR_DEFAULTS.priority] };
  const s = settings?.loadGovernor ?? {};
  if (typeof s.enabled === 'boolean') r.enabled = s.enabled;
  for (const k of ['targetLoadPerCore', 'resumeBelowPerCore']) if (pos(s[k])) r[k] = s[k];
  if (Number.isFinite(s.maxPauseMinutes) && s.maxPauseMinutes >= 1) r.maxPauseMinutes = s.maxPauseMinutes; // a sub-minute TTL would make every pause a no-op
  if (Array.isArray(s.priority) && s.priority.length && s.priority.every((x) => typeof x === 'string')) r.priority = [...s.priority];
  const explicitCutoff = typeof s.holdFromClass === 'string' && r.priority.includes(s.holdFromClass);
  if (explicitCutoff) r.holdFromClass = s.holdFromClass;
  if (s.classPatterns && typeof s.classPatterns === 'object' && !Array.isArray(s.classPatterns)) {
    for (const [c, p] of Object.entries(s.classPatterns)) {
      if (c === '__proto__') continue; // assigning it would swap the prototype instead of adding a class
      if (Array.isArray(p) && p.length && p.every((x) => typeof x === 'string' && x.trim())) r.classPatterns[c] = p; // a blank pattern matches every owner
    }
  }
  // No usable cutoff given: resolve one that exists in the resulting priority list (the default if it is there and reachable,
  // else the first reachable non-exempt class) instead of discarding the whole priority override.
  if (!explicitCutoff) {
    // never the highest-priority class by accident: default cutoff, else the fallback class, else the LOWEST reachable class
    const ok = (c) => r.priority.includes(c) && !ALWAYS_EXEMPT.includes(c) && isReachable(c, r);
    const cand = [GOVERNOR_DEFAULTS.holdFromClass, fallbackClass(r), ...[...r.priority].reverse()].find(ok);
    if (cand) r.holdFromClass = cand;
  }
  const t = Number(env.WE_LOAD_GOVERNOR_TARGET); if (pos(t)) r.targetLoadPerCore = t;
  const rs = Number(env.WE_LOAD_GOVERNOR_RESUME); if (pos(rs)) r.resumeBelowPerCore = rs;
  if (env.WE_LOAD_GOVERNOR_ENABLED === '0') r.enabled = false;
  if (!(r.resumeBelowPerCore < r.targetLoadPerCore)) r.resumeBelowPerCore = r.targetLoadPerCore * 0.8; // band can't invert or collapse (would flap)
  // Individually valid priority/cutoff/patterns that jointly leave NO class both holdable and reachable would report "holding"
  // while pausing nothing: ignore that whole override set and use the defaults.
  if (!r.priority.includes(r.holdFromClass) || !r.priority.some((c) => isHoldable(c, r) && isReachable(c, r))) {
    r.priority = [...GOVERNOR_DEFAULTS.priority]; r.holdFromClass = GOVERNOR_DEFAULTS.holdFromClass;
    r.classPatterns = { ...GOVERNOR_DEFAULTS.classPatterns };
  }
  return r;
}

/** PURE: the owner's class from its owner/purpose/session text; first class in priority order that matches, else build. */
export function ownerClass(text, settings = GOVERNOR_DEFAULTS) {
  const t = String(text ?? '').toLowerCase();
  // exempt classes are scanned first even when a priority override omits them, so no setting can make them holdable
  for (const c of new Set([...ALWAYS_EXEMPT, ...settings.priority])) if (patternsOf(settings, c).some((p) => t.includes(p.toLowerCase()))) return c;
  return fallbackClass(settings);
}
/** Own-property lookup only: a class named `constructor`/`toString` must not read inherited Object members. */
const patternsOf = (settings, c) => (Object.hasOwn(settings.classPatterns ?? {}, c) && Array.isArray(settings.classPatterns[c]) ? settings.classPatterns[c] : []);
const fallbackClass = (settings) => (settings.priority.includes('build') ? 'build' : settings.priority[settings.priority.length - 1]);
/** Can some owner text classify as `c`? As the fallback class, or via a pattern no earlier class's pattern shadows
 *  (a text containing p also contains whatever shorter pattern of an earlier class p contains, so probing p itself is exact). */
const isReachable = (c, settings) => fallbackClass(settings) === c || patternsOf(settings, c).some((p) => ownerClass(p, settings) === c);
export const classRank = (c, settings = GOVERNOR_DEFAULTS) => { const i = settings.priority.indexOf(c); return i < 0 ? settings.priority.length : i; };
/** PURE: is this class below the exemption cutoff (so subject to holds and pauses)? */
export const ALWAYS_EXEMPT = Object.freeze(['main-fix', 'delivery-unblock']); // no setting may hold or pause these
export const isHoldable = (c, settings = GOVERNOR_DEFAULTS) => !ALWAYS_EXEMPT.includes(c) && classRank(c, settings) >= classRank(settings.holdFromClass, settings);

/**
 * PURE hysteresis step. `holding` is the previous state. Returns { holding, unreadable, reason }.
 * Unreadable load fails open (holding=false) and says so.
 */
export function governorState({ loadPerCore, holding = false, settings = GOVERNOR_DEFAULTS }) {
  if (!settings.enabled) return { holding: false, unreadable: false, reason: 'disabled' };
  if (!Number.isFinite(loadPerCore)) return { holding: false, unreadable: true, reason: 'load-unreadable (fail open)' };
  if (loadPerCore > settings.targetLoadPerCore) return { holding: true, unreadable: false, reason: `load/core ${loadPerCore.toFixed(2)} > target ${settings.targetLoadPerCore}` };
  if (holding && loadPerCore >= settings.resumeBelowPerCore) return { holding: true, unreadable: false, reason: `load/core ${loadPerCore.toFixed(2)} not yet below resume ${settings.resumeBelowPerCore}` };
  return { holding: false, unreadable: false, reason: `load/core ${loadPerCore.toFixed(2)} ok` };
}

/** PURE: should a NEW heavy job from `text` be held right now? Exempt classes are never held. */
export function shouldHold({ text, holding, settings = GOVERNOR_DEFAULTS }) {
  const cls = ownerClass(text, settings);
  return { hold: Boolean(holding) && isHoldable(cls, settings), cls, reason: GOVERNOR_REASON };
}

/** PURE: release order for held waiters: priority class, then arrival (`at`). */
export function releaseOrder(waiters, settings = GOVERNOR_DEFAULTS) {
  return waiters.map((w, i) => ({ w, i, r: classRank(ownerClass(w.text ?? w.owner, settings), settings) }))
    .sort((a, b) => a.r - b.r || (Date.parse(a.w.at) || 0) - (Date.parse(b.w.at) || 0) || a.i - b.i).map((x) => x.w);
}

// ── pause flags: <dir>/<owner> = {reason, at, resumeWhen, by} ──────────────────────────────────────────────────────
export const defaultPauseDir = (home = homedir()) => join(home, '.claude', 'conveyor', 'pause');
const safe = (o) => String(o).replace(/[^A-Za-z0-9._-]/g, '_');
/** An owner name usable as a flag file: a non-blank string whose on-disk name is not the pause dir (`.`) or its parent (`..`). */
export const validOwner = (o) => typeof o === 'string' && o.trim() !== '' && !['.', '..'].includes(safe(o));

export function setPause({ dir = defaultPauseDir(), owner, reason, resumeWhen = 'load below resumeBelowPerCore', by = 'operator', now = new Date() }) {
  mkdirSync(dir, { recursive: true });
  const flag = { reason, at: now.toISOString(), resumeWhen, by };
  writeFileSync(join(dir, safe(owner)), JSON.stringify(flag) + '\n');
  return flag;
}
/** Read one flag; a flag older than maxPauseMinutes is expired (returned as null) so a paused worker never waits forever. */
export function readPause({ dir = defaultPauseDir(), owner, maxPauseMinutes = GOVERNOR_DEFAULTS.maxPauseMinutes, now = new Date() }) {
  let f; try { f = JSON.parse(readFileSync(join(dir, safe(owner)), 'utf8')); } catch { return null; }
  const age = now.getTime() - Date.parse(f?.at);
  if (!Number.isFinite(age) || age > maxPauseMinutes * 60_000) return null;
  return f;
}
export function clearPause({ dir = defaultPauseDir(), owner }) { try { rmSync(join(dir, safe(owner))); return true; } catch { return false; } }
export function listPauses({ dir = defaultPauseDir(), maxPauseMinutes = GOVERNOR_DEFAULTS.maxPauseMinutes, now = new Date() } = {}) {
  let names = []; try { names = readdirSync(dir); } catch { return []; }
  return names.map((owner) => ({ owner, flag: readPause({ dir, owner, maxPauseMinutes, now }) })).filter((x) => x.flag);
}
/** Remove expired/garbled flags; returns their owners. */
export function sweepExpired({ dir = defaultPauseDir(), maxPauseMinutes = GOVERNOR_DEFAULTS.maxPauseMinutes, now = new Date() } = {}) {
  let names = []; try { names = readdirSync(dir); } catch { return []; }
  return names.filter((owner) => !readPause({ dir, owner, maxPauseMinutes, now })).filter((owner) => clearPause({ dir, owner }));
}

/**
 * One governor step: update hysteresis, and for holdable `owners` ({owner,text}) set (holding) or clear
 * (released) governor-owned flags. Operator flags (by != load-governor) are never cleared here. Returns events.
 */
export function governorTick({ loadPerCore, owners = [], settings = GOVERNOR_DEFAULTS, stateFile, dir = defaultPauseDir(), now = new Date(), log = () => {} }) {
  let prev = false; let cooled = []; try { const j = JSON.parse(readFileSync(stateFile, 'utf8')); prev = j.holding === true; cooled = Array.isArray(j.cooled) ? j.cooled : []; } catch { /* first run */ }
  const st = governorState({ loadPerCore, holding: prev, settings });
  const events = [];
  for (const o of sweepExpired({ dir, maxPauseMinutes: settings.maxPauseMinutes, now })) { events.push({ event: 'expired', owner: o }); if (st.holding && !cooled.includes(o)) cooled.push(o); } // TTL is a hard cap: no re-pause until load clears
  if (!st.holding) cooled = [];
  if (st.unreadable) events.push({ event: 'load-unreadable', reason: st.reason });
  // Flags are keyed by the sanitized name, so `w/1` and `w_1` share one file. If any owner on a key is exempt, the key is never
  // paused (an exempt worker must not be held through a sibling's name) and the holdable sibling is reported, not paused.
  const exemptKeys = new Set(owners.filter((o) => validOwner(o.owner) && !isHoldable(ownerClass(o.text ?? o.owner, settings), settings)).map((o) => safe(o.owner)));
  for (const { owner, text } of owners) {
    if (!validOwner(owner)) { events.push({ event: 'skipped-invalid-owner', owner: String(owner) }); continue; } // `.`/`..`/blank would hit the pause dir itself
    const cls = ownerClass(text ?? owner, settings);
    if (isHoldable(cls, settings) && exemptKeys.has(safe(owner))) { events.push({ event: 'skipped-colliding-owner', owner, cls }); continue; }
    const cur = readPause({ dir, owner, maxPauseMinutes: settings.maxPauseMinutes, now });
    if (!isHoldable(cls, settings)) { // reclassified as exempt (e.g. feature-build -> red-main-repair): drop OUR pause, never an operator's
      if (cur?.by === GOVERNOR_REASON) { clearPause({ dir, owner }); events.push({ event: 'resumed', owner, cls }); }
      continue;
    }
    // cooled holds on-disk (sanitized) names, as sweepExpired returns them, so compare in that key space
    if (st.holding && !cur && !cooled.includes(safe(owner))) { setPause({ dir, owner, reason: `${GOVERNOR_REASON}: ${st.reason}`, by: GOVERNOR_REASON, now }); events.push({ event: 'paused', owner, cls }); }
    else if (!st.holding && cur?.by === GOVERNOR_REASON) { clearPause({ dir, owner }); events.push({ event: 'resumed', owner, cls }); }
  }
  if (!st.holding) { // owners gone from the list but still flagged by us: clear too
    for (const { owner, flag } of listPauses({ dir, maxPauseMinutes: settings.maxPauseMinutes, now })) {
      if (flag.by === GOVERNOR_REASON) { clearPause({ dir, owner }); events.push({ event: 'resumed', owner }); }
    }
  }
  if (stateFile && (st.holding !== prev || cooled.length)) { mkdirSync(join(stateFile, '..'), { recursive: true }); writeFileSync(stateFile, JSON.stringify({ holding: st.holding, cooled, at: now.toISOString() }) + '\n'); }
  for (const e of events) log({ at: now.toISOString(), loadPerCore, ...e });
  return { ...st, events };
}
export function appendEvents(file, row) { try { mkdirSync(join(file, '..'), { recursive: true }); appendFileSync(file, JSON.stringify(row) + '\n'); } catch { /* evidence only */ } }
