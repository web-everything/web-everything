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
 *
 * THE WATCH RULE (operator ruling R672, one rule instead of per-path patches):
 *  - EVERY change to the watch record goes through {@link transitionWatch}: one function, under the watch's own lock, with a
 *    compare-and-swap on the record's `version`. Nothing else writes or removes the watch file.
 *  - The watch retires only when its ticks are healthy (`passed`), a rollback completes (`rolled-back`, or HEAD is already the
 *    rollback target), or the forced build never ran (`never-adopted`: its adoption was aborted / discarded / expired). It NEVER
 *    retires because another build superseded the watched one.
 *  - The watch and its rollback target (`lastGood`) carry over to ANY successor build: a tick that finds HEAD on another build
 *    moves the watch onto it ({@link runForceWatchTick} `follow`). Because it follows HEAD, no adoption path (smoked, unsmoked,
 *    no-worse, fallback, ready-record) needs to know about the watch at all.
 *  - Before any rollback, HEAD is compared with the watched sha under the clone's write lock (rebuild.mjs); a mismatch is
 *    reported as `superseded`, and the watch follows HEAD instead of reverting a build it does not watch.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** The watch file as it is: `missing` (ENOENT / a state dir that is not a directory), `unreadable` (EACCES, EIO, corrupt JSON — that
 *  is NOT "no watch": a second force would overwrite the open watch's last-good with an unproven build) or `ok`. */
function readWatchRecord(root, env) {
  let text;
  try { text = readFileSync(watchPath(root, env), 'utf8'); } catch (e) { return { state: e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : 'unreadable', watch: null }; }
  try { const w = JSON.parse(text); return w && typeof w === 'object' ? { state: 'ok', watch: w } : { state: 'unreadable', watch: null }; } catch { return { state: 'unreadable', watch: null }; }
}
const watchUnreadable = (root, env) => readWatchRecord(root, env).state === 'unreadable';

/** Rollbacks owed whose marker could not be written to disk, keyed by watch path (this process only). Each entry keeps the whole
 *  watch, so the obligation survives a lost or unreadable watch file; {@link blocked} refuses a new force until it is paid. */
const pendingRollbacks = new Map();
/** The in-process marker applies only to the build it was recorded for: a later watch on the same path starts clean. */
const pendingFor = (root, env, sha) => { const p = pendingRollbacks.get(watchPath(root, env)); return p && p.sha === sha ? p.reason : undefined; };
/** The watch on disk, else the one an unsaved obligation is kept for in memory (a rollback owed must not vanish with its file). */
const currentWatch = (root, env) => readForceWatch(root, env) ?? pendingRollbacks.get(watchPath(root, env))?.watch ?? null;

// ── THE one writer ───────────────────────────────────────────────────────────────────────────────────────────────
const WATCH_LOCK_WAIT_MS = 2000;
const WATCH_LOCK_STALE_MS = 30_000;
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** Run `fn` holding the watch's own lock (an atomically created directory next to the record; a holder that died is taken over once
 *  it is older than WATCH_LOCK_STALE_MS). Never throws: `{ ok:false, reason }` when the lock could not be taken or `fn` threw. */
function withWatchLock(root, env, fn) {
  const dir = `${watchPath(root, env)}.lock`;
  const deadline = Date.now() + WATCH_LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(dirname(dir), { recursive: true }); mkdirSync(dir); break; } catch (e) {
      if (e?.code !== 'EEXIST') return { ok: false, reason: 'lock-failed' };
      try { if (Date.now() - statSync(dir).mtimeMs > WATCH_LOCK_STALE_MS) { rmSync(dir, { recursive: true, force: true }); continue; } } catch { /* raced with the holder's release */ }
      if (Date.now() > deadline) return { ok: false, reason: 'lock-busy' };
      sleepSync(10);
    }
  }
  try { return { ok: true, value: fn() }; } catch { return { ok: false, reason: 'write-failed' }; } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * The ONLY way the watch record changes. `decide(current, state)` runs SYNCHRONOUSLY under the watch lock against the record as it is
 * on disk right now (`state`: 'ok' | 'missing' | 'unreadable') and returns `{ next?, ...info }`: `next` an object writes it (its
 * `version` is bumped), `next: null` retires the watch, no `next` leaves it alone. `expectVersion` is the compare-and-swap: when
 * given and the record's version moved since the caller read it, nothing is written (`reason: 'stale'`).
 * Returns `{ ok, changed, out, watch, reason }`; `ok:false` means the transition did not happen (the caller fails closed).
 */
