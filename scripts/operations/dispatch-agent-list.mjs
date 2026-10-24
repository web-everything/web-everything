/** Lightweight dispatch liveness reader shared by job stores and dispatch IO.
 * Keep this leaf independent of the launch/runner graph: importing a job store must
 * not load skills-src or initialize dispatch just to read persisted review evidence.
 */
import { execFileSync } from 'node:child_process';
import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';

/** How long `claude agents --json` gets. A read this cheap that blocks is a broken environment, not slow work. */
export const LIST_TIMEOUT_MS = 15 * 1000;

/** The env var that overrides {@link LIST_TIMEOUT_MS}. `0` means UNBOUNDED. See {@link listTimeoutMs}. */
export const LIST_TIMEOUT_ENV = 'WE_DISPATCH_LIST_TIMEOUT_MS';

/**
 * The listing timeout for THIS process — {@link LIST_TIMEOUT_MS} unless the environment overrides it.
 *
 * WHY THE KNOB EXISTS, and it is a test-determinism fix before it is an operator one (PR #1211 round 2, G3).
 * `wake-cli.test.mjs` drives the real waker CLI in a child process whose `claude` is a two-line `sh` stub. On
 * the required gate that child competes with the whole shard's worker pool for CPU, and roughly one run in
 * five the stub's own spawn did not complete inside the 15-second bound: `execFileSync` SIGKILLed it, the
 * observer reported an error instead of `running`, and one assertion failed. A flaky test on the required
 * check teaches everyone to re-run instead of read, and this one's job is to prove a blocker fix.
 *
 * The test sets this to `0`, which Node's `child_process` reads as NO TIMEOUT — so the assertion no longer
 * races a wall clock at all, rather than racing a bigger one. The production default is untouched and is
 * asserted with its literal in `dispatch-lane-defaults.test.mjs`.
 *
 * REFUSES a malformed value rather than silently falling back: an operator who set a bound that never applied
 * is in exactly the position this module's `WE_DISPATCH_AGENT_ARGS` refusal exists to prevent.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} milliseconds; `0` = unbounded.
 */
export function listTimeoutMs(env = process.env) {
  return timeoutFromEnv(env, LIST_TIMEOUT_ENV, LIST_TIMEOUT_MS);
}

/**
 * One env-overridable millisecond bound. REFUSES a malformed value rather than silently falling back — an
 * operator who set a bound that never applied is in exactly the position this module's `WE_DISPATCH_AGENT_ARGS`
 * refusal exists to prevent.
 */
export function timeoutFromEnv(env, name, fallback) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new TypeError(
      `operations: ${name} must be a non-negative number of milliseconds (0 = unbounded), got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * `claude agents --json` — active sessions only BY DEFAULT. See {@link createDispatchObservers} for why the
 * observer (and every other caller that does not pass `all: true`) must never see `--all`: it also lists
 * COMPLETED sessions, so a finished build would keep reading as `running` forever — the one mistake that makes
 * an observer worse than none.
 *
 * `all: true` IS AN OPT-IN, not a second default. It exists for a caller with the opposite job to the
 * observer's — one that must see COMPLETED sessions to do anything at all (`scripts/conveyor/session-reaper.mjs`,
 * #3435 review: the reaper's whole purpose is to find and `claude stop` `done`/`failed` sessions, which the
 * non-`--all` listing excludes entirely — so the plain default silently reaped nothing, ever). Every OTHER
 * caller passes no `all`, so its argv is byte-identical to before this option existed.
 *
 * BOUNDED, because this call sits synchronously inside a waker pass that promises to be fail-soft per run: a
 * `claude` that blocks (a cold start that wants to ask something, a wedged daemon) would otherwise stall every
 * OTHER parked run in the pass. A timeout turns that into one reported observer error, which is what the
 * contract says should happen.
 *
 * ASSERTED, not merely asserted-about. This function was called by no test at all, so both of the emphatic
 * claims above it — no `--all`, and a timeout — could be inverted with the suite green (PR #1211 review, F5/F6).
 * `dispatch-lane-defaults.test.mjs` now pins the argv and the opts, and the wake CLI test proves the same argv
 * across a real process boundary. `session-reaper-cli.test.mjs` pins the OPT-IN side the same way (#3435).
 *
 * @param {{exec?: Function, env?: object, all?: boolean}} [io] - injected ONLY so the argv and opts can be
 *   asserted. `all` defaults to `false` — every existing caller keeps today's active-sessions-only behavior
 *   unchanged; pass `all: true` ONLY from a caller whose job requires seeing completed sessions too.
 */
export function defaultListAgents({ exec = execFileSync, env = process.env, all = false } = {}) {
  const out = cachedClaudeAgents({ all, env, fetch: () => exec('claude', ['agents', '--json', ...(all ? ['--all'] : [])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: listTimeoutMs(env),
    killSignal: 'SIGKILL',
    // FORWARDED TO THE CHILD, not just read for the timeout. `defaultSpawnAgent` forwards its `env` (via
    // `...opts`) and this did not, so the two halves of one chain resolved `claude` differently: a test that
    // pointed `PATH` at a fake got a real spawn and a REAL listing back. The default is `process.env`, so
    // every existing caller — all of which pass `{ exec }` alone — is byte-identical.
    env,
  }) });
  return JSON.parse(String(out || '[]'));
}
