/**
 * @file scripts/lib/quiet-hours.mjs
 * @description The quietHours knob (held item 134, card xmvc6oc) — the PURE core. No fs, no clock, no spawn.
 *
 *   Overnight (default 22:00–07:00 America/New_York) desktop alerts are held, the costly scheduled sweeps
 *   (coroner, opus) skip, and only emergencies break through: main red, or a daemon down for at least
 *   `breakthrough.daemonDownMin` minutes. Everything held goes into a digest that is sent ONCE when quiet ends.
 *
 *   The operator can also force quiet with the toggle file (`{"on":bool,"until":iso|null}`): `on:true` with no
 *   `until` (or an `until` still in the future) means quiet now, whatever the clock says.
 *
 *   Every policy lives in `we:scripts/quiet-hours-settings.json`; {@link DEFAULT_QUIET_SETTINGS} is the fallback
 *   for any key that file leaves out. The IO shell is `we:scripts/lib/quiet-hours-io.mjs`.
 */

export const DEFAULT_QUIET_SETTINGS = Object.freeze({
  enabled: true,
  start: '22:00',
  end: '07:00',
  timeZone: 'America/New_York',
  toggleFile: '~/workspace/.operations/handoff/quiet-mode.json',
  digestDir: '~/workspace/.operations/reports/quiet-hours',
  breakthrough: Object.freeze({
    mainRed: true,
    daemonDownMin: 30,
    /** A daemon-down alert that does not say how long it has been down: deliver it (fail loud) or hold it. */
    daemonDownUnknownDuration: 'deliver',
    /** Fallback for callers that do not tag `emergency`: a title matching this is treated as main red. */
    mainRedTitlePattern: '\\bmain\\b.*\\b(red|failing)\\b',
  }),
  sweeps: Object.freeze({ skipDuringQuiet: Object.freeze(['coroner', 'opus']) }),
  digest: Object.freeze({ enabled: true, maxTitles: 5 }),
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge a (possibly partial, possibly garbage) settings object over the defaults. PURE. */
export function mergeSettings(raw, defaults = DEFAULT_QUIET_SETTINGS) {
  const out = {};
  for (const [k, d] of Object.entries(defaults)) {
    const v = isObj(raw) ? raw[k] : undefined;
    if (isObj(d)) out[k] = mergeSettings(v, d);
    else if (Array.isArray(d)) out[k] = Array.isArray(v) ? v.map(String) : [...d];
    else out[k] = v !== undefined && typeof v === typeof d ? v : d;
  }
  return out;
}

/** "HH:MM" → minutes after midnight, or null when malformed. PURE. */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Minutes after local midnight in `timeZone` (Intl handles DST). PURE given `nowMs`. */
export function localMinutes(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return (get('hour') % 24) * 60 + get('minute');
}

/** True when `min` is inside [start, end), wrapping midnight when start > end. Equal start/end = never. PURE. */
export function inWindow(min, start, end) {
  if (start === end) return false;
  return start < end ? min >= start && min < end : min >= start || min < end;
}

/** Is the toggle file forcing quiet at `nowMs`? `until` null = open-ended; a past or unparsable `until` = off. */
export function toggleActive(toggle, nowMs) {
  if (!isObj(toggle) || toggle.on !== true) return false;
  if (toggle.until == null) return true;
  const u = Date.parse(toggle.until);
  return Number.isFinite(u) && u > nowMs;
}

/**
 * The one shared rule: is it quiet at `now`? PURE.
 * @returns {{quiet:boolean, reason:'disabled'|'toggle'|'window'|'outside-window'|'bad-window'}}
 */
export function isQuiet(now, settings = DEFAULT_QUIET_SETTINGS, toggle = null) {
  const s = mergeSettings(settings);
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  if (toggleActive(toggle, nowMs)) return { quiet: true, reason: 'toggle' };
  if (!s.enabled) return { quiet: false, reason: 'disabled' };
  const start = parseHHMM(s.start); const end = parseHHMM(s.end);
  if (start == null || end == null) return { quiet: false, reason: 'bad-window' };
  let min;
  try { min = localMinutes(nowMs, s.timeZone); } catch { return { quiet: false, reason: 'bad-window' }; }
  return inWindow(min, start, end) ? { quiet: true, reason: 'window' } : { quiet: false, reason: 'outside-window' };
}

/**
 * Does this alert break through quiet hours? PURE.
 * An alert may carry `emergency: {kind:'main-red'}` or `emergency: {kind:'daemon-down', downForMs:number|null}`.
 * @returns {{breaks:boolean, why:string}}
 */
export function breaksThrough(alert, settings = DEFAULT_QUIET_SETTINGS) {
  const b = mergeSettings(settings).breakthrough;
  const e = isObj(alert?.emergency) ? alert.emergency : null;
  if (e?.kind === 'main-red') return { breaks: !!b.mainRed, why: b.mainRed ? 'main red' : 'main red (breakthrough off)' };
  if (e?.kind === 'daemon-down') {
    const ms = Number(e.downForMs);
    if (e.downForMs == null || !Number.isFinite(ms)) {
      const deliver = b.daemonDownUnknownDuration !== 'hold';
      return { breaks: deliver, why: `daemon down, duration unknown (${deliver ? 'deliver' : 'hold'})` };
    }
    const mins = Math.floor(ms / 60_000);
    return mins >= b.daemonDownMin
      ? { breaks: true, why: `daemon down ${mins} min >= ${b.daemonDownMin}` }
      : { breaks: false, why: `daemon down only ${mins} min < ${b.daemonDownMin}` };
  }
  if (b.mainRed && b.mainRedTitlePattern) {
    let re = null; try { re = new RegExp(b.mainRedTitlePattern, 'i'); } catch { /* bad pattern → no fallback */ }
    if (re && re.test(String(alert?.title ?? ''))) return { breaks: true, why: 'main red (title)' };
  }
  return { breaks: false, why: 'routine' };
}

/**
 * Deliver now, or hold for the digest? PURE.
 * @returns {{deliver:boolean, quiet:boolean, reason:string}}
 */
export function decideDelivery(alert, { now, settings = DEFAULT_QUIET_SETTINGS, toggle = null }) {
  const q = isQuiet(now, settings, toggle);
  if (!q.quiet) return { deliver: true, quiet: false, reason: q.reason };
  const b = breaksThrough(alert, settings);
  return b.breaks ? { deliver: true, quiet: true, reason: `breakthrough: ${b.why}` } : { deliver: false, quiet: true, reason: `held (${q.reason}): ${b.why}` };
}

/** Should a scheduled sweep job skip right now? PURE. */
export function sweepSkip(job, { now, settings = DEFAULT_QUIET_SETTINGS, toggle = null }) {
  const s = mergeSettings(settings);
  const q = isQuiet(now, s, toggle);
  const skip = q.quiet && s.sweeps.skipDuringQuiet.includes(job);
  return { skip, reason: skip ? `quiet hours (${q.reason}): ${job} skipped` : q.quiet ? `quiet (${q.reason}) but ${job} still runs` : q.reason };
}

/** The ONE digest notification for a list of held alerts, or null when there is nothing to send. PURE. */
export function planDigest(entries, settings = DEFAULT_QUIET_SETTINGS) {
  const s = mergeSettings(settings);
  const list = (entries ?? []).filter((e) => isObj(e) && typeof e.title === 'string');
  if (!s.digest.enabled || list.length === 0) return null;
  const counts = new Map();
  for (const e of list) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
  const top = [...counts.entries()].slice(0, s.digest.maxTitles).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
  const more = counts.size > top.length ? ` (+${counts.size - top.length} more)` : '';
  return {
    title: `Quiet-hours digest: ${list.length} alert(s) held`,
    body: top.join(' | ') + more,
    markdown: ['# Quiet-hours digest', '', ...list.map((e) => `- ${e.at ?? '?'} — **${e.title}** — ${String(e.body ?? '').slice(0, 300)}`), ''].join('\n'),
  };
}
