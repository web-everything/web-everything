/**
 * @file scripts/lib/daemon-force-adopt.mjs — R508 operator force-adopt for a daemon rebuild.
 * WHY: the review daemon's rebuild smoke can fail for the SAME infra fault (a GitHub 504) that the pending fix
 * cures, so the fix may never be adopted through smoke, and there was no manual way to adopt a build.
 * A force-adopt is NEVER a routine bypass: it needs an operator ruling id AND a verbatim quote that is really in that
 * ruling; the smoke still runs and its result is recorded next to the force; the adoption is logged loudly (daemon
 * events + handoff file), a coroner-review record is written, and for the next N ticks a health watch reverts the
 * clone to the last-good build on a failed health check or a crash loop.
 * Pure decisions are exported separately from the small file IO; the git revert itself is injected (rebuild.mjs
 * reuses `finalizeRebuild`, so it keeps the one locked reset path).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { stateDir, readReadyCandidate, clearReadyCandidate } from './daemon-rebuild/state.mjs';
import { cloneKeyOf } from './daemon-last-good.mjs';

export const FORCE_ADOPT_WATCH_TICKS = 5;
export const FORCE_ADOPT_MAX_RESTARTS = 3;
const MIN_QUOTE = 12;
export const FORCE_ADOPT_TTL_MS = 2 * 60 * 60 * 1000;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const handoffDir = (env) => join(env?.HOME || homedir(), 'workspace/.operations/handoff');
export const rulingsPath = (env = process.env) => env.WE_RULINGS_FILE || join(handoffDir(env), 'rulings.md');
const handoffFile = (env) => env.WE_FORCE_ADOPT_HANDOFF || join(handoffDir(env), 'force-adopt.md');
const coronerFile = (env) => env.WE_FORCE_ADOPT_CORONER || join(handoffDir(env), 'coroner-force-adopt.jsonl');
const requestPath = (root, env) => join(stateDir(env), `${cloneKeyOf(root)}.force-adopt.json`);
const watchPath = (root, env) => join(stateDir(env), `${cloneKeyOf(root)}.force-watch.json`);

/** The text of one ruling section ("## R508 — …" up to the next "## "), or null. */
function rulingSection(text, ruling) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${ruling}\\b`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n'); // the body only: the "## R508 — date" heading is not operator words
}

/** PURE. A force-adopt needs a well-formed ruling id that exists, and a quote that is verbatim in THAT ruling. */
export function validateForceAdopt({ daemon, ruling, quote, rulingsText, sha } = {}) {
  if (!daemon) return { ok: false, reason: 'no-daemon' };
  // The daemon name is written into one-line handoff entries: a newline or other control character would forge extra lines.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(String(daemon))) return { ok: false, reason: 'bad-daemon' };
  if (!ruling) return { ok: false, reason: 'no-ruling' };
  if (!/^R\d+$/.test(ruling)) return { ok: false, reason: 'bad-ruling-id' };
  if (!norm(quote)) return { ok: false, reason: 'no-quote' };
  if (norm(quote).length < MIN_QUOTE) return { ok: false, reason: 'quote-too-short' };
  const section = rulingSection(rulingsText, ruling);
  if (section === null) return { ok: false, reason: 'ruling-unknown' };
  if (!norm(section).includes(norm(quote))) return { ok: false, reason: 'quote-not-in-ruling' };
  // The request names the build the operator saw: without it, any build that fails smoke next would consume the force.
  if (!sha) return { ok: false, reason: 'no-sha' };
  if (!/^[0-9a-f]{40}$/i.test(String(sha))) return { ok: false, reason: 'bad-sha' };
  return { ok: true };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); const t = `${p}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, p); };

