/**
 * @file scripts/conveyor/health-builder-ticks.mjs
 * @description builder-starved (2026-10-07) — fold the build-dispatch daemon's own JSON tick records (one per line,
 *   each carrying `timings`) into a small memory the `builder-starved` smell reads: when the daemon last LAUNCHED
 *   anything (a build or an item prepare), and whether its latest tick had a queue and free capacity. Times come
 *   from each record's own `at`, so a bootstrap read of an old log is exact, never estimated. Pure.
 *
 *   Live case: from 22:08Z 2026-10-06 to 10:51Z 2026-10-07 every tick had ~400 queued, `prepare.inFlight: []`
 *   (both prepare slots free) and `prepare.planned/launched: []`. No existing smell saw it, because each tick looked
 *   like a correct no-op.
 */

const QUEUED_RE = /(\d+)\s+queued\b/;

/** One parsed tick record, or `null` when the line is not a build-dispatch tick record. */
export function parseBuilderTick(line) {
  if (typeof line !== 'string' || !line.startsWith('{') || !line.includes('"timings"')) return null;
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r.at !== 'string' || !r.prepare || typeof r.prepare !== 'object') return null;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return null;
  const launched = [...(Array.isArray(r.dispatched) ? r.dispatched : []), ...(Array.isArray(r.prepare.launched) ? r.prepare.launched : [])]
    .map((x) => String(x?.num ?? '')).filter(Boolean);
  const m = QUEUED_RE.exec(String(r.status ?? ''));
  const queued = m ? Number(m[1]) : null;
  // `capacity` is logged by daemons that carry this fix; an older record's free prepare room is the fallback signal.
  const cap = r.capacity && typeof r.capacity === 'object' ? r.capacity : null;
  const frozen = cap ? cap.frozen === true : r.freeze?.frozen === true;
  const capacityFree = cap ? cap.free === true
    : !frozen && (Array.isArray(r.prepare.inFlight) ? r.prepare.inFlight.length : 0) < 2;
  return { at, launched, queued, capacityFree, frozen };
}

/** Fold a log sample's text into the builder memory. Records older than the memory's last tick are skipped. */
export function foldBuilderTicks(prev, text) {
  const mem = prev && typeof prev === 'object' ? { ...prev } : null;
  let out = mem;
  for (const line of String(text ?? '').split('\n')) {
    const t = parseBuilderTick(line.trim());
    if (!t) continue;
    if (out && Number.isFinite(out.lastTickAt) && t.at <= out.lastTickAt) continue;
    out = out ?? { firstSeenAt: t.at, lastLaunchAt: null, lastLaunch: null, lastTickAt: null, ticksSeen: 0 };
    out.ticksSeen = (out.ticksSeen ?? 0) + 1;
    out.lastTickAt = t.at;
    out.queued = t.queued;
    out.capacityFree = t.capacityFree;
    out.frozen = t.frozen;
    if (t.launched.length) { out.lastLaunchAt = t.at; out.lastLaunch = t.launched.slice(0, 8); }
  }
  return out;
}

/** The `builder-starved` limit in minutes: `WE_BUILDER_STARVED_MINUTES` (a positive number), default 60. */
export function builderStarvedMinutes(env = process.env) {
  const n = Number(env?.WE_BUILDER_STARVED_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}