export function transitionWatch(root, env, decide, { expectVersion } = {}) {
  const p = watchPath(root, env);
  const locked = withWatchLock(root, env, () => {
    const { state, watch: cur } = readWatchRecord(root, env);
    if (expectVersion !== undefined && (cur?.version ?? 0) !== expectVersion) return { stale: true };
    const out = decide(cur, state) ?? {};
    if (out.next === undefined) return { out, changed: false, watch: cur };
    if (out.next === null) {
      rmSync(p, { force: true });
      if (readWatchRecord(root, env).state !== 'missing') throw new Error('watch not removed');
      pendingRollbacks.delete(p);
      return { out, changed: true, watch: null };
    }
    const next = { ...out.next, version: (cur?.version ?? 0) + 1 };
    writeJson(p, next);
    return { out, changed: true, watch: next };
  });
  if (!locked.ok) return { ok: false, changed: false, reason: locked.reason, out: {} };
  if (locked.value.stale) return { ok: false, changed: false, reason: 'stale', out: {} };
  return { ok: true, ...locked.value };
}

/** Retire the watch (through {@link transitionWatch}). `sha` restricts it to the watch for that build; `unlessRan` refuses a watch that
 *  owes a rollback or whose build has been seen running (those only ever retire as `passed` / `rolled-back`). Returns true when retired. */
function retireWatch(root, env, { sha = null, unlessRan = false } = {}) {
  const t = transitionWatch(root, env, (cur) => {
    if (!cur) return {};
    if (sha && cur.sha !== sha) return {};
    if (unlessRan && (cur.adoptedSeen || cur.rollbackPending)) return {};
    return { next: null };
  });
  return t.ok && t.changed;
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
  const { state, watch } = readWatchRecord(root, env);
  if (state !== 'ok') return state;
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
  const detail = { ruling: request.ruling, quote: request.quote, sha, lastGood: lastGood?.head ?? null, smoke: smoke ?? null, watchTicks: FORCE_ADOPT_WATCH_TICKS,
    ...(env.WE_RULINGS_FILE ? { rulingsFile: rulingsPath(env) } : {}) };
  let evented = false;
  try { evented = (await emit?.({ kind: 'force-adopt', daemon: request.daemon, detail })) === true; } catch { /* a throwing sink failed too */ }
  const handed = appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: adopting ${sha} though smoke ${smoke?.verdict ?? 'unknown'} `
    + `(failed: ${(smoke?.failed || []).join(',') || 'none'}); operator quote: "${request.quote}"; auto-rollback watch ${FORCE_ADOPT_WATCH_TICKS} ticks\n`);
  const coroned = appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-review', at, daemon: request.daemon, ruling: request.ruling, quote: request.quote, sha, lastGood: lastGood?.head ?? null, smoke: smoke ?? null })}\n`);
  // A sink that failed leaves the ones that landed claiming "adopting": retract them and consume the request, so a
  // later tick cannot re-log "adopting" on every retry, and a reader of the log is not told an adoption is in progress.
  const retract = async (reason) => {
    appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: NOT adopted ${sha} (${reason}); request consumed\n`);
    appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-aborted', at, daemon: request.daemon, ruling: request.ruling, sha, reason })}\n`);
    // Every retract path precedes a successful open by this invocation. Any watch here belongs to a competing force.
    clearForceAdopt(root, env);
    try { await emit?.({ kind: 'force-adopt-aborted', daemon: request.daemon, detail: { ruling: request.ruling, sha, reason } }); } catch { /* best effort: the events sink may be the one that failed */ }
    return { ok: false, reason };
  };
  if (!(evented && handed && coroned)) return retract('audit-sink-failed');
  // Opened through the one writer; refused (never overwritten) when another watch appeared since the check above.
  const opened = transitionWatch(root, env, (cur, state) => (cur || state === 'unreadable'
    ? { raced: true }
    : { next: { daemon: request.daemon, ruling: request.ruling, sha, lastGood, ticksLeft: FORCE_ADOPT_WATCH_TICKS, bad: 0, startedAt: at } }));
  if (!opened.ok) return retract('watch-write-failed');
  if (opened.out.raced) return retract(forceBlockedReason(root, env) ?? 'watch-already-open');
  clearForceAdopt(root, env);
  return { ok: true };
}

