/**
 * @file scripts/lib/fix-session-liveness.mjs
 * @description What a `claude agents --json --all` row really says about a background session's PROCESS, plus the two
 *   fixer-session switches that act on it, resolved through the policy cascade.
 *
 * THE STATE THE "FORKED COPY" FAILURE CAME FROM (measured live 2026-10-21 ~19:55 ET, CLI probe in a lane clone):
 *   1. A fresh `claude --bg` session lists `working/busy` with a pid while its turn runs.
 *   2. When the turn ENDS the process stays up: the row reads `state:'done', status:'idle'` and keeps its LIVE pid.
 *   3. `claude --bg --resume <id>` on that still-running process does not continue it: the CLI prints
 *      "session <id> is already running in the background, so this started a copy as <new>" and starts a NEW session
 *      id that carries the whole transcript plus the new prompt.
 *   4. `claude stop <id>` first, then the same `--resume`, wakes the SAME id (new pid). After a stop the row reads
 *      `done`/`stopped` with NO pid.
 *   So `state:'done'` alone does not mean "no process". The await-verify pass treated `done` as gone, skipped its
 *   stop-before-resume, got the copy, judged it a fork and stopped it, three times, then gave up (resume-exhausted):
 *   #5729 and #5492 on 2026-10-21, each followed by an 8-10 minute cold restart. The round resume never stopped first
 *   at all, so every round resume of an idle `done` session forked the same way.
 *
 * A row's PROCESS is live when it carries a positive pid that is alive. A row is GONE only when its state is terminal
 * AND no live process backs it. A row is MID-TURN when its `status` says so (anything but `idle`), whatever `state` says.
 *
 * Settings (`fix` block; standard → platform → tool → env, each layer only answers with a valid boolean):
 *   `fix.resumeStopsLiveIdle`  (default true; env WE_FIX_RESUME_STOPS_LIVE_IDLE) — a resume first stops an idle session
 *                               whose process is still up, so `--resume` wakes the same id. Off = the old state-only view.
 *   `fix.stopOnClaimRelease`   (default true; env WE_FIX_STOP_ON_CLAIM_RELEASE) — when the claim sweep releases a fixer's
 *                               claim as settled while that session's process is still up, the daemon stops it.
 * PURE except {@link loadFixSessionPolicy} (reads the two files; never throws).
 */
import { readFileSync } from 'node:fs';
import { readSettings } from './settings-files.mjs';
import { FIX_PUSH_PLATFORM_PREFERENCES_PATH, parsePushBeforeGate } from './fix-push-policy.mjs';

/** The listing states that mean "this run finished" (the reaper's own set). */
export const TERMINAL_ROW_STATES = Object.freeze(['done', 'failed', 'stopped']);

const lower = (s) => String(s ?? '').trim().toLowerCase();

/** Does a positive pid on the row name a live process? Pure over the injected probe. */
export function rowProcessAlive(row, pidAlive) {
  const pid = row?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || typeof pidAlive !== 'function') return false;
  try { return pidAlive(pid) === true; } catch { return false; }
}

/** Is the row's run finished AND no live process behind it? A `done` row with a live pid is NOT gone. Pure. */
export function isRowGone(row, pidAlive) {
  return TERMINAL_ROW_STATES.includes(lower(row?.state)) && !rowProcessAlive(row, pidAlive);
}

/** Does the row's `status` say a turn is running (`busy`, `waiting`, ...)? No status = unknown = false. Pure. */
export function isRowMidTurn(row) {
  const status = lower(row?.status);
  return Boolean(status) && status !== 'idle';
}

/** Is `printedId` (the short handle `--bg` prints) the SAME session as `session`? Pure. */
export function samePrintedHandle(printedId, session) {
  const p = lower(printedId);
  if (!p) return false;
  return p === lower(session?.id) || p === lower(session?.sessionId) || lower(session?.sessionId).startsWith(`${p}-`);
}

/** Did the CLI say it started a copy because the session was still running? Pure. */
export function cliStartedCopy(stdout) {
  return /already running in the background, so this started a copy/i.test(String(stdout ?? ''));
}

export const FIX_RESUME_STOPS_LIVE_IDLE_ENV = 'WE_FIX_RESUME_STOPS_LIVE_IDLE';
export const FIX_STOP_ON_CLAIM_RELEASE_ENV = 'WE_FIX_STOP_ON_CLAIM_RELEASE';
export const STANDARD_FIX_SESSION_POLICY = Object.freeze({ resumeStopsLiveIdle: true, stopOnClaimRelease: true });
const KEYS = Object.freeze([
  ['resumeStopsLiveIdle', FIX_RESUME_STOPS_LIVE_IDLE_ENV],
  ['stopOnClaimRelease', FIX_STOP_ON_CLAIM_RELEASE_ENV],
]);

/**
 * Resolve both switches. Pure.
 * @returns {{resumeStopsLiveIdle:boolean, stopOnClaimRelease:boolean, sources:Record<string,string>, invalid:string[]}}
 */
export function resolveFixSessionPolicy({ platform = null, tool = null, env = {} } = {}) {
  const out = { ...STANDARD_FIX_SESSION_POLICY, sources: {}, invalid: [] };
  for (const [key, envName] of KEYS) {
    out.sources[key] = 'standard';
    for (const [name, raw] of [['platform', platform?.[key]], ['tool', tool?.[key]], ['env', env?.[envName]]]) {
      if (raw === undefined || raw === null || raw === '') continue;
      const parsed = parsePushBeforeGate(raw);
      if (parsed === null) { out.invalid.push(`${name}.${key}=${JSON.stringify(raw)}`); continue; }
      out[key] = parsed;
      out.sources[key] = name;
    }
  }
  return out;
}

/** One log line naming each effective value and the layer that set it. Pure. */
export function formatFixSessionPolicyLine(policy) {
  const bad = policy?.invalid?.length ? `; ignored invalid ${policy.invalid.join(', ')}` : '';
  return `fix-session-policy: ${KEYS.map(([k]) => `${k}=${policy?.[k]} (${policy?.sources?.[k] ?? 'standard'})`).join(', ')}${bad}`;
}

/** Read the platform + tool layers and resolve. Never throws. */
export function loadFixSessionPolicy({ env = process.env, platformPath = FIX_PUSH_PLATFORM_PREFERENCES_PATH, readTool = () => readSettings() } = {}) {
  let platform = null;
  try { platform = JSON.parse(readFileSync(platformPath, 'utf8'))?.fix ?? null; } catch { platform = null; }
  let tool = null;
  try { tool = readTool()?.fix ?? null; } catch { tool = null; }
  try { return resolveFixSessionPolicy({ platform, tool, env }); } catch { return resolveFixSessionPolicy({}); }
}
