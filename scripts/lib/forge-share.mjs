/**
 * @file scripts/lib/forge-share.mjs
 * @description R497 — "all tests on Forge" as a number with an alarm. `forgeShare` = remote heavy runs ÷ countable
 *   heavy runs over a trailing window, where countable = remote + local runs − expected-local runs. Expected-local
 *   runs are fallbacks whose NAMED reason is expected to stay local (settings `expectedLocalReasons`, e.g.
 *   `command-not-allowed`, `needs-git`); they are reported separately and never drag the share down.
 *
 *   Sources (all under the heavy-admission lock root, read-only here):
 *     - `remote-fallbacks.jsonl`  {ts, reason}        — one row per run that fell back to local (heavy-admission).
 *     - `durations.jsonl`         {at, ms}            — one row per LOCAL slot release.
 *     - `remote-runs.jsonl`       {ts, ms}            — one row per run handled on Forge. See {@link recordRemoteRun}.
 *   FAIL CLOSED: a missing/unreadable source, a log tail that does not cover the window, or a window with no
 *   countable run yields `status:'unknown'`, `share:null` — never 0 or 1 by default.
 *
 *   NOTE: heavy-admission.mjs did not write `remote-runs.jsonl` when this landed (the file was held by other
 *   work), so the share reads UNKNOWN until its one call to {@link recordRemoteRun} lands.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'forge-share.json');
const MIN = 60_000;
/** A fallback's local completion must land within this long after it, to be matched as the same run. */
export const MATCH_MS = 60 * MIN;
const TAIL_BYTES = 4 * 1024 * 1024;

