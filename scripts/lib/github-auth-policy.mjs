/**
 * @file scripts/lib/github-auth-policy.mjs
 * @description Which GitHub login the fleet's daemons use — the `github.auth` policy (operator ruling 2026-10-09
 *   ~21:20 ET: "it would be better if all [daemons] use the App installation, if capacity allows").
 *
 * CASCADE (same shape as `we:scripts/lib/pr-limit.mjs#resolvePrLimitScope`), PURE:
 *   default → tool layer (`we:scripts/settings/github-auth.json` → `github`) → env.
 *   - `auth`: `'app'` (default) or `'personal'`. Env override: `WE_GITHUB_AUTH`.
 *   - `personalExceptions`: `{ <name>: <reason> }` — the ONLY things allowed to stay on the operator's personal
 *     login while `auth` is `'app'`. Each one names why the App cannot do it. Env override (adds names):
 *     `WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS=reads,main-push`.
 *
 * KNOWN EXCEPTION NAMES
 *   - `reads`: gh-throttle's personal READ route (`WE_GH_THROTTLE_PERSONAL_ROUTE`, we:backlog/xhcgdce). It was a
 *     capacity crutch from when the whole fleet shared ONE installation's 5,000/h. Each org now has its own
 *     installation (15,000 core / 10,000 GraphQL per hour), so the route is OFF unless listed here — its reads
 *     shared the operator's own bucket and broke the drain on 2026-10-09 13:21Z ("rate limit exceeded for user ID
 *     760299").
 *   - `main-push`: informational. `git push` to protected `main` uses the operator's SSH key, not a gh token.
 *
 * Never throws: unreadable settings fall back to the default.
 */
import { readSettings } from './settings-files.mjs';

export const GITHUB_AUTH_MODES = Object.freeze(['app', 'personal']);
export const GITHUB_AUTH_DEFAULTS = Object.freeze({ auth: 'app', personalExceptions: Object.freeze({}) });
export const GITHUB_AUTH_ENV = 'WE_GITHUB_AUTH';
export const GITHUB_AUTH_EXCEPTIONS_ENV = 'WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS';

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The policy cascade, PURE. A value that is not a known mode (or not an object, for exceptions) is ignored at its
 * layer, never coerced.
 * @param {{tool?:object, env?:object}} [o]
 * @returns {{auth:'app'|'personal', personalExceptions:Record<string,string>, source:{auth:string}}}
 */
export function resolveGithubAuthPolicy({ tool = {}, env = {} } = {}) {
  let auth = GITHUB_AUTH_DEFAULTS.auth;
  let source = 'default';
  if (GITHUB_AUTH_MODES.includes(tool?.auth)) { auth = tool.auth; source = 'tool'; }
  const fromEnv = String(env?.[GITHUB_AUTH_ENV] ?? '').trim().toLowerCase();
  if (GITHUB_AUTH_MODES.includes(fromEnv)) { auth = fromEnv; source = 'env'; }
  const personalExceptions = {};
  if (isPlainObject(tool?.personalExceptions)) {
    for (const [name, reason] of Object.entries(tool.personalExceptions)) personalExceptions[name] = String(reason ?? '');
  }
  for (const name of String(env?.[GITHUB_AUTH_EXCEPTIONS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!Object.hasOwn(personalExceptions, name)) personalExceptions[name] = `env ${GITHUB_AUTH_EXCEPTIONS_ENV}`;
  }
  return { auth, personalExceptions, source: { auth: source } };
}

/** May `name` run on the personal login? Always yes under `auth: 'personal'`; under `'app'` only when listed. PURE. */
export function personalAllowed(policy, name) {
  if (!policy) return false;
  return policy.auth === 'personal' || Object.hasOwn(policy.personalExceptions ?? {}, name);
}

let cachedTool; // per-process: the settings files do not change under a running process often enough to re-read per gh call
/** Test seam. @test-only-export-ok */
export function resetGithubAuthPolicyCacheForTest() { cachedTool = undefined; }

/** Read the live policy (settings files + env). Never throws. The settings layer is read once per process. */
export function readGithubAuthPolicy({ env = process.env, read = readSettings } = {}) {
  if (cachedTool === undefined || read !== readSettings) {
    let tool = {};
    try { tool = read()?.github ?? {}; } catch { tool = {}; }
    if (read !== readSettings) return resolveGithubAuthPolicy({ tool, env });
    cachedTool = tool;
  }
  return resolveGithubAuthPolicy({ tool: cachedTool, env });
}