/** Validate and persist a one-shot request; the next rebuild smoke consumes it. */
export function requestForceAdopt({ root, env = process.env, daemon, ruling, quote, sha, rulingsText, now = Date.now, dryRun = false } = {}) {
  const text = rulingsText ?? (() => { try { return readFileSync(rulingsPath(env), 'utf8'); } catch { return ''; } })();
  const v = validateForceAdopt({ daemon, ruling, quote, rulingsText: text, sha });
  if (!v.ok) return v;
  const ttl = Number(env?.WE_FORCE_ADOPT_TTL_MS) > 0 ? Number(env.WE_FORCE_ADOPT_TTL_MS) : FORCE_ADOPT_TTL_MS;
  const record = { daemon, ruling, quote: norm(quote), sha: String(sha).toLowerCase(), requestedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + ttl).toISOString() };
  if (!dryRun) writeJson(requestPath(root, env), record); // a dry run validates only, never arms an adoption
  return { ok: true, record };
}
/** The pending request, or null when absent or expired (a stale operator request never fires later). */
export function readForceAdopt(root, env = process.env, now = Date.now) {
  const r = readJson(requestPath(root, env));
  return r && Date.parse(r.expiresAt) > now() ? r : null;
}
/** The pending request IF it names exactly `sha` (a full 40-hex id, compared case-insensitively), else null. The ONE place a
 *  request is matched to a build: a request with no sha, a malformed sha or another sha never applies (fail closed). */
export function forceRequestFor(root, env, sha, now = Date.now) {
  const req = readForceAdopt(root, env, now);
  if (!req) return null;
  const want = String(req.sha ?? '').toLowerCase();
  return /^[0-9a-f]{40}$/.test(want) && want === String(sha ?? '').toLowerCase() ? req : null;
}
// Best-effort: an unwritable/unreadable state dir (ENOTDIR, EACCES) must not turn a refusal into a throw.
const removeQuietly = (p) => { try { rmSync(p, { force: true }); } catch { /* unreachable state dir: nothing to clear */ } };
export const clearForceAdopt = (root, env = process.env) => removeQuietly(requestPath(root, env));
export const readForceWatch = (root, env = process.env) => readJson(watchPath(root, env));
/** true when a watch file EXISTS but cannot be read or parsed (EACCES, EIO, corrupt JSON). That is not "no watch": a second
 *  force would overwrite the open watch's last-good with an unproven build. Only a missing file (ENOENT) means absent. */