/** `remote-full (30s wait exhausted)` → `remote-full`; `remote client override: …` → `remote client override`. */
export function normalizeFallbackReason(reason) {
  return String(reason ?? '').split(/ \(|: /)[0].trim() || 'unknown';
}

/** `lane-22` / `22` / a lane path → `22`; anything else → its last path segment; none → `?`. */
const laneKey = (v) => { const t = String(v ?? '').trim(); if (!t) return '?'; const m = /(?:^|\/)lane-(\d+)$|^(\d+)$/.exec(t); return m ? (m[1] ?? m[2]) : t.split('/').pop(); };
const unknown = (unknownReason, extra = {}) => ({ status: 'unknown', share: null, belowTarget: null, secondsShare: null, unknownReason, ...extra });
const inWindow = (t, now, windowMs) => Number.isFinite(t) && t > now - windowMs && t <= now;

/**
 * Pure. `remoteRuns`/`localRuns`/`fallbacks` are arrays of parsed rows, or `null` when that source is missing or
 * unreadable. `coverage[src] === false` means that source's tail did not reach back to the window start.
 */
export function computeForgeShare({ now, windowMs, target, expectedLocalReasons = [], remoteRuns, localRuns, fallbacks, coverage = {} }) {
  const head = { windowMs, target };
  if (!Number.isFinite(now) || !(windowMs > 0) || !Number.isFinite(target) || target < 0 || target > 1) return unknown('invalid-parameters', head);
  if (remoteRuns == null) return unknown('no-remote-success-record', head);
  if (localRuns == null) return unknown('local-runs-unreadable', head);
  if (fallbacks == null) return unknown('fallbacks-unreadable', head);
  for (const src of ['remoteRuns', 'localRuns', 'fallbacks']) if (coverage?.[src] !== true) return unknown(`window-not-covered:${src}`, head);
  // Source-specific validation: a row missing a field the math relies on is corrupt, not a zero.
  const okTs = (v) => Number.isFinite(Date.parse(v));
  const okMs = (v) => Number.isFinite(v) && v >= 0;
  const validRow = {
    remoteRuns: (r) => okTs(r?.ts) && (r.ms == null || okMs(r.ms)),
    localRuns: (r) => okTs(r?.at) && okMs(r.ms),
    fallbacks: (r) => okTs(r?.ts) && typeof r.reason === 'string' && r.reason.trim() !== '',
  };
  for (const [src, rows] of Object.entries({ remoteRuns, localRuns, fallbacks })) {
    if (!Array.isArray(rows) || rows.some((r) => !validRow[src](r))) return unknown(`malformed-rows:${src}`, head);
  }

  const expected = new Set(expectedLocalReasons.map(normalizeFallbackReason));
  const byReason = {}, expectedLocalByReason = {};
  const from = now - windowMs;
  // Fallbacks are written when a run is refused remote; the matching local run is recorded when it RELEASES. So an
  // expected-local fallback is only subtracted once its own local completion is matched (same lane, at/after it,
  // within MATCH_MS); a pending or unmatched one never erases an unrelated completed run.
  const localRows = localRuns.filter((r) => inWindow(Date.parse(r?.at), now, windowMs)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const taken = new Set();
  let expectedLocal = 0, expectedLocalPending = 0;
  for (const row of [...fallbacks].sort((a, b) => Date.parse(a?.ts) - Date.parse(b?.ts))) {
    const t = Date.parse(row?.ts);
    if (!Number.isFinite(t) || t > now) continue;
    const reason = normalizeFallbackReason(row.reason);
    const isExpected = expected.has(reason);
    if (!isExpected) { if (t > from) byReason[reason] = (byReason[reason] ?? 0) + 1; continue; }
    const key = laneKey(row.lane);
    // Identity: a known lane and the same kind on both sides, and the local run STARTED (release time minus hold) after the fallback.
    const sameKind = (l) => typeof row.kind === 'string' && row.kind !== '' && row.kind === l.kind;
    const idx = key === '?' ? -1 : localRows.findIndex((l, i) => !taken.has(i) && laneKey(l.lane ?? l.repo) === key && sameKind(l)
      && Date.parse(l.at) - l.ms >= t - 1000 && Date.parse(l.at) - t <= MATCH_MS);
    if (idx >= 0) { taken.add(idx); expectedLocal++; expectedLocalByReason[reason] = (expectedLocalByReason[reason] ?? 0) + 1; }
    else if (t > from) expectedLocalPending++;
  }
  const remoteRows = remoteRuns.filter((r) => inWindow(Date.parse(r?.ts), now, windowMs));
  const sec = (rows) => rows.reduce((s, r) => s + (Number.isFinite(r?.ms) && r.ms > 0 ? r.ms : 0), 0) / 1000;
  const remote = remoteRows.length, local = localRows.length;
  const counted = remote + (local - expectedLocal);
  const out = { ...head, runs: { remote, local, expectedLocal, expectedLocalPending, counted }, byReason, expectedLocalByReason, seconds: { remote: sec(remoteRows), local: sec(localRows) } };
  if (counted === 0) return unknown('no-countable-runs', out);
  const share = remote / counted;
  const secTotal = out.seconds.remote + out.seconds.local;
  return { status: 'ok', unknownReason: null, ...out, share, belowTarget: share < target, secondsShare: secTotal > 0 && remoteRows.every((r) => okMs(r.ms)) ? out.seconds.remote / secTotal : null };
}

/** Validated settings → `{target, windowMs, alertAfterMs, expectedLocalReasons}`. Throws on a missing/invalid file. */
export function loadForgeShareSettings({ file = DEFAULT_SETTINGS_FILE } = {}) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const posMin = (v) => Number.isFinite(v) && v > 0;
  if (!(Number.isFinite(s.target) && s.target > 0 && s.target <= 1)) throw new Error('forge-share settings: target must be in (0,1]');
  if (!posMin(s.windowMinutes) || !posMin(s.alertAfterMinutes)) throw new Error('forge-share settings: windowMinutes and alertAfterMinutes must be positive numbers');
  if (!Array.isArray(s.expectedLocalReasons) || s.expectedLocalReasons.some((r) => typeof r !== 'string')) throw new Error('forge-share settings: expectedLocalReasons must be a string array');
  return { target: s.target, windowMs: s.windowMinutes * MIN, alertAfterMs: s.alertAfterMinutes * MIN, expectedLocalReasons: s.expectedLocalReasons };
}

/** Parsed rows of a jsonl tail, `null` when the file is missing/unreadable/CORRUPT. Only a first line the read cut
 *  mid-line and an unterminated last line (a concurrent append) may be unparseable; any other malformed line, or a
 *  parsed row without a valid timestamp, makes the source corrupt, because dropping it could invent a 100% share.
 *  `covered` is true only when the oldest row reaches back to `needFrom`: the writers rotate their logs, so reading
 *  the whole current file never proves the window is complete. */
function readJsonlTail(file, tsOf, needFrom) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, len = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8'), lines = text.split('\n');
    const cutStart = len < size, unterminated = !text.endsWith('\n');
    const rows = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let r;
      try { r = JSON.parse(line); } catch {
        // Only a line the read itself cut (tail start) or a still-being-appended last line may be unparseable.
        if ((i === 0 && cutStart) || (i === lines.length - 1 && unterminated)) return;
        throw new Error('corrupt row');
      }
      if (!r || typeof r !== 'object' || !Number.isFinite(Date.parse(tsOf(r)))) throw new Error('corrupt row');
      rows.push(r);
    });
    const oldest = Math.min(...rows.map((r) => Date.parse(tsOf(r))));
    return { rows, covered: Number.isFinite(oldest) && oldest <= needFrom };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Read the three logs for `[now - windowMs, now]`. Missing source → `null` (fail closed in the compute). */
