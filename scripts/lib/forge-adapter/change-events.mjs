/**
 * @file forge.change-events port (ship/forge-adapter v0.1). Core code reads change events only through here.
 * Ordering is by the log's `seq`, never by event timestamps. A feed that cannot be read is an error (the caller
 * keeps its base interval), never an empty "nothing changed".
 */

/** True when the first event after `cursor` skips a seq, or the seqs are not contiguous. */
export function detectSeqGap(cursor, events) {
  if (!Array.isArray(events) || !events.length) return false;
  let prev = Number.isInteger(cursor) ? cursor : null;
  for (const e of events) {
    if (!Number.isInteger(e?.seq)) continue;
    if (prev !== null && e.seq !== prev + 1) return true;
    prev = e.seq;
  }
  return false;
}

/** Read events since `cursor` through the active adapter (default: github, loaded lazily to avoid an import cycle). */
export async function readChangeEvents(cursor, opts = {}) {
  const adapter = opts.adapter || (await import('./github/change-events.mjs')).githubChangeEvents;
  return adapter.read(cursor, opts);
}