const watchUnreadable = (root, env) => {
  try { JSON.parse(readFileSync(watchPath(root, env), 'utf8')); return false; } catch (e) { return e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR'; } // a state dir that is not a directory cannot hold a watch
};
/** Rollbacks owed but whose marker could not be written to disk, keyed by watch path (this process only). Each entry keeps the
 *  whole watch, so the obligation survives a lost or unreadable watch file. */
const pendingRollbacks = new Map();
/** A watch that MOVED onto an unsmoked successor (carry / rebind) but whose write to disk failed, keyed by watch path (this process
 *  only). The disk still holds the stale pre-move record (old sha, declared `carryTo`); without this overlay every later tick would
 *  re-derive the move in memory, find the stale disk record "not the same watch" and return `none` forever, so an unhealthy successor
 *  would never be rolled back. The overlay is the watch the ticks decide from until the disk catches up. */
const unsavedMoves = new Map();
const clearWatch = (root, env) => { const p = watchPath(root, env); pendingRollbacks.delete(p); unsavedMoves.delete(p); removeQuietly(p); };
/** Write a moved watch; when the disk refuses it, keep it in memory instead (see {@link unsavedMoves}). Returns true when it landed. */
function saveMoved(root, env, moved) {
  const p = watchPath(root, env);
  try { writeJson(p, moved); unsavedMoves.delete(p); return true; } catch { unsavedMoves.set(p, moved); return false; }
}
/** Best-effort write of a watch the tick updated (ticks left, adoptedSeen): when it fails and the watch is one kept in memory, the
 *  updated copy replaces it, so a countdown still progresses. Never throws. */
function persistWatch(root, env, w) {
  const p = watchPath(root, env);
  try { writeJson(p, w); unsavedMoves.delete(p); } catch { const kept = unsavedMoves.get(p); if (kept && kept.sha === w.sha) unsavedMoves.set(p, w); }
}
/** The in-process marker applies only to the build it was recorded for: a later watch on the same path starts clean. */
const pendingFor = (root, env, sha) => { const p = pendingRollbacks.get(watchPath(root, env)); return p && p.sha === sha ? p.reason : undefined; };
/** The watch on disk, else the one an unsaved obligation is kept for in memory (a rollback owed must not vanish with its file). */
function currentWatch(root, env) {
  const p = watchPath(root, env);
  const disk = readForceWatch(root, env);
  const moved = unsavedMoves.get(p);
  if (moved) {
    // The in-memory move wins only while the disk still holds the SAME forced adoption at its stale pre-move sha, or cannot be read at
    // all (fail closed). A disk that caught up, was cleared, or holds another force never has its record shadowed.
    if (disk ? disk.startedAt === moved.startedAt && disk.sha !== moved.sha : watchUnreadable(root, env)) return moved;
    unsavedMoves.delete(p);
  }
  return disk ?? pendingRollbacks.get(p)?.watch ?? null;
}

/** Why a new force-adopt cannot start for this clone right now, else null. The ONE place these refusals live: the prepare step's
 *  sticky-rejection bypass asks it too, so a force that `recordForcedAdoption` would refuse never triggers a full re-smoke per tick.
 *  A watch is open (`watch-already-open`), exists but is unreadable (`watch-unreadable`), or a rollback is owed that never reached disk (`rollback-owed`). */
export function forceBlockedReason(root, env = process.env) {
  if (readForceWatch(root, env)) return 'watch-already-open';
  if (watchUnreadable(root, env)) return 'watch-unreadable'; // fail closed: an unreadable watch may be an open one
  if (pendingRollbacks.has(watchPath(root, env))) return 'rollback-owed'; // never adopt over an unpaid rollback
  return null;
}

/** Is the rollback watch a FORCED ready record needs really there? `'ok'` only for an intact watch for exactly `sha` that owes
 *  no rollback; `'missing'` (no file, or a watch for another build), `'unreadable'` (the file exists but cannot be read or parsed)
 *  and `'owed'` (a rollback is already owed) all mean the build must NOT be adopted: it would run with nothing to revert it. */
export function forcedWatchStatus(root, env = process.env, sha) {
  let text;
  try { text = readFileSync(watchPath(root, env), 'utf8'); } catch (e) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : 'unreadable'; }
  let watch;
  try { watch = JSON.parse(text); } catch { return 'unreadable'; }
  if (!watch || typeof watch !== 'object') return 'unreadable';
  if (!sha || watch.sha !== sha) return 'missing';
  return watch.rollbackPending ? 'owed' : 'ok';
}

/** true only when the line really landed: a forced adoption refuses to proceed unless every audit sink wrote. */
const appendLine = (p, line) => { try { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, line); return true; } catch { return false; } };

/** BEFORE the adoption: log it loudly (all three sinks must land), write the coroner-review record and open the durable
 *  health watch. Returns { ok:false } (nothing opened) when any sink fails, so the caller then does NOT adopt. */
