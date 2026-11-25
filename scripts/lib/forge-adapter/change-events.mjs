/**
 * @file forge.change-events port (ship/forge-adapter v0.1). Core code reads change events only through here.
 * Ordering is by the log's `seq`, never by event timestamps. A feed that cannot be read is an error (the caller
 * keeps its base interval), never an empty "nothing changed". Anything that cannot be proven contiguous is a gap.
 */
import { requireCapability } from './capabilities.mjs';

/**
 * True when the feed cannot be proven contiguous after `cursor`: a missing or invalid seq, a skipped seq, or a
 * returned cursor that is not the last seq (an empty page whose cursor moved is lost events).
 */
export function detectSeqGap(cursor, events, newCursor = null) {
  const list = Array.isArray(events) ? events : [];
  let prev = Number.isInteger(cursor) ? cursor : null;
  for (const e of list) {
    if (!Number.isInteger(e?.seq)) return true;
    if (prev !== null && e.seq !== prev + 1) return true;
    prev = e.seq;
  }
  if (Number.isInteger(newCursor) && Number.isInteger(cursor) && newCursor !== (list.length ? prev : cursor)) return true;
  return false;
}

/** Read events since `cursor` through the active adapter (default: github, loaded lazily to avoid an import cycle). */
export async function readChangeEvents(cursor, opts = {}) {
  const adapter = opts.adapter || (await import('./github/change-events.mjs')).githubChangeEvents;
  const caps = typeof adapter.capabilities === 'function' ? adapter.capabilities() : null;
  const guard = requireCapability(caps, 'change-events');
  if (!guard.ok) return { ok: false, error: 'change-events unsupported', route: guard.route, event: guard.event };
  const r = await adapter.read(cursor, opts);
  if (!r?.ok) return r;
  return { ...r, gap: !!r.gap || detectSeqGap(cursor, r.events, r.cursor) };
}