export function readForgeShareInputs({ lockRoot, now, windowMs }) {
  const from = now - windowMs;
  const fb = readJsonlTail(join(lockRoot, 'remote-fallbacks.jsonl'), (r) => r.ts, from);
  const dur = readJsonlTail(join(lockRoot, 'durations.jsonl'), (r) => r.at, from);
  const rem = readJsonlTail(join(lockRoot, 'remote-runs.jsonl'), (r) => r.ts, from);
  return {
    fallbacks: fb?.rows ?? null, localRuns: dur?.rows ?? null, remoteRuns: rem?.rows ?? null,
    coverage: { fallbacks: fb?.covered, localRuns: dur?.covered, remoteRuns: rem?.covered },
  };
}

/** The one append heavy-admission makes when a run is handled on Forge. Best-effort; never throws. */
export function recordRemoteRun({ lockRoot, ms = null, kind = null, receiptId = null, at = new Date().toISOString() }) {
  try {
    mkdirSync(lockRoot, { recursive: true });
    appendFileSync(join(lockRoot, 'remote-runs.jsonl'), JSON.stringify({ ts: at, ms, kind, receiptId }) + '\n', 'utf8');
  } catch { /* observability must never block a run */ }
}

/**
 * Settings-driven read of `{current, earlier}`: the share over the trailing window now, and the same window
 * `alertAfter` ago. NEVER throws — any failure is an unknown result.
 */
export function probeForgeShare({ lockRoot, settingsFile = DEFAULT_SETTINGS_FILE, now = Date.now() } = {}) {
  let settings;
  try { settings = loadForgeShareSettings({ file: settingsFile }); } catch (e) {
    const u = unknown('settings-unreadable', { detail: String(e?.message ?? e).slice(0, 200) });
    return { current: u, earlier: u };
  }
  try {
    const inputs = readForgeShareInputs({ lockRoot, now, windowMs: settings.windowMs + settings.alertAfterMs + MATCH_MS });
    const args = { windowMs: settings.windowMs, target: settings.target, expectedLocalReasons: settings.expectedLocalReasons, ...inputs };
    return { current: computeForgeShare({ ...args, now }), earlier: computeForgeShare({ ...args, now: now - settings.alertAfterMs }) };
  } catch (e) {
    const u = unknown('probe-failed', { detail: String(e?.message ?? e).slice(0, 200) });
    return { current: u, earlier: u };
  }
}
