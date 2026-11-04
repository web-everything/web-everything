import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

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

/** Bytes of a run record read to learn its PR (the `input.pr` field sits at the top of the record). */
export const RUN_HEAD_BYTES = 512;
const RUN_TAIL_BYTES = 64;
const TOKEN = /"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?|true|false|null/gy;

/** The PR number of the ROOT `input` object, read from the head of a record: the head must open the root
 * object, and `"pr":N` must be a direct member of `input` before any nested object or array. Else null. */
export function prNumberFromRunHead(text) {
  const t = text.slice(0, RUN_HEAD_BYTES);
  const tokens = []; TOKEN.lastIndex = 0;
  const skip = /\s*/y;
  for (let at = 0; at < t.length;) {
    skip.lastIndex = at; skip.test(t); at = skip.lastIndex;
    if (at >= t.length) break;
    TOKEN.lastIndex = at; const m = TOKEN.exec(t);
    if (!m) break; // a token cut off by the head bound, or not JSON: decide from what came before
    tokens.push(m[0]); at = TOKEN.lastIndex;
  }
  if (tokens[0] !== '{') return null;
  let depth = 1;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '{' || tok === '[') { depth++; continue; }
    if (tok === '}' || tok === ']') { depth--; continue; }
    if (depth === 1 && tok === '"input"' && tokens[i + 1] === ':' && tokens[i + 2] === '{') {
      for (let j = i + 3, d = 2; j < tokens.length; j++) {
        const u = tokens[j];
        if (u === '{' || u === '[' || u === '}' || u === ']') return null;
        if (d === 2 && u === '"pr"' && tokens[j + 1] === ':' && /^\d+$/.test(tokens[j + 2] ?? '') && [',', '}'].includes(tokens[j + 3])) return Number(tokens[j + 2]);
      }
      return null;
    }
  }
  return null;
}

/** True when the last RUN_TAIL_BYTES of the record end (ignoring whitespace) in `}`, i.e. it is not torn. */
export function runTailComplete(text) {
  return /\}\s*$/.test(text.slice(-RUN_TAIL_BYTES));
}

/** False ONLY when a bounded head read proves the run is for a different PR AND a bounded tail read shows a
 * complete record. Anything unclear (no PR in the head, torn tail, a missing file) answers true so the real
 * parse decides and keeps its throw; any other read error throws (fail closed). */
export function runMayBeForPr(path, pr) {
  let fd;
  try { fd = openSync(path, 'r'); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  try {
    const head = Buffer.alloc(RUN_HEAD_BYTES);
    const n = readSync(fd, head, 0, RUN_HEAD_BYTES, 0);
    const found = prNumberFromRunHead(head.toString('utf8', 0, n));
    if (found === null || found === Number(pr)) return true;
    const size = fstatSync(fd).size;
    const len = Math.min(RUN_TAIL_BYTES, size);
    const tail = Buffer.alloc(len);
    const m = readSync(fd, tail, 0, len, size - len);
    return !runTailComplete(tail.toString('utf8', 0, m));
  } finally { closeSync(fd); }
}

/** Stat only before ordering. The finder retains metadata and a cursor, never parsed
 * payloads. Repeated queries continue the SAME bounded scan, stopping at each first match.
 * `keep(run, id, at, nextAt)` also gets the mtime of the first record not yet read (-Infinity
 * when none is left), so a caller can stop once no unread record can change its answer.
 * Equal mtimes use id ascending by default (drain); recovery opts into id-desc.
 * `mayMatch(id)` (optional) drops runs that provably cannot match BEFORE stat and parse; the cap applies to the rest.
 * Unreadable metadata/records throw rather than supplying incomplete accepting evidence. */
export function createNewestRunFinder({ ids, stat, read, tieBreak = 'id-asc', maxParses, mayMatch,
  scanSettings, warn = message => console.warn(message) }) {
  const setting = maxParses === undefined ? resolveRunScanSettings(scanSettings) : null;
  maxParses ??= setting.value.scan.maxParses;
  if (!validMaxParses(maxParses)) throw new TypeError('invalid runs.scan.maxParses');
  if (!['id-asc', 'id-desc'].includes(tieBreak)) throw new TypeError('unknown run tieBreak');
  const candidates = Array.from(mayMatch ? Array.from(ids).filter(id => mayMatch(id)) : ids, id => {
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
      if (keep(run, id, at, cursor < candidates.length ? candidates[cursor].at : -Infinity)) return { id, at, run };
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
