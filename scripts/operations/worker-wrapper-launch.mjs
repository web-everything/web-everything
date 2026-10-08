/**
 * @file scripts/operations/worker-wrapper-launch.mjs
 * @description ITEM 117 S3b — the fix, ci-heal and review LAUNCHES move off `claude --bg` onto the unified detached
 * worker wrapper (`worker-wrapper.mjs`, S3a; decision D7 FINAL). Three call sites (`reconcile-fix-dispatch.mjs#dispatchFix`,
 * `dispatch-lane-io.mjs#defaultClaudeProvider` for ci-heal, `review-dispatch.mjs#dispatchReview`) already build a
 * `claude --bg` argv with {@link ./dispatch-lane-io.mjs#buildAgentArgv}. This module turns that SAME argv into a
 * run-to-completion `claude -p` launch and starts it through `launchDetached`, so:
 *
 *  - the argv keeps every flag the old launch had (`-n`, `--settings`, `--append-system-prompt-file`, `--model`,
 *    `--effort`, any extra args) and gains `-p --session-id <minted uuid> --output-format json --json-schema`;
 *    the prompt gains the one-paragraph structured-output suffix. `--session-id` matters: the agent's own
 *    `completion-cli report` stamps `CLAUDE_CODE_SESSION_ID`, which then equals the id on the wrapper's record
 *    (probed live 2026-10-08), so the existing owner rule (#4306) accepts the agent's reports;
 *  - the handle is `pid:<wrapperPid>` (the detached-handle shape the run store and liveness already read);
 *  - the wrapper writes the v2 envelope (D5 started, then done with `result` / `parse` / `action`), reading the
 *    agent's own legacy report as the section 5 fallback and keeping the agent's outcome words on the envelope so
 *    `markSelfReportedDone` behaves as before (`preserveLegacyWords`).
 *
 * THE KNOB. `WE_WORKER_WRAPPER=on` wraps every migrated launch, `off` wraps none (the old `--bg` launch, byte for
 * byte). Unset: the roles in {@link WRAPPED_ROLES_DEFAULT_ON} are wrapped (D7 FINAL ratified them), the build path
 * stays on its own S3a default (off), and under test nothing is wrapped. See {@link workerWrapperEnabledFor}.
 *
 * LIVENESS. A `claude -p` worker has no `claude agents` row. {@link listWrappedWorkerAgents} reads the v2 records
 * this wrapper writes and returns rows of the listing's shape (the `review-job-store.mjs` precedent), so reconcile's
 * name binding, `markSelfReportedDone` and the cool-offs work unchanged.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { isUnderTest } from '../lib/under-test.mjs';
import { COMPLETION_RECORD_V2, listCompletionSessions, resolveCompletionsDir, tryReadCompletion } from './completion-store.mjs';
import { STRUCTURED_OUTPUT_SUFFIX, WORKER_WRAPPER_ENV, launchDetached, withStructuredOutput } from './worker-wrapper.mjs';

/** The roles whose launch is wrapped when the knob is unset (D7 FINAL, operator 2026-10-08). */
export const WRAPPED_ROLES_DEFAULT_ON = Object.freeze(['fix', 'ci-heal', 'review']);

/**
 * Is `role`'s launch wrapped? `on` = every migrated role, `off` = none, unset/other = {@link WRAPPED_ROLES_DEFAULT_ON}.
 * PURE (`env` is data).
 */
export function workerWrapperEnabledFor(role, env = process.env) {
  const raw = String(env?.[WORKER_WRAPPER_ENV] ?? '').trim().toLowerCase();
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  // Test-isolation guard (the `lane-pool-paths.mjs` precedent): an unset knob under test keeps the old launch, so no
  // suite that drives a dispatch with a fake `spawnAgent` ever starts a real detached `claude -p`. A test that means
  // to exercise the wrapped launch sets the knob itself and injects the launcher.
  if (isUnderTest(env)) return false;
  return WRAPPED_ROLES_DEFAULT_ON.includes(String(role));
}

/** Hard budget per role. A `--bg` fix had none; 2 h is well past the slowest healthy fix and still ends a hang. */
export const WRAPPED_TIMEOUT_MS_BY_ROLE = Object.freeze({ fix: 120 * 60 * 1000, 'ci-heal': 120 * 60 * 1000, review: 60 * 60 * 1000 });
export const WRAPPED_TIMEOUT_ENV = 'WE_WORKER_WRAPPER_TIMEOUT_MS';

/** @returns {number} the role's budget, or the env override (>= 60 s) when set. PURE. */
export function wrappedTimeoutMs(role, env = process.env) {
  const n = Number(env?.[WRAPPED_TIMEOUT_ENV]);
  if (Number.isInteger(n) && n >= 60_000) return n;
  return WRAPPED_TIMEOUT_MS_BY_ROLE[role] ?? 60 * 60 * 1000;
}

/**
 * A `buildAgentArgv` FRESH-launch argv (`['--bg', '-n', slug, ..., prompt]`) -> the wrapped `claude -p` argv. PURE.
 * Refuses a resume argv (`--bg --resume <id>`): a `--bg` session can only be resumed as `--bg`.
 * @param {string[]} bgArgv
 * @param {{sessionId: string}} o
 * @returns {string[]}
 */