export async function recordForcedAdoption({ root, env = process.env, request, sha, lastGood, smoke: rawSmoke, emit, now = Date.now }) {
  // A second force while a watch is open would overwrite its lastGood with the first forced (unproven) build.
  const blocked = forceBlockedReason(root, env);
  if (blocked) return { ok: false, reason: blocked };
  const at = new Date(now()).toISOString();
  // Check names come from the candidate's own smoke rows: keep them to printable ASCII and bounded, so they cannot forge audit lines.
  const smoke = rawSmoke ? { ...rawSmoke, failed: (rawSmoke.failed || []).slice(0, 20).map((n) => String(n).replace(/[^\x20-\x7e]/g, '?').slice(0, 80)) } : rawSmoke;
  const detail = { ruling: request.ruling, quote: request.quote, sha, lastGood: lastGood?.head ?? null, smoke: smoke ?? null, watchTicks: FORCE_ADOPT_WATCH_TICKS };
  const evented = (await emit?.({ kind: 'force-adopt', daemon: request.daemon, detail })) !== false;
  const handed = appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: adopting ${sha} though smoke ${smoke?.verdict ?? 'unknown'} `
    + `(failed: ${(smoke?.failed || []).join(',') || 'none'}); operator quote: "${request.quote}"; auto-rollback watch ${FORCE_ADOPT_WATCH_TICKS} ticks\n`);
  const coroned = appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-review', at, daemon: request.daemon, ruling: request.ruling, quote: request.quote, sha, lastGood: lastGood?.head ?? null, smoke: smoke ?? null })}\n`);
  // A sink that failed leaves the ones that landed claiming "adopting": retract them and consume the request, so a
  // later tick cannot re-log "adopting" on every retry, and a reader of the log is not told an adoption is in progress.
  const retract = async (reason) => {
    appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: NOT adopted ${sha} (${reason}); request consumed\n`);
    appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-aborted', at, daemon: request.daemon, ruling: request.ruling, sha, reason })}\n`);
    clearWatch(root, env);
    clearForceAdopt(root, env);
    try { await emit?.({ kind: 'force-adopt-aborted', daemon: request.daemon, detail: { ruling: request.ruling, sha, reason } }); } catch { /* best effort: the events sink may be the one that failed */ }
    return { ok: false, reason };
  };
  if (!(evented && handed && coroned)) return retract('audit-sink-failed');
  try { writeJson(watchPath(root, env), { daemon: request.daemon, ruling: request.ruling, sha, lastGood, ticksLeft: FORCE_ADOPT_WATCH_TICKS, bad: 0, startedAt: at }); } catch { return retract('watch-write-failed'); }
  clearForceAdopt(root, env);
  return { ok: true };
}

/** The adoption did not happen (lock refused, reset failed): drop the watch that was opened for it, and say so. */
export async function abortForcedAdoption({ root, env = process.env, request, sha, emit, now = Date.now }) {
  clearWatch(root, env);
  const at = new Date(now()).toISOString();
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: NOT adopted ${sha} (adoption did not complete); request consumed\n`);
  // The coroner already holds a `force-adopt-review` record for this sha: say it did not happen.
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-aborted', at, daemon: request.daemon, ruling: request.ruling, sha, reason: 'adoption-did-not-complete' })}\n`);
  await emit?.({ kind: 'force-adopt-aborted', daemon: request.daemon, detail: { ruling: request.ruling, sha } });
  clearForceAdopt(root, env);
}

/** A forced ready record was discarded without being adopted (refused as not the authorized sha, expired, other base): close
 *  the watch opened for it, which would otherwise only wait out the TTL and block the next force. A watch whose build already
 *  ran as head is left alone. Returns true when a watch was closed. */
export async function abortForcedWatch({ root, env = process.env, sha, reason, emit, now = Date.now }) {
  const watch = readForceWatch(root, env);
  // A watch that owes a rollback is never closed here: the build ran (the marker says so), so the revert is still owed.
  if (!watch || watch.sha !== sha || watch.adoptedSeen || watch.rollbackPending) return false;
  clearWatch(root, env);
  const at = new Date(now()).toISOString();
  const why = String(reason ?? 'discarded').replace(/[^\x20-\x7e]/g, '?').slice(0, 80); // the reason can carry a ref name
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: NOT adopted ${sha} (${why}); watch closed\n`);
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-aborted', at, daemon: watch.daemon, ruling: watch.ruling, sha, reason: why })}\n`);
  try { await emit?.({ kind: 'force-adopt-aborted', daemon: watch.daemon, detail: { ruling: watch.ruling, sha, reason: why } }); } catch { /* best effort */ }
  return true;
}

/** Drop the clone's ready candidate. When it is a FORCED record that will now never be adopted, its rollback watch is closed
 *  too (via {@link abortForcedWatch}); `keepSha` is the build that is (or is becoming) head, whose watch must stay. Every
 *  site that clears a ready record goes through here, so no path can strand a watch that blocks the next force. */