/** The adoption did not happen (lock refused, reset failed): drop the watch that was opened for it, and say so. */
export async function abortForcedAdoption({ root, env = process.env, request, sha, emit, now = Date.now }) {
  retireWatch(root, env, { sha, unlessRan: true });
  const at = new Date(now()).toISOString();
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: NOT adopted ${sha} (adoption did not complete); request consumed\n`);
  // The coroner already holds a `force-adopt-review` record for this sha: say it did not happen.
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-aborted', at, daemon: request.daemon, ruling: request.ruling, sha, reason: 'adoption-did-not-complete' })}\n`);
  await emit?.({ kind: 'force-adopt-aborted', daemon: request.daemon, detail: { ruling: request.ruling, sha } });
  clearForceAdopt(root, env);
}

/** A forced ready record was discarded without being adopted (refused as not the authorized sha, expired, other base): close
 *  the watch opened for it, which would otherwise only wait out the TTL and block the next force. A watch whose build already
 *  ran as head, or that owes a rollback, is left alone (the build ran: the revert is still owed). Returns true when a watch was closed. */
export async function abortForcedWatch({ root, env = process.env, sha, reason, emit, now = Date.now }) {
  const watch = readForceWatch(root, env);
  if (!watch || watch.sha !== sha || watch.adoptedSeen || watch.rollbackPending) return false;
  if (!retireWatch(root, env, { sha, unlessRan: true })) return false;
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

/** One tick of the post-force health watch. `probe(root)` -> { healthy, restarts? }; `rollback(lastGood, { sha })` -> { ok } or
 *  { superseded, head } when HEAD is no longer the watched build. */
export async function runForceWatchTick({ root, env = process.env, probe, rollback, emit, now = Date.now, notBefore = null, currentHead = null }) {
  let watch = currentWatch(root, env);
  if (!watch) return { action: 'none' };
  const p = watchPath(root, env);
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
  const readySha = () => readReadyCandidate(root, env)?.adopt?.finalSha;
  const expired = () => now() - Date.parse(watch.startedAt) > FORCE_ADOPT_TTL_MS;
  const expire = async () => {
    // The forced build never became head. Its ready candidate never passed smoke, so drop it too: left behind, a later
    // write-lock holder would adopt it with no health watch.
    if (readySha() === watch.sha) clearReadyCandidate(root, env);
    retireWatch(root, env, { sha: watch.sha, unlessRan: true });
    await emit?.({ kind: 'force-adopt-watch-expired', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head } });
    return { action: 'expired' };
  };
  /** The watch follows HEAD onto a successor build (ANY build: smoked, unsmoked, no-worse, fallback, ready record), keeping its
   *  rollback target, ticks left and owed-rollback marker. HEAD already on the rollback target means the revert happened some other
   *  way: that completes the watch. Returns { watch } (moved), { reverted }, { gone } (another writer closed or moved it) or { failed }. */
  // `recordSha` is the sha of the record as it is on DISK; `watch.sha` is the build this tick decides about. They differ only when a
  // follow could not be written (`unsaved`): the tick then keeps deciding in memory, so a refused write never suppresses the rollback
  // of an unhealthy successor, while the disk keeps the old record (fail closed: it is never retired or counted down from memory).
  let recordSha = watch.sha;
  let unsaved = false;
  const follow = async (toHead) => {
    const t = transitionWatch(root, env, (cur) => {
      if (!cur || cur.sha !== recordSha) return { gone: true };
      if (cur.sha === toHead) return { same: true }; // already there (a rollback that found HEAD on the watched build's own record)
      if (cur.lastGood?.head && cur.lastGood.head === toHead) return { next: null, reverted: true };
      return { next: { ...cur, sha: toHead, adoptedSeen: true, lineage: [...(Array.isArray(cur.lineage) ? cur.lineage : []), cur.sha].slice(-10) } };
    });
    if (!t.ok) return { failed: true };
    if (t.out.same) return { watch: t.watch };
    if (t.out.reverted) {
      await emit?.({ kind: 'force-adopt-watch-reverted', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: recordSha, head: toHead } });
      return { reverted: true };
    }
    const pend = pendingRollbacks.get(p);
    if (t.out.gone) {
      // No record on disk but an owed rollback kept in memory (its file was lost): the obligation follows HEAD in memory too.
      if (pend && pend.sha === recordSha) {
        const moved = { ...pend.watch, sha: toHead, adoptedSeen: true };
        pendingRollbacks.set(p, { ...pend, sha: toHead, watch: moved });
        recordSha = toHead; unsaved = false;
        return { watch: moved };
      }
      return { gone: true };
    }
    if (pend && pend.sha === recordSha) pendingRollbacks.set(p, { ...pend, sha: toHead, watch: { ...pend.watch, sha: toHead } });
    await emit?.({ kind: 'force-adopt-watch-followed', daemon: watch.daemon, detail: { ruling: watch.ruling, from: recordSha, to: toHead } });
    recordSha = toHead; unsaved = false;
    return { watch: t.watch };
  };
  const followResult = (f) => (f.failed ? { action: 'follow-failed' } : f.reverted ? { action: 'reverted' } : f.gone ? { action: 'none' } : null);
  /** Follow HEAD; when the write is refused, hold the move in memory for this tick. Returns a terminal tick result, or null to go on. */
  const moveTo = async (toHead) => {
    const f = await follow(toHead);
    if (f.failed) { watch = { ...watch, sha: toHead, adoptedSeen: true }; unsaved = true; return null; }
    const stop = followResult(f);
    if (stop) return stop;
    watch = f.watch;
    return null;
  };

  // The build has not been seen running and its ready record is still waiting to be adopted: it is NOT head yet. A HEAD that cannot
  // be read right now (a transient git failure) says nothing about it, so the tick RETRIES with the watch and the ready record kept:
  // no rollback (it would read "already reverted" on last-good and drop the record), no follow, no marker. The retry is bounded
  // by the same TTL as a build that never becomes head. Once the build has run, or no ready record is left (a direct adoption),
  // an unreadable HEAD is a failure again (below).
  if (!watch.adoptedSeen && readySha() === watch.sha && (first.unreadable || (head !== null && head !== watch.sha))) {
    // A marker left by an earlier unreadable tick of this same never-run build is stale: drop it, or the next tick would read it as "ran".
    if (watch.rollbackPending || pendingRollbacks.has(p)) {
      pendingRollbacks.delete(p);
      transitionWatch(root, env, (cur) => {
        if (!cur || cur.sha !== watch.sha || !cur.rollbackPending) return {};
        const { rollbackPending: _stale, ...clean } = cur;
        return { next: clean };
      });
    }
    return expired() ? expire() : { action: 'waiting' };
  }
  // HEAD is on another build. If the watched build ran (seen, owed a revert, or its ready record is gone and HEAD is not simply still
  // on last-good), that build was SUPERSEDED: the watch follows HEAD, it is never erased. Otherwise the forced build has not run yet.
  if (head !== null && head !== watch.sha) {
    const ran = watch.adoptedSeen === true || !!watch.rollbackPending || !!pendingFor(root, env, watch.sha)
      || (readySha() !== watch.sha && head !== watch.lastGood?.head);
    if (!ran) return expired() ? expire() : { action: 'waiting' };
    const stop = await moveTo(head);
    if (stop) return stop;
  }
  if (head !== null && !watch.adoptedSeen) {
    const t = transitionWatch(root, env, (cur) => (cur && cur.sha === watch.sha && !cur.adoptedSeen ? { next: { ...cur, adoptedSeen: true } } : {}));
    watch = { ...(t.ok && t.watch ? t.watch : watch), adoptedSeen: true };
  }
  let health;
  if (first.unreadable) health = { healthy: false }; // no head, no verdict on the build: do not even trust a healthy probe
  else { try { health = await probe(root); } catch { health = { healthy: false }; } }
  // The head was read BEFORE the probe too: a build adopted meanwhile means the probed one is no longer running, so a healthy result
  // says nothing about it (no countdown, no false "passed") and an unhealthy one owes no revert: the watch follows the new HEAD.
  const second = first.unreadable ? first : readHead();
  const headNow = second.head;
  // The probe is async: a concurrent tick may have recorded an owed rollback, moved, or closed the watch since our first read. Decide
  // from the CURRENT record, never the stale snapshot, so a healthy result can neither erase a mandatory rollback nor
  // count down / re-create a watch another tick already closed.
  const fresh = unsaved ? watch : currentWatch(root, env); // an unsaved move is the only record this tick has: the disk still holds the old sha
  if (!fresh || fresh.sha !== watch.sha) return { action: 'none' };
  watch = { ...fresh, adoptedSeen: fresh.adoptedSeen === true || watch.adoptedSeen === true };
  if (headNow !== null && headNow !== watch.sha) {
    const stop = await moveTo(headNow);
    return stop ?? { action: 'followed' };
  }
  const headUnreadable = first.unreadable || second.unreadable;
  if (headUnreadable) health = { healthy: false }; // unreadable after the probe: the probe's verdict cannot be tied to this build
  const pendingReason = watch.rollbackPending || pendingFor(root, env, watch.sha); // disk marker, else the in-process one
  let verdict = evaluateForceWatch({ watch: pendingReason ? { ...watch, rollbackPending: pendingReason } : watch, healthy: health?.healthy, restarts: health?.restarts ?? 0 });
  if (headUnreadable && !pendingReason && verdict.action === 'rollback') verdict = { ...verdict, reason: 'head-unreadable' };
  if (openedThisTick && (verdict.action === 'continue' || verdict.action === 'done')) return { action: 'none' }; // healthy on arrival: counting starts next tick
  const expectVersion = fresh.version ?? 0;
  if (verdict.action === 'continue') {
    // Compare-and-swap on the version: an overlapping tick that already counted (or moved) the watch makes this one a no-op.
    const t = transitionWatch(root, env, (cur) => (cur && cur.sha === watch.sha ? { next: { ...cur, ticksLeft: verdict.watch.ticksLeft } } : {}), { expectVersion });
    if (!t.ok && t.reason === 'stale') return { action: 'none' };
    return { action: 'continue', ticksLeft: verdict.watch.ticksLeft };
  }
  if (verdict.action === 'done') {
    // Retires only a watch that still owes nothing: a rollback owed meanwhile (disk or memory) keeps it.
    const t = transitionWatch(root, env, (cur) => (cur && cur.sha === watch.sha && !cur.rollbackPending && !pendingFor(root, env, watch.sha) ? { next: null } : {}), { expectVersion });
    if (!t.ok || !t.changed) return { action: 'none' };
    await emit?.({ kind: 'force-adopt-watch-passed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha } });
    return { action: 'done' };
  }
  const at = new Date(now()).toISOString();
  let result;
  // The owed-rollback marker is recorded BEFORE the rollback starts (not after it fails): the rollback awaits the clone's write lock,
  // and an overlapping healthy tick that completes meanwhile would otherwise close the watch and erase the obligation. Recorded through
  // the one writer: if the disk refuses it, the whole obligation is kept in memory instead (it blocks any new force-adopt and every
  // tick retries it). It is cleared only below, once the rollback has succeeded (or HEAD is already the rollback target).
  const markOwed = () => {
    const t = transitionWatch(root, env, (cur) => (cur && cur.sha === recordSha ? { next: { ...cur, rollbackPending: verdict.reason } } : { other: !!cur }));
    if (t.ok && (t.changed || t.out.other)) { if (t.changed) pendingRollbacks.delete(p); return true; } // `other`: the watch already moved on, nothing of ours to keep
    pendingRollbacks.set(p, { sha: watch.sha, reason: verdict.reason, watch: { ...watch, rollbackPending: verdict.reason } });
    return false;
  };
  let saved = markOwed();
  // `sha` lets the rollback verify, under the clone's write lock, that the watched build is STILL head before it reverts anything.
  try { result = await rollback(watch.lastGood, { sha: watch.sha }); } catch { result = { ok: false }; }
  const cur = currentWatch(root, env);
  if (!cur || cur.sha !== recordSha) return { action: 'none' }; // another tick closed (or moved) this watch during the rollback: it owns the outcome
  if (result?.superseded === true) {
    // HEAD is no longer the watched build (a successor was adopted while the probe/rollback waited): nothing to revert HERE, and the
    // watch is not closed. It follows HEAD with its rollback target and owed marker; the next tick reverts the successor if still owed.
    const stop = await moveTo(result.head);
    return stop ?? { action: 'followed' };
  }
  if (!result?.ok) {
    // Re-confirm the marker (a write that failed before the rollback may succeed now); if it still cannot be saved, the obligation
    // stays in memory and the handoff file says so, so an operator can see the build is still owed a revert.
    if (!saved) saved = markOwed();
    if (!saved) appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: force-adopt-rollback-failed ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason}); marker could not be saved, kept in memory\n`);
    await emit?.({ kind: 'force-adopt-rollback-failed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, reason: verdict.reason } });
    return { action: 'rollback-failed', reason: verdict.reason };
  }
  // The rollback completed. If the disk refuses to remove the record, the next tick finds HEAD on the rollback target and retires it then.
  retireWatch(root, env, { sha: recordSha });
  pendingRollbacks.delete(p); // the obligation is paid (also when it only ever lived in memory)
  await emit?.({ kind: 'force-adopt-rolled-back', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, lastGood: watch.lastGood?.head ?? null, reason: verdict.reason } });
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: ROLLED BACK ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason})\n`);
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-rolled-back', at, daemon: watch.daemon, ruling: watch.ruling, sha: watch.sha, reason: verdict.reason })}\n`);
  return { action: 'rollback', reason: verdict.reason };
}
