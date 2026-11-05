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
/** Rollbacks owed but whose marker could not be written to disk, keyed by watch path (this process only). */
const pendingRollbacks = new Map();
const clearWatch = (root, env) => { pendingRollbacks.delete(watchPath(root, env)); removeQuietly(watchPath(root, env)); };
/** The in-process marker applies only to the build it was recorded for: a later watch on the same path starts clean. */
const pendingFor = (root, env, sha) => { const p = pendingRollbacks.get(watchPath(root, env)); return p && p.sha === sha ? p.reason : undefined; };

/** true only when the line really landed: a forced adoption refuses to proceed unless every audit sink wrote. */
const appendLine = (p, line) => { try { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, line); return true; } catch { return false; } };

/** BEFORE the adoption: log it loudly (all three sinks must land), write the coroner-review record and open the durable
 *  health watch. Returns { ok:false } (nothing opened) when any sink fails, so the caller then does NOT adopt. */
export async function recordForcedAdoption({ root, env = process.env, request, sha, lastGood, smoke: rawSmoke, emit, now = Date.now }) {
  // A second force while a watch is open would overwrite its lastGood with the first forced (unproven) build.
  if (readForceWatch(root, env)) return { ok: false, reason: 'watch-already-open' };
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
  if (!watch || watch.sha !== sha || watch.adoptedSeen) return false;
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
  let watch = readForceWatch(root, env);
  if (!watch) return { action: 'none' };
  // A watch opened by THIS tick's own forced adoption starts counting at the next tick.
  if (notBefore !== null && Date.parse(watch.startedAt) >= notBefore) return { action: 'none' };
  const head = typeof currentHead === 'function' ? currentHead() : currentHead; // lazy: no git call unless a watch exists
  // Ticks only count once the forced build is really the running head (a ready-only job adopts a tick or more later).
  if (head !== null && head !== watch.sha) {
    if (watch.adoptedSeen) { clearWatch(root, env); await emit?.({ kind: 'force-adopt-watch-superseded', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head } }); return { action: 'superseded' }; }
    if (now() - Date.parse(watch.startedAt) > FORCE_ADOPT_TTL_MS) {
      // The forced build never became head. Its ready candidate never passed smoke, so drop it too: left behind, a later
      // write-lock holder would adopt it with no health watch.
      if (readReadyCandidate(root, env)?.adopt?.finalSha === watch.sha) clearReadyCandidate(root, env);
      clearWatch(root, env);
      await emit?.({ kind: 'force-adopt-watch-expired', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head } });
      return { action: 'expired' };
    }
    return { action: 'waiting' };
  }
  // State writes here are best-effort: a failed write must never stop the health check or the rollback that follows.
  const persist = (w) => { try { writeJson(watchPath(root, env), w); } catch { /* the next tick re-derives it */ } };
  if (head !== null && !watch.adoptedSeen) { watch.adoptedSeen = true; persist(watch); }
  let health;
  try { health = await probe(root); } catch { health = { healthy: false }; }
  // The probe is async: a concurrent tick may have recorded an owed rollback, or closed the watch, since our first read. Decide
  // from the CURRENT record, never the stale snapshot, so a healthy result can neither erase a mandatory rollback nor
  // count down / re-create a watch another tick already closed.
  const fresh = readForceWatch(root, env);
  if (!fresh || fresh.sha !== watch.sha) return { action: 'none' };
  watch = { ...fresh, adoptedSeen: fresh.adoptedSeen === true || watch.adoptedSeen === true };
  // The head was read BEFORE the probe too: a sibling that adopted a newer build meanwhile means this build is no longer running, so a
  // healthy result says nothing about it (no countdown, no false "passed") and an unhealthy one owes no revert.
  const headNow = typeof currentHead === 'function' ? currentHead() : currentHead;
  if (headNow !== null && headNow !== watch.sha) {
    clearWatch(root, env);
    await emit?.({ kind: 'force-adopt-watch-superseded', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head: headNow } });
    return { action: 'superseded' };
  }
  // Every write/clear below follows an await on a rollback that may take the clone lock: act only if this exact watch is still the
  // one on disk, never on the snapshot (it may have been closed, or replaced by a force for another build, in the meantime).
  const sameWatch = () => readForceWatch(root, env)?.sha === watch.sha;
  const pendingReason = watch.rollbackPending || pendingFor(root, env, watch.sha); // disk marker, else the in-process one
  const verdict = evaluateForceWatch({ watch: pendingReason ? { ...watch, rollbackPending: pendingReason } : watch, healthy: health?.healthy, restarts: health?.restarts ?? 0 });
  if (verdict.action === 'continue') { persist(verdict.watch); return { action: 'continue', ticksLeft: verdict.watch.ticksLeft }; }
  if (verdict.action === 'done') { clearWatch(root, env); await emit?.({ kind: 'force-adopt-watch-passed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha } }); return { action: 'done' }; }
  const at = new Date(now()).toISOString();
  let result;
  // `sha` lets the rollback verify, under the clone's write lock, that the watched build is STILL head before it reverts anything.
  try { result = await rollback(watch.lastGood, { sha: watch.sha }); } catch { result = { ok: false }; }
  if (!sameWatch()) return { action: 'none' }; // another tick closed (or replaced) this watch during the rollback: it owns the outcome
  if (result?.superseded === true) {
    // A superseding build was adopted while the probe/rollback ran: it is running, the watched build is not, so there is nothing
    // to revert. Close the watch without touching the newer build.
    clearWatch(root, env);
    await emit?.({ kind: 'force-adopt-watch-superseded', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, head: result.head ?? null } });
    return { action: 'superseded' };
  }
  if (!result?.ok) {
    // The owed-rollback marker must survive a failed state write: write it directly (not the swallowing persist) and, if
    // that throws, keep it in-process and say so in the handoff file so an operator can see the build is still owed a revert.
    try { writeJson(watchPath(root, env), { ...watch, rollbackPending: verdict.reason }); } catch {
      pendingRollbacks.set(watchPath(root, env), { sha: watch.sha, reason: verdict.reason });
      appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: force-adopt-rollback-failed ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason}); marker could not be saved, kept in memory\n`);
    }
    await emit?.({ kind: 'force-adopt-rollback-failed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, reason: verdict.reason } });
    return { action: 'rollback-failed', reason: verdict.reason };
  }
  clearWatch(root, env);
  await emit?.({ kind: 'force-adopt-rolled-back', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, lastGood: watch.lastGood?.head ?? null, reason: verdict.reason } });
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: ROLLED BACK ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason})\n`);
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-rolled-back', at, daemon: watch.daemon, ruling: watch.ruling, sha: watch.sha, reason: verdict.reason })}\n`);
  return { action: 'rollback', reason: verdict.reason };
}
