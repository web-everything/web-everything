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
import { stateDir } from './daemon-rebuild/state.mjs';
import { cloneKeyOf } from './daemon-last-good.mjs';

export const FORCE_ADOPT_WATCH_TICKS = 5;
export const FORCE_ADOPT_MAX_RESTARTS = 3;
const MIN_QUOTE = 12;
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
  return lines.slice(start, end).join('\n');
}

/** PURE. A force-adopt needs a well-formed ruling id that exists, and a quote that is verbatim in THAT ruling. */
export function validateForceAdopt({ daemon, ruling, quote, rulingsText } = {}) {
  if (!daemon) return { ok: false, reason: 'no-daemon' };
  if (!ruling) return { ok: false, reason: 'no-ruling' };
  if (!/^R\d+$/.test(ruling)) return { ok: false, reason: 'bad-ruling-id' };
  if (!norm(quote)) return { ok: false, reason: 'no-quote' };
  if (norm(quote).length < MIN_QUOTE) return { ok: false, reason: 'quote-too-short' };
  const section = rulingSection(rulingsText, ruling);
  if (section === null) return { ok: false, reason: 'ruling-unknown' };
  if (!norm(section).includes(norm(quote))) return { ok: false, reason: 'quote-not-in-ruling' };
  return { ok: true };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); const t = `${p}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, p); };

/** Validate and persist a one-shot request; the next rebuild smoke consumes it. */
export function requestForceAdopt({ root, env = process.env, daemon, ruling, quote, rulingsText, now = Date.now } = {}) {
  const text = rulingsText ?? (() => { try { return readFileSync(rulingsPath(env), 'utf8'); } catch { return ''; } })();
  const v = validateForceAdopt({ daemon, ruling, quote, rulingsText: text });
  if (!v.ok) return v;
  const record = { daemon, ruling, quote: norm(quote), requestedAt: new Date(now()).toISOString() };
  writeJson(requestPath(root, env), record);
  return { ok: true, record };
}
export const readForceAdopt = (root, env = process.env) => readJson(requestPath(root, env));
export const clearForceAdopt = (root, env = process.env) => rmSync(requestPath(root, env), { force: true });
export const readForceWatch = (root, env = process.env) => readJson(watchPath(root, env));
const clearWatch = (root, env) => rmSync(watchPath(root, env), { force: true });

const appendLine = (p, line) => { try { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, line); } catch { /* audit is best-effort, the event is the primary record */ } };

/** Log a forced adoption loudly, write the coroner-review record, and open the health watch. */
export async function recordForcedAdoption({ root, env = process.env, request, sha, lastGood, smoke, emit, now = Date.now }) {
  const at = new Date(now()).toISOString();
  const detail = { ruling: request.ruling, quote: request.quote, sha, lastGood: lastGood?.head ?? null, smoke: smoke ?? null, watchTicks: FORCE_ADOPT_WATCH_TICKS };
  await emit?.({ kind: 'force-adopt', daemon: request.daemon, detail });
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${request.daemon} ${request.ruling}: adopted ${sha} though smoke ${smoke?.verdict ?? 'unknown'} `
    + `(failed: ${(smoke?.failed || []).join(',') || 'none'}); operator quote: "${request.quote}"; auto-rollback watch ${FORCE_ADOPT_WATCH_TICKS} ticks\n`);
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-review', at, daemon: request.daemon, ruling: request.ruling, quote: request.quote, sha, lastGood: lastGood?.head ?? null, smoke: smoke ?? null })}\n`);
  writeJson(watchPath(root, env), { daemon: request.daemon, ruling: request.ruling, sha, lastGood, ticksLeft: FORCE_ADOPT_WATCH_TICKS, bad: 0, startedAt: at });
  clearForceAdopt(root, env);
}

/** PURE. One watch tick: fail closed on a failed health check or a crash loop, else count down. */
export function evaluateForceWatch({ watch, healthy, restarts = 0, maxRestarts = FORCE_ADOPT_MAX_RESTARTS }) {
  if (healthy !== true) return { action: 'rollback', reason: 'health-failed', watch };
  if (restarts >= maxRestarts) return { action: 'rollback', reason: 'crash-loop', watch };
  const ticksLeft = (watch.ticksLeft ?? 0) - 1;
  if (ticksLeft <= 0) return { action: 'done', watch: { ...watch, ticksLeft: 0 } };
  return { action: 'continue', watch: { ...watch, ticksLeft } };
}

/** One tick of the post-force health watch. `probe(root)` -> { healthy, restarts? }; `rollback(lastGood)` -> { ok }. */
export async function runForceWatchTick({ root, env = process.env, probe, rollback, emit, now = Date.now, notBefore = null }) {
  const watch = readForceWatch(root, env);
  if (!watch) return { action: 'none' };
  // A watch opened by THIS tick's own forced adoption starts counting at the next tick.
  if (notBefore !== null && Date.parse(watch.startedAt) >= notBefore) return { action: 'none' };
  let health;
  try { health = await probe(root); } catch { health = { healthy: false }; }
  const verdict = evaluateForceWatch({ watch, healthy: health?.healthy, restarts: health?.restarts ?? 0 });
  if (verdict.action === 'continue') { writeJson(watchPath(root, env), verdict.watch); return { action: 'continue', ticksLeft: verdict.watch.ticksLeft }; }
  if (verdict.action === 'done') { clearWatch(root, env); await emit?.({ kind: 'force-adopt-watch-passed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha } }); return { action: 'done' }; }
  const at = new Date(now()).toISOString();
  let result;
  try { result = await rollback(watch.lastGood); } catch { result = { ok: false }; }
  if (!result?.ok) {
    await emit?.({ kind: 'force-adopt-rollback-failed', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, reason: verdict.reason } });
    return { action: 'rollback-failed', reason: verdict.reason };
  }
  clearWatch(root, env);
  await emit?.({ kind: 'force-adopt-rolled-back', daemon: watch.daemon, detail: { ruling: watch.ruling, sha: watch.sha, lastGood: watch.lastGood?.head ?? null, reason: verdict.reason } });
  appendLine(handoffFile(env), `- FORCE-ADOPT ${at} ${watch.daemon} ${watch.ruling}: ROLLED BACK ${watch.sha} -> ${watch.lastGood?.head ?? '?'} (${verdict.reason})\n`);
  appendLine(coronerFile(env), `${JSON.stringify({ kind: 'force-adopt-rolled-back', at, daemon: watch.daemon, ruling: watch.ruling, sha: watch.sha, reason: verdict.reason })}\n`);
  return { action: 'rollback', reason: verdict.reason };
}
