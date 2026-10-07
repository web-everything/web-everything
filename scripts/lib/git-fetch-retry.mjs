/**
 * git-fetch-retry.mjs — bounded, jittered retry for the shared-ref-store `git fetch` race (held item 127).
 *
 * Lanes clone `--reference` one object store and many processes fetch at once, so git refuses the loser with
 * `error: cannot lock ref '<ref>': is at X but expected Y` or `Unable to create '<ref>.lock': File exists`.
 * That is ordinary contention, never a card failure. `retryTransientGit` retries ONLY that signature with a
 * short jittered backoff (knobs: WE_GIT_LOCK_RETRY_ATTEMPTS, WE_GIT_LOCK_RETRY_BASE_MS), then throws the
 * original error tagged `transient: true` / `reason: 'git-ref-lock-transient'` so the failure policy files it
 * as infra-transient, not a prepare failure. Every other error rethrows at once, unretried.
 */
import { isTransientRefLockError } from './lane-lease.mjs';

export const GIT_LOCK_REASON = 'git-ref-lock-transient';
export const DEFAULT_GIT_LOCK_ATTEMPTS = 5;
export const DEFAULT_GIT_LOCK_BASE_MS = 200;

const intEnv = (name, dflt, env) => {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function blockingSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch { /* no SAB: skip the wait */ }
}

const errText = (e) => `${e?.stderr ?? ''}\n${e?.message ?? e ?? ''}`;

/** Run `fn()` (a synchronous git call); retry on the ref-lock race, else rethrow unchanged. */
export function retryTransientGit(fn, {
  attempts, baseMs, sleep = blockingSleep, random = Math.random, env = process.env,
} = {}) {
  const max = Math.max(1, attempts ?? intEnv('WE_GIT_LOCK_RETRY_ATTEMPTS', DEFAULT_GIT_LOCK_ATTEMPTS, env));
  const base = baseMs ?? intEnv('WE_GIT_LOCK_RETRY_BASE_MS', DEFAULT_GIT_LOCK_BASE_MS, env);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (e) {
      if (!isTransientRefLockError(errText(e))) throw e;
      if (attempt >= max) {
        try { e.transient = true; e.reason = GIT_LOCK_REASON; e.message = `${GIT_LOCK_REASON}: ${e.message}`; } catch { /* frozen error */ }
        throw e;
      }
      sleep(Math.round(base * attempt * (0.5 + random())));
    }
  }
}

/** Wrap an exec-style `(cmd, args, opts) => out` so any `git fetch` through it retries the race. */
export function withFetchRetry(exec, retryOpts = {}) {
  return (cmd, args, opts) => (cmd === 'git' && (args ?? []).includes('fetch')
    ? retryTransientGit(() => exec(cmd, args, opts), retryOpts)
    : exec(cmd, args, opts));
}