export async function dropReadyCandidate({ root, env = process.env, keepSha = null, reason, emit, now = Date.now }) {
  const ready = readReadyCandidate(root, env);
  clearReadyCandidate(root, env);
  const sha = ready?.adopt?.finalSha;
  if (ready?.forced === true && sha && sha !== keepSha) await abortForcedWatch({ root, env, sha, reason, emit, now });
}

/** A successor adopted WITHOUT its own smoke (skip-unrelated: the move changes nothing the daemon runs) still carries the forced
 *  build's unverified code, so the open watch moves onto it instead of being dropped as "superseded": same last-good, same ticks
 *  left, same owed-rollback marker. Only a watch for exactly `fromSha` moves. Returns true when it moved. */
export async function carryForceWatch({ root, env = process.env, fromSha, toSha, emit }) {
  if (!fromSha || !toSha || fromSha === toSha) return false;
  const path = watchPath(root, env);
  const watch = currentWatch(root, env);
  // Already moved by a watch tick that saw the intent (`carryTo`) and HEAD on the successor: nothing left to do.
  if (watch && watch.sha === toSha && !watch.carryTo) return true;
  if (!watch || (watch.sha !== fromSha && watch.carryTo !== fromSha)) return false; // chained: the previous intent is the source
  const { carryTo: _intent, ...rest } = watch;
  const moved = { ...rest, sha: toSha };
  const pending = pendingRollbacks.get(path);
  if (pending && (pending.sha === fromSha || pending.sha === watch.sha)) pendingRollbacks.set(path, { ...pending, sha: toSha, watch: { ...pending.watch, sha: toSha } });
  // A write the disk refuses is kept in memory (see unsavedMoves), so a tick in this process still guards the successor; a tick in
  // another process re-derives the move from the declared `carryTo` still on disk.
  if (!saveMoved(root, env, moved) && !pending) {
    // Not saved and nothing owed in memory: say so where an operator reads it, never a silent loss of rollback protection.
    appendLine(handoffFile(env), `- FORCE-ADOPT ${new Date().toISOString()} ${watch.daemon} ${watch.ruling}: force-adopt-watch-carry-failed ${fromSha} -> ${toSha}; the watch could not be moved onto the unsmoked successor\n`);
    return false;
  }
  await emit?.({ kind: 'force-adopt-watch-carried', daemon: watch.daemon, detail: { ruling: watch.ruling, from: fromSha, to: toSha } });
  return true;
}

/** Declare, BEFORE the clone's HEAD moves, that the open watch for `fromSha` is about to follow it to `toSha` (a skip-unrelated
 *  adoption). A watch tick that reads HEAD on `toSha` in the window before {@link carryForceWatch} runs (or after a crash between the
 *  reset and the carry) rebinds the watch itself instead of closing it as superseded. `toSha: null` withdraws the intent (the move failed). */
export function declareForceCarry({ root, env = process.env, fromSha, toSha = null }) {
  const watch = currentWatch(root, env);
  // A chained move (F -> S1 -> S2 before any tick or carry rebound the watch) names the previous intent as its source.
  if (!watch || (watch.sha !== fromSha && watch.carryTo !== fromSha)) return false;
  const { carryTo: _old, ...rest } = watch;
  try { writeJson(watchPath(root, env), toSha ? { ...rest, carryTo: toSha } : rest); return true; } catch { return false; }
}

/** True when an open force watch (on disk, or an owed rollback held in memory) guards `sha` (or is already declared to move onto it).
 *  An unsmoked-successor adoption must fail closed when this holds and the carry intent could not be declared: the watch would be
 *  left on a superseded sha and erased, dropping automatic rollback protection for the unverified code. */
export function forceWatchGuards({ root, env = process.env, sha }) {
  if (!sha) return false;
  const watch = currentWatch(root, env);
  if (watch) return watch.sha === sha || watch.carryTo === sha;
  return watchUnreadable(root, env); // fail closed: an unreadable watch file may be an open one (same rule as forceBlockedReason)
}

