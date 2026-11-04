import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

/**
 * Card xwu9oxh slice S1a: the same read set, order and errors as `ids.map(read).filter(keep)`, without holding
 * every parsed run at once. Each run is read, tested and dropped unless it matches.
 *
 * Behaviour matches the array form exactly:
 * - every id is read, in order, so a missing or corrupt run still throws the same error at the same id;
 * - a read error wins over a `keep` error, because `map` finishes every read before `filter` tests any run;
 * - the first `keep` error is rethrown only after every read succeeded, and later runs are not tested
 *   (`filter` stops at its first throw);
 * - the result is the matching runs (as returned by `project`) in id order, so a later stable sort agrees.
 *
 * @template T, R
 * @param {Iterable<string>} ids
 * @param {(id: string) => T} read
 * @param {(value: T) => boolean} keep
 * @param {(value: T, id: string) => R} [project] - what to keep for a matching run (default: the read value).
 * @returns {R[]}
 */
export function readFilteredInOrder(ids, read, keep, project = (value) => value) {
  const hits = [];
  let keepError = null;
  for (const id of ids) {
    const value = read(id);
    if (keepError) continue;
    let matched;
    try { matched = keep(value); } catch (error) { keepError = { error }; continue; }
    if (matched) hits.push(project(value, id));
  }
  if (keepError) throw keepError.error;
  return hits;
}

/** Standard parse budget. Incomplete scans hold until the operator inspects the omitted
 * evidence or deliberately raises runs.scan.maxParses. */
export const MAX_RUN_RECORDS_PARSED = 300;

export const RUN_SCAN_CAPPED = Object.freeze({ ok: false, reason: 'scan-capped' });
const validMaxParses = value => Number.isSafeInteger(value) && value > 0;

/** No environment override: use the existing platform/tool settings cascade and source log. */
export function resolveRunScanSettings({ file = readSettings(), platform, env = process.env, log } = {}) {
  const pick = value => value?.scan?.maxParses === undefined ? {} : { scan: { maxParses: value.scan.maxParses } };
  return cascadePolicy('runs', pick(file?.runs), {
    standard: { scan: { maxParses: MAX_RUN_RECORDS_PARSED } },
    platform: pick(platform === undefined ? platformPreference('runs', { env }) : platform),
    env, log, valid: validMaxParses,
  });
}

/** Stat only before ordering. The finder retains metadata and a cursor, never parsed
 * payloads. Repeated queries continue the SAME bounded scan, stopping at each first match.
 * Equal mtimes use id ascending by default (drain); recovery opts into id-desc.
 * Unreadable metadata/records throw rather than supplying incomplete accepting evidence. */
export function createNewestRunFinder({ ids, stat, read, tieBreak = 'id-asc', maxParses,
  scanSettings, warn = message => console.warn(message) }) {
  const setting = maxParses === undefined ? resolveRunScanSettings(scanSettings) : null;
  maxParses ??= setting.value.scan.maxParses;
  if (!validMaxParses(maxParses)) throw new TypeError('invalid runs.scan.maxParses');
  if (!['id-asc', 'id-desc'].includes(tieBreak)) throw new TypeError('unknown run tieBreak');
  const candidates = Array.from(ids, id => {
    const at = stat(id).mtimeMs;
    if (!Number.isFinite(at)) throw new TypeError(`run ${id}: unreadable mtime`);
    return { id, at };
  });
  candidates.sort((a, b) => b.at - a.at || (tieBreak === 'id-desc' ? b.id.localeCompare(a.id) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  let cursor = 0, warned = false;
  return keep => {
    for (; cursor < Math.min(candidates.length, maxParses);) {
      const { id, at } = candidates[cursor++];
      const run = read(id);
      if (keep(run, id, at)) return { id, at, run };
    }
    if (cursor < candidates.length) {
      if (!warned) {
        warned = true;
        warn(`runs.scan.maxParses=${maxParses} (source: ${setting?.sources['scan.maxParses'] ?? 'injected'}) reached: scan-capped; HOLD and inspect omitted runs before increasing the setting`);
      }
      return RUN_SCAN_CAPPED;
    }
    return null;
  };
}

export function findNewestMatchingRun(options) {
  return createNewestRunFinder(options)(options.keep);
}
