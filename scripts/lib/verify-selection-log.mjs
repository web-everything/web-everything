/**
 * we:scripts/lib/verify-selection-log.mjs — one grep-able line saying which test selection a verify run used (#xlewnhs).
 *
 * The verify daemon's own "dispatching verify for <lane> @ <sha>" line never said whether the since-last-green delta
 * (#xgqwuq5) or the whole-PR selection ran, or why, so "is incremental verify working?" could not be answered from the
 * daemon log. The dispatched `verify-lane.mjs` child prints these lines as `⚠ verify-lane:` notices, the one channel
 * the dispatcher already copies into the daemon log (`spawnGateBounded`'s `onNotice`), so no dispatcher change is
 * needed and the in-process and detached-job dispatch modes both carry them:
 *
 *   ⚠ web-everything/lane-16: selection @ 1a2b3c4d mode=since-last-green reason="…" files=3 tests=5
 *   ⚠ web-everything/lane-16: verdict green @ 1a2b3c4d mode=since-last-green reason="…" files=3 tests=5
 *
 * `mode` is `since-last-green` / `pr` (a selected run, from that diff) / `full` (the selection fell back to the full
 * suite) / `explicit` (a gate that is not the default selection) / `unresolved` (the run ended before selection).
 * Pure.
 */

export const SELECTION_NOTICE_PREFIX = '⚠ verify-lane:';
export const SELECTION_MODES = Object.freeze(['since-last-green', 'pr', 'full', 'explicit', 'unresolved']);

const count = (xs) => (Array.isArray(xs) ? xs.length : null);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The selection summary for one run.
 * @param {{gate?:{decision?:object}|null, explicitGate?:boolean}} o `gate` is `resolveDefaultGate`'s result (or the
 *   matched requested-default gate); `explicitGate` says a `--gate` was given that resolved to no default selection.
 * @returns {{mode:string, reason:string, files:number|null, tests:number|'all'|null}}
 */
export function summarizeSelection({ gate = null, explicitGate = false } = {}) {
  const decision = gate?.decision;
  if (!decision) {
    return explicitGate
      ? { mode: 'explicit', reason: 'the requested gate is not a default selection', files: null, tests: null }
      : { mode: 'unresolved', reason: 'no selection was resolved', files: null, tests: null };
  }
  const files = count(decision.changedFiles);
  if (decision.mode === 'card-only-skip') return { mode: 'pr', reason: 'card-only diff, gate skipped', files, tests: 0 };
  if (decision.mode === 'blocked') return { mode: 'full', reason: `selection blocked: ${(decision.reasons ?? []).join('; ')}`, files, tests: null };
  const selectionMode = decision.selectionMode;
  if (decision.mode !== 'shrink') {
    const why = (decision.reasons ?? []).join('; ') || 'the diff could not be safely scoped';
    return { mode: 'full', reason: selectionMode?.reason ? `${why} (${selectionMode.mode}: ${selectionMode.reason})` : why, files, tests: 'all' };
  }
  const selected = Number.isFinite(decision.selection?.selectedTestCount) ? decision.selection.selectedTestCount : count(decision.targets);
  return { mode: selectionMode?.mode === 'since-last-green' ? 'since-last-green' : 'pr',
    reason: selectionMode?.reason ?? 'whole PR diff vs origin/main', files, tests: selected };
}

/** `mode=… reason="…" files=… tests=…` — reason is JSON-quoted so it stays one token for a grep or a parser. */
export function formatSelection(summary) {
  const s = summary ?? { mode: 'unresolved', reason: 'no selection was resolved', files: null, tests: null };
  return `mode=${s.mode} reason=${JSON.stringify(oneLine(s.reason))} files=${s.files ?? '?'} tests=${s.tests ?? '?'}`;
}

const sha8 = (sha) => (sha ? String(sha).slice(0, 8) : '?');

/** The notice printed once the gate's selection is known. */
export function selectionNotice({ sha, summary }) {
  return `${SELECTION_NOTICE_PREFIX} selection @ ${sha8(sha)} ${formatSelection(summary)}`;
}

/** The notice printed as the run ends, whatever the verdict (green, red, cached, superseded, error…). */
export function verdictNotice({ sha, status, summary }) {
  return `${SELECTION_NOTICE_PREFIX} verdict ${status ?? 'unknown'} @ ${sha8(sha)} ${formatSelection(summary)}`;
}

/** Parse a selection or verdict line (raw child notice or the daemon-log copy). Returns null for any other line. */
export function parseSelectionLine(line) {
  const m = /\b(selection|verdict ([a-z-]+)) @ ([0-9a-f?]+) mode=([a-z-]+) reason=("(?:[^"\\]|\\.)*") files=(\d+|\?) tests=(\d+|all|\?)/.exec(String(line ?? ''));
  if (!m) return null;
  let reason;
  try { reason = JSON.parse(m[5]); } catch { return null; }
  const num = (v) => (v === '?' ? null : v === 'all' ? 'all' : Number(v));
  return { kind: m[2] ? 'verdict' : 'selection', ...(m[2] ? { status: m[2] } : {}), sha: m[3], mode: m[4], reason, files: num(m[6]), tests: num(m[7]) };
}