/** Move a watch that declared `carryTo` onto that successor: same last-good, ticks left and owed-rollback marker (on disk and in memory),
 *  intent cleared. The ONE rebind path for every tick site that finds HEAD on the declared successor. Returns the moved watch. */
function rebindToCarry(root, env, watch) {
  const { carryTo, ...rest } = watch;
  const moved = { ...rest, sha: carryTo };
  const p = watchPath(root, env);
  const pending = pendingRollbacks.get(p);
  if (pending && pending.sha === watch.sha) pendingRollbacks.set(p, { ...pending, sha: carryTo, watch: { ...pending.watch, sha: carryTo } });
  saveMoved(root, env, moved); // a write the disk refuses stays in memory: ticks keep deciding from `moved`, never from the stale disk record
  return moved;
}

/** PURE. One watch tick: fail closed on a failed health check or a crash loop, else count down. */
export function evaluateForceWatch({ watch, healthy, restarts = 0, maxRestarts = FORCE_ADOPT_MAX_RESTARTS }) {
  // A rollback that already failed stays mandatory: a later healthy probe must not forget it and count the watch down.
  if (watch.rollbackPending) return { action: 'rollback', reason: watch.rollbackPending, watch };
  if (healthy !== true) return { action: 'rollback', reason: 'health-failed', watch };
  if (restarts >= maxRestarts) return { action: 'rollback', reason: 'crash-loop', watch };
  const ticksLeft = (watch.ticksLeft ?? 0) - 1;
  if (ticksLeft <= 0) return { action: 'done', watch: { ...watch, ticksLeft: 0 } };
  return { action: 'continue', watch: { ...watch, ticksLeft } };
}

