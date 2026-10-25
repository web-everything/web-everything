/** Bounded shared session listing, independent of dispatch and review operation graphs. */
import { execFileSync } from 'node:child_process';
import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';

export const LIST_TIMEOUT_MS = 15 * 1000;
export const LIST_TIMEOUT_ENV = 'WE_DISPATCH_LIST_TIMEOUT_MS';

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

export function listTimeoutMs(env = process.env) {
  return timeoutFromEnv(env, LIST_TIMEOUT_ENV, LIST_TIMEOUT_MS);
}

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
