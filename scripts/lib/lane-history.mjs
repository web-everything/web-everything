/**
 * @file scripts/lib/lane-history.mjs
 * @description The LANE HISTORY LEDGER (#3383, epic #3383): "we need to be able to trace every lane back to
 *   the session/card/PR that used it, and know its status." Today a lane's lease marker (`.lane-lease`)
 *   records only the CURRENT holder — `release` deletes it outright, so the instant a lane is handed back the
 *   pool forgets who was ever in it. This module is the missing durable trail: one JSON line per
 *   acquire/adopt/release/reap event, appended to `<lane>/.git/lane-history.jsonl`.
 *
 * WHY INSIDE `.git`: never tracked (git ignores its own `.git/` dir by construction), so it is never dirty,
 * never committed, never conflicts with a reset — `acquire`'s `checkout -B` + `clean -fd` cannot touch it
 * because `clean -fd` never descends into `.git/`. It survives every reset/refresh a lane goes through, which
 * is the whole point: a lane's WORKING TREE is ephemeral (reset to origin on every acquire), but its HISTORY
 * must outlive that.
 *
 * WHY A SEPARATE MODULE, NOT INLINE IN `lane-pool.mjs`: another worker owns `lane-pool.mjs` for PR #2606
 * (acquire growth, wait-vs-scan) concurrently with this card. Everything DECIDABLE lives here, pure and
 * unit-tested directly; `lane-pool.mjs` gets only the narrow call-out at each of its four existing mutation
 * points (`cmdAcquire`, `cmdAdopt`, `cmdRelease`, `reapDeadLeasesInPool`) — see that file's own `appendLaneHistory`
 * call sites.
 *
 * KEPT SMALL (explicit operator instruction): `appendLaneHistory` trims the file to the last
 * {@link MAX_HISTORY_LINES} lines on every write, so a lane cycling through hundreds of sessions over months
 * never grows an unbounded ledger — the RECENT trail (who holds it now, who held it last, its last few hops)
 * is what `whois` actually needs; ancient history is not worth keeping forever.
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The ledger's filename, inside `<lane>/.git/`. */
export const LANE_HISTORY_FILENAME = 'lane-history.jsonl';

/** How many of the most recent lines survive a trim. See file header — "keep it small". */
export const MAX_HISTORY_LINES = 500;

/** The ledger's absolute path for a given lane directory. */
export function laneHistoryPath(dir) {
  return join(dir, '.git', LANE_HISTORY_FILENAME);
}

/**
 * PURE: the PR number a history line should record, best-effort, from whatever the caller has on hand.
 * Order (per #3383's own spec): an explicit `pr` wins; else a `--session=review-<pr>`/`fix-<pr>` naming
 * convention (the SAME dispatcher-session grammar `conveyor/lease-reaper.mjs#itemNumFromSession` already
 * parses for item ids — this reads the same shape for a PR-scoped session name) tried against `session` then
 * `holder`; otherwise unknown (`null` — never guessed further, a wrong PR number is worse than none).
 */
export function inferPrNumber({ pr, session, holder } = {}) {
  if (pr !== undefined && pr !== null && String(pr).trim() !== '') {
    const n = Number(pr);
    if (Number.isInteger(n) && n > 0) return n;
  }
  for (const candidate of [session, holder]) {
    if (!candidate) continue;
    const m = String(candidate).match(/\b(?:review|fix)-(\d+)\b/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * PURE: shape one ledger line from an acquire/adopt/release/reap call's own fields. Every field beyond
 * `event`/`ts` is OMITTED when unknown (rather than written `null`) so a `grep`/`jq` read of the ledger never
 * has to distinguish "recorded absent" from "not asked for" — the file only ever states what it actually knows.
 *
 * @param {object} p
 * @param {string} p.event - 'acquire' | 'reserve' | 'adopt' | 'release' | 'reap'
 * @param {number} [p.nowMs]
 * @param {string} [p.session] - the leasing session slug (`defaultSession()` in lane-pool.mjs)
 * @param {string} [p.ownerSession] - the durable `CLAUDE_CODE_SESSION_ID`, when known
 * @param {string} [p.workerSession] - the declared OCCUPANT session (`adopt`'s `workerSession`)
 * @param {string} [p.purpose]
 * @param {string|number} [p.item] - card id(s), comma-joined if plural
 * @param {string} [p.holder] - the minted per-holder slug (#2997)
 * @param {string|number} [p.pr] - an explicit PR number, when the caller already knows it
 * @param {string} [p.reason] - reap's classification reason (e.g. 'pr-merged', 'ttl-stale')
 */
export function laneHistoryEntry({
  event, nowMs = Date.now(), session, ownerSession, workerSession, purpose, item, holder, pr, reason,
} = {}) {
  if (!event) throw new Error('laneHistoryEntry needs an `event` name');
  const entry = { ts: new Date(nowMs).toISOString(), event };
  if (session) entry.session = session;
  if (ownerSession) entry.ownerSession = ownerSession;
  if (workerSession) entry.workerSession = workerSession;
  if (purpose) entry.purpose = purpose;
  if (item !== undefined && item !== null && String(item).trim() !== '') entry.item = String(item);
  if (holder) entry.holder = holder;
  const prNumber = inferPrNumber({ pr, session, holder });
  if (prNumber) entry.pr = prNumber;
  if (reason) entry.reason = reason;
  return entry;
}

/**
 * Trim a ledger file in place to its last `maxLines` lines. Best-effort — a trim failure is silently
 * swallowed (the append itself already landed; losing the trim only means the file stays a little larger).
 */
function trimLaneHistory(file, maxLines = MAX_HISTORY_LINES) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= maxLines) return;
    writeFileSync(file, `${lines.slice(lines.length - maxLines).join('\n')}\n`, 'utf8');
  } catch { /* best-effort trim */ }
}

/**
 * IO: append one ledger line for `dir` (a lane clone). NEVER throws — a bookkeeping-write hiccup must not fail
 * the real acquire/adopt/release/reap call it rides on. No-ops (returns false) when `dir` is not a git
 * checkout at all (defensive — every real caller only ever passes a lane dir).
 * @returns {boolean} whether the line was written.
 */
export function appendLaneHistory(dir, entry) {
  try {
    const gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) return false;
    const file = laneHistoryPath(dir);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    trimLaneHistory(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * IO: read every ledger line for `dir`, oldest first. Tolerant of a corrupt/partial trailing line (e.g. a
 * crash mid-append) — a bad line is skipped, never thrown, so one damaged line can't blind `whois` to every
 * other event in the file. Returns `[]` when the ledger doesn't exist yet (a lane never touched by history-
 * aware code, or a fresh clone).
 */
export function readLaneHistory(dir) {
  const file = laneHistoryPath(dir);
  if (!existsSync(file)) return [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
  }
  return out;
}

/** PURE: the most recent entry in an (oldest-first) entries array, or `null`. */
export function lastLaneHistoryEntry(entries) {
  return entries.length ? entries[entries.length - 1] : null;
}