export function wrappedArgvFromBg(bgArgv, { sessionId } = {}) {
  if (!Array.isArray(bgArgv) || bgArgv[0] !== '--bg' || bgArgv.length < 2) {
    throw new TypeError('operations: wrappedArgvFromBg needs a fresh `claude --bg` argv from buildAgentArgv');
  }
  if (bgArgv.includes('--resume')) throw new TypeError('operations: wrappedArgvFromBg cannot wrap a `--bg --resume` argv');
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new TypeError('operations: wrappedArgvFromBg needs a uuid sessionId');
  const prompt = String(bgArgv.at(-1));
  const flags = bgArgv.slice(1, -1);
  return withStructuredOutput(['--session-id', sessionId, ...flags, `${prompt}${STRUCTURED_OUTPUT_SUFFIX}`]);
}

/** Where `launchDetached` writes a spec (owner-only; the wrapper deletes it once read). Beside the completions dir. */
export function defaultWorkerSpecDir(completionsDir = resolveCompletionsDir()) {
  return join(dirname(completionsDir), 'worker-wrapper-specs');
}

/**
 * Start ONE wrapped Claude worker, detached, and return at once (the daemon never waits on it).
 * @param {object} o
 * @param {'fix'|'ci-heal'|'review'} o.role
 * @param {string} o.session  the completion-record session slug (`fix-<pr>`, `ci-heal-<pr>`, `review-<pr>`)
 * @param {string[]} o.bgArgv the argv `buildAgentArgv` built for the old launch
 * @param {string} o.cwd
 * @param {object} o.env      the env the old spawn would have used (already sanitized and worker-marked)
 * @returns {{handle: string, wrapperPid: number|null, sessionId: string, argv: string[]}}
 */
export function launchWrappedClaudeWorker({
  role, session, bgArgv, cwd, env = process.env, pr = null, item = null, model = null,
  sessionId = randomUUID(), specDir = defaultWorkerSpecDir(), launch = launchDetached,
} = {}) {
  const argv = wrappedArgvFromBg(bgArgv, { sessionId });
  const { wrapperPid } = launch({
    role, launcher: 'claude-p', session, command: 'claude', argv, cwd, env, timeoutMs: wrappedTimeoutMs(role, env),
    model, pr: pr == null ? null : String(pr), item: item == null || item === '' ? null : String(item), sessionId,
    legacyFromCompletion: true, preserveLegacyWords: true,
  }, { specDir });
  return { handle: Number.isInteger(wrapperPid) ? `pid:${wrapperPid}` : null, wrapperPid: Number.isInteger(wrapperPid) ? wrapperPid : null, sessionId, argv };
}

// ── liveness rows ───────────────────────────────────────────────────────────────────────────────────────────────

/** How long a FINISHED wrapped record keeps a row: the longest reconcile cool-off (24 h, a capped permission wall). */
export const WRAPPED_DONE_ROW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Only records these launchers wrote stand for a worker process (a review JOB has its own rows). */
const ROW_LAUNCHERS = new Set(['claude-p', 'codex-exec', 'agy']);
const ROW_ROLES = new Set(['fix', 'ci-heal', 'review', 'inspect']);

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * PURE — the listing row a wrapped v2 record stands for, or `null`. Same field names `claude agents --json` uses, so
 * `bindAgents` (name), `enrichAgents` (pid), `markSelfReportedDone` (startedAt, sessionId) read it unchanged:
 *  - `started` + live worker pid -> `working`;
 *  - `started` + dead pid -> `stopped` (the wrapper died; the record is stale, nothing is working the PR);
 *  - `done` within {@link WRAPPED_DONE_ROW_WINDOW_MS} -> `stopped` with its dead pid, exactly what a reaped `--bg`
 *    session looked like, so the record's cool-off (`awaitingInfraCooloff`) still holds the PR;
 *  - anything else -> no row.
 */
export function wrappedRecordToAgentRow(rec, { isAlive = defaultIsAlive, nowMs = Date.now() } = {}) {
  if (!rec || rec.v !== COMPLETION_RECORD_V2 || !ROW_LAUNCHERS.has(rec.launcher) || !ROW_ROLES.has(rec.role)) return null;
  if (!Number.isInteger(rec.pid) || rec.pid <= 0) return null;
  const startedAt = Date.parse(rec.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  let state;
  if (rec.status === 'started') state = isAlive(rec.pid) ? 'working' : 'stopped';
  else if (rec.status === 'done') {
    const endedAt = Date.parse(rec.endedAt ?? rec.updatedAt);
    if (!Number.isFinite(endedAt) || nowMs - endedAt > WRAPPED_DONE_ROW_WINDOW_MS) return null;
    // The agent's own `done` can land while the worker is still exiting: it is still a live process until it is not.
    state = isAlive(rec.pid) ? 'working' : 'stopped';
  } else return null;
  return {
    id: `wrapped-${rec.pid}`, name: String(rec.session), kind: 'wrapped-worker', state, pid: rec.pid,
    cwd: '', startedAt, sessionId: rec.sessionId ?? null, pr: rec.pr ?? null, launcher: rec.launcher, role: rec.role,
  };
}

/**
 * Every wrapped worker, as listing rows. NEVER throws: an unreadable store answers `[]` (absence is not liveness).
 * @returns {object[]}
 */
export function listWrappedWorkerAgents({ dir = resolveCompletionsDir(), isAlive = defaultIsAlive, nowMs = Date.now(), list = listCompletionSessions, read = tryReadCompletion } = {}) {
  let sessions;
  try { sessions = list(dir) ?? []; } catch { return []; }
  const rows = [];
  for (const s of sessions) {
    let rec = null;
    try { rec = read(s, dir); } catch { rec = null; }
    const row = wrappedRecordToAgentRow(rec, { isAlive, nowMs });
    if (row) rows.push(row);
  }
  return rows;
}