/** One tick of the post-force health watch. `probe(root)` -> { healthy, restarts? }; `rollback(lastGood)` -> { ok }. */
export async function runForceWatchTick({ root, env = process.env, probe, rollback, emit, now = Date.now, notBefore = null, currentHead = null }) {
  let watch = currentWatch(root, env);
  if (!watch) return { action: 'none' };
  // A watch opened by THIS tick's own forced adoption starts COUNTING at the next tick, but its health is still checked now: the
  // running process still has the previous (good) code loaded, so a build that can no longer even import is reverted before the
  // restart onto it (afterwards nothing would run this watcher: a daemon that fails to import its own rebuild module never ticks).
  const openedThisTick = notBefore !== null && Date.parse(watch.startedAt) >= notBefore;
  // A `currentHead` FUNCTION that returns nothing (or throws) means git could not be read: that is a failure, never the same as
  // "no currentHead supplied" (a plain value, or null), which skips head tracking. Unknown never counts down or completes a watch.
  const readHead = () => {
    if (typeof currentHead !== 'function') return { head: currentHead, unreadable: false };
    let h = null;
    try { h = currentHead(); } catch { h = null; }
    return typeof h === 'string' && h ? { head: h, unreadable: false } : { head: null, unreadable: true };
  };
  const first = readHead(); // lazy: no git call unless a watch exists
  const head = first.head;
  // State writes here are best-effort: a failed write must never stop the health check or the rollback that follows.
  const persist = (w) => persistWatch(root, env, w);
  // An unsmoked successor adoption declared this move (`carryTo`) before it reset HEAD: HEAD on that successor is the SAME watched
  // code, not a superseding build, so rebind to it here (the adopting process's own carry may not have run yet, or may have died).
  if (watch.carryTo && head !== null && head === watch.carryTo) watch = rebindToCarry(root, env, watch);
  const expire = async () => {
    // The forced build never became head. Its ready candidate never passed smoke, so drop it too: left behind, a later
    // write-lock holder would adopt it with no health watch.
    if (readReadyCandidate(root, env)?.adopt?.finalSha === watch.sha) clearReadyCandidate(root, env);
    clearWatch(root, env);
    await emit?.({ kind: 'force-adopt-watch-expired', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head } });
    return { action: 'expired' };
  };
  const expired = () => now() - Date.parse(watch.startedAt) > FORCE_ADOPT_TTL_MS;
  // The build has not been seen running and its ready record is still waiting to be adopted: it is NOT head yet. A HEAD that cannot
  // be read right now (a transient git failure) says nothing about it, so the tick RETRIES with the watch and the ready record kept:
  // no rollback (it would read "already reverted" on last-good and drop the record), no supersede, no marker. The retry is bounded
  // by the same TTL as a build that never becomes head. Once the build has run, or no ready record is left (a direct adoption),
  // an unreadable HEAD is a failure again (below).
  if (!watch.adoptedSeen && readReadyCandidate(root, env)?.adopt?.finalSha === watch.sha && (first.unreadable || (head !== null && head !== watch.sha))) {
    // A marker left by an earlier unreadable tick of this same never-run build is stale: drop it, or the next tick would read it as "ran".
    if (watch.rollbackPending || pendingRollbacks.has(watchPath(root, env))) {
      pendingRollbacks.delete(watchPath(root, env));
      const { rollbackPending: _stale, ...clean } = watch;
      persist(clean);
    }
    return expired() ? expire() : { action: 'waiting' };
  }
  // Ticks only count once the forced build is really the running head (a ready-only job adopts a tick or more later).
  if (head !== null && head !== watch.sha) {
    if (watch.adoptedSeen || watch.rollbackPending) { clearWatch(root, env); await emit?.({ kind: 'force-adopt-watch-superseded', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head } }); return { action: 'superseded' }; }
    if (expired()) return expire();
    return { action: 'waiting' };
  }
  if (head !== null && !watch.adoptedSeen) { watch.adoptedSeen = true; persist(watch); }
  let health;
  if (first.unreadable) health = { healthy: false }; // no head, no verdict on the build: do not even trust a healthy probe
  else { try { health = await probe(root); } catch { health = { healthy: false }; } }
  // The probe is async: a concurrent tick may have recorded an owed rollback, or closed the watch, since our first read. Decide
  // from the CURRENT record, never the stale snapshot, so a healthy result can neither erase a mandatory rollback nor
  // count down / re-create a watch another tick already closed.
  const fresh = currentWatch(root, env);
  if (!fresh || fresh.sha !== watch.sha) return { action: 'none' };
  watch = { ...fresh, adoptedSeen: fresh.adoptedSeen === true || watch.adoptedSeen === true };
  // The head was read BEFORE the probe too: a sibling that adopted a newer build meanwhile means this build is no longer running, so a
  // healthy result says nothing about it (no countdown, no false "passed") and an unhealthy one owes no revert.
  const second = first.unreadable ? first : readHead();
  const headNow = second.head;
  // A skip-unrelated successor may have been adopted while the probe ran (intent declared, HEAD reset, the adopter's own carry not
  // yet run): HEAD on the DECLARED successor is the same watched code, so the watch follows it (keeping any owed rollback) instead
  // of being closed as superseded. The probe judged the old head, so this tick neither counts down nor rolls back.
  // Re-read the record AFTER the head read: the intent may be declared in the gap between our first read and the (git-spawning) head read.
  const latest = currentWatch(root, env);
  if (latest?.sha === watch.sha && latest.carryTo && headNow !== null && headNow === latest.carryTo) { rebindToCarry(root, env, latest); return { action: 'none' }; }
  if (headNow !== null && headNow !== watch.sha) {
    clearWatch(root, env);
    await emit?.({ kind: 'force-adopt-watch-superseded', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head: headNow } });
    return { action: 'superseded' };
  }
  const headUnreadable = first.unreadable || second.unreadable;
  if (headUnreadable) health = { healthy: false }; // unreadable after the probe: the probe's verdict cannot be tied to this build
  // Every write/clear below follows an await on a rollback that may take the clone lock: act only if this exact watch is still the
  // one on disk (or kept in memory), never on the snapshot (it may have been closed, or replaced by a force for another build).
  const sameWatch = () => currentWatch(root, env)?.sha === watch.sha;
  const pendingReason = watch.rollbackPending || pendingFor(root, env, watch.sha); // disk marker, else the in-process one
  let verdict = evaluateForceWatch({ watch: pendingReason ? { ...watch, rollbackPending: pendingReason } : watch, healthy: health?.healthy, restarts: health?.restarts ?? 0 });
  if (headUnreadable && !pendingReason && verdict.action === 'rollback') verdict = { ...verdict, reason: 'head-unreadable' };
  if (openedThisTick && (verdict.action === 'continue' || verdict.action === 'done')) return { action: 'none' }; // healthy on arrival: counting starts next tick
  if (verdict.action === 'continue') { persist(verdict.watch); return { action: 'continue', ticksLeft: verdict.watch.ticksLeft }; }
  if (verdict.action === 'done') { clearWatch(root, env); await emit?.({ kind: 'force-adopt-watch-passed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha } }); return { action: 'done' }; }
  const at = new Date(now()).toISOString();
  let result;
  // The owed-rollback marker is recorded BEFORE the rollback starts (not after it fails): the rollback awaits the clone's write lock,
  // and an overlapping healthy tick that completes meanwhile would otherwise close the watch and erase the obligation. Written
  // directly (not the swallowing persist): if the disk refuses it, the whole obligation is kept in memory instead (it blocks any new
  // force-adopt and every tick retries it). It is cleared only below, once the rollback has succeeded (or the build was superseded).
  const owed = { ...watch, rollbackPending: verdict.reason };
  const markOwed = () => {
    try { writeJson(watchPath(root, env), owed); pendingRollbacks.delete(watchPath(root, env)); return true; } catch {
      pendingRollbacks.set(watchPath(root, env), { sha: watch.sha, reason: verdict.reason, watch: owed });
      return false;
    }
  };
  let saved = markOwed();
  // `sha` lets the rollback verify, under the clone's write lock, that the watched build is STILL head before it reverts anything.
  try { result = await rollback(watch.lastGood, { sha: watch.sha }); } catch { result = { ok: false }; }
  if (!sameWatch()) return { action: 'none' }; // another tick closed (or replaced) this watch during the rollback: it owns the outcome
  if (result?.superseded === true) {
    // The head the rollback found is the DECLARED successor of an unsmoked adoption: the same code, so the watch (and any owed
    // rollback) follows it. Re-read the record: the intent may have been declared after our snapshot.
    const cur = currentWatch(root, env);
    if (cur?.carryTo && result.head && cur.carryTo === result.head) { rebindToCarry(root, env, cur); return { action: 'none' }; }
    // A superseding build was adopted while the probe/rollback ran: it is running, the watched build is not, so there is nothing
    // to revert. Close the watch without touching the newer build. The forced build's own ready record (never adopted, so never
    // watched again) goes too: left behind, a later write-lock holder would adopt it with no health watch.
    if (readReadyCandidate(root, env)?.adopt?.finalSha === watch.sha) clearReadyCandidate(root, env);
    clearWatch(root, env);
    await emit?.({ kind: 'force-adopt-watch-superseded', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head: result.head ?? null } });
    return { action: 'superseded' };
  }
  if (!result?.ok) {
    // Re-confirm the marker (a write that failed before the rollback may succeed now); if it still cannot be saved, the obligation
    // stays in memory and the handoff file says so, so an operator can see the build is still owed a revert.
    if (!saved) saved = markOwed();
    if (!saved) appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: force-adopt-rollback-failed ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason}); marker could not be saved, kept in memory\n`);
    await emit?.({ kind: 'force-adopt-rollback-failed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, reason: verdict.reason } });
    return { action: 'rollback-failed', reason: verdict.reason };
  }
  clearWatch(root, env);
  await emit?.({ kind: 'force-adopt-rolled-back', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, lastGood: watch.lastGood?.head ?? null, reason: verdict.reason } });
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: ROLLED BACK ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason})\n`);
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-rolled-back', at, daemon: watch.daemon, ruling: watch.ruling, sha: watch.sha, reason: verdict.reason })}\n`);
  return { action: 'rollback', reason: verdict.reason };
}
