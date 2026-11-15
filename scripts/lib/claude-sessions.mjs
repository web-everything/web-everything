/** One boundary for profile-aware Claude session discovery and stopping.
 * Launch routing chooses NEW workers; management also visits every provisioned account directory after rollback.
 * Keep an account configured until its workers have drained. An unreadable profile is never evidence of absence.
 */
import { execFileSync } from 'node:child_process';
import { statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountConfigDir, accountEnv, CREDENTIAL_ENV_VARS, isAccountMap, loadAccountMap, resolveAccount } from './claude-account.mjs';
import { cachedClaudeAgents } from './claude-agents-cache.mjs';

/** True when some daemon would launch NEW workers into `account` right now (B also needs its switch). */
function accountRouted(map, account) {
  const daemons = map?.daemons && typeof map.daemons === 'object' ? Object.values(map.daemons) : [];
  return daemons.includes(account) && (account !== 'b' || map.routing?.accountB === true);
}

/** A failed read or malformed map cannot prove which job stores need inspection. Validate even for
 * unmapped observers, before selecting an inherited profile, reading a cache, or issuing a stop.
 * An intentionally empty map must explicitly contain both accounts and daemons objects.
 */
function requireSessionMap(map) {
  if (!isAccountMap(map)) {
    // Do not include input values, parse errors, or filesystem errors: they may contain credentials.
    throw new Error('claude-account: account map unavailable; session management refused; repair scripts/settings/claude-accounts.json and retry');
  }
  return map;
}

// Absent stores have no realpath yet; other resolution failures are unknown, never aliases to query.
function storeKey(dir) {
  const path = accountConfigDir(dir);
  try { return realpathSync(path); }
  catch (error) { return error?.code === 'ENOENT' ? path : null; }
}

/** Every job store a worker may live in, as `{ profiles, unreadable }`.
 * `profiles` are envs for the selected launch profile, the inherited and default profiles, and EVERY account
 * with a configDir (one list for all management readers). Config-dir accounts need only stat/access;
 * a selected legacy Keychain account retains its credential lookup, with failures isolated too.
 * `unreadable` names accounts that fail validation (including missing routed or inherited directories);
 * callers must treat them as unknown, never as empty, and one unknown account never blocks another.
 */
export function sessionProfiles(env = process.env, options = {}) {
  const map = requireSessionMap(options.map === undefined ? loadAccountMap() : options.map);
  // Launch policy may order the search, but must not gate management of existing workers.
  const selected = resolveAccount(env, map);
  const profiles = [];
  const unreadable = [];
  const accounts = map?.accounts && typeof map.accounts === 'object' ? map.accounts : {};
  const dirs = Object.entries(accounts)
    .filter(([, entry]) => entry && typeof entry === 'object' && Object.hasOwn(entry, 'configDir'))
    .map(([account, entry]) => [account, accountConfigDir(entry.configDir)]);
  if (dirs.length || selected.kind === 'account') {
    const alternate = { ...env };
    for (const key of CREDENTIAL_ENV_VARS) delete alternate[key];
    if (selected.kind === 'account') {
      const base = { ...alternate };
      delete base.CLAUDE_CONFIG_DIR;
      try { profiles.push({ ...base, ...accountEnv(selected.account, map, options) }); }
      catch { unreadable.push(selected.account); }
    }
    profiles.push({ ...alternate }); // preserve an explicitly inherited A job store too
    delete alternate.CLAUDE_CONFIG_DIR;
    // Legacy A jobs live in the default job store; no Keychain read is needed to inspect them.
    profiles.push(alternate);
    for (const [account, dir] of dirs) {
      try { (options.statSync ?? statSync)(dir); }
      catch (error) {
        // An unprovisioned account holds no jobs, unless routing or inheritance says it is in use.
        if (error?.code === 'ENOENT' && !accountRouted(map, account)
          && dir !== accountConfigDir(env.CLAUDE_CONFIG_DIR)) continue;
        unreadable.push(account);
        continue;
      }
      // Once provisioned, a missing or unreadable login is unknown state (the CLI may not list its jobs).
      try { profiles.push({ ...alternate, ...accountEnv(account, map, options) }); }
      catch { unreadable.push(account); }
    }
  } else profiles.push(env);
  // An inherited selector may alias a failed mapped profile; it cannot bypass its login check.
  const unavailableDirs = new Set(dirs.filter(([account]) => unreadable.includes(account)).map(([, dir]) => storeKey(dir)));
  const seen = new Set();
  return {
    profiles: profiles.filter(profile => {
      // Explicit default selectors and symlinks must share the implicit default's real store identity.
      const key = storeKey(profile.CLAUDE_CONFIG_DIR || join(profile.HOME || homedir(), '.claude'));
      if (key === null) { unreadable.push('unresolved profile'); return false; }
      if (unavailableDirs.has(key)) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    unreadable: [...new Set(unreadable)],
  };
}

/** The env list only; throws when any account directory is unreadable (a listing must be complete). */
export function sessionProfileEnvs(env = process.env, options = {}) {
  const { profiles, unreadable } = sessionProfiles(env, options);
  if (unreadable.length) throw new Error('claude-account: config directory unavailable for session management');
  return profiles;
}

/** All profile reads must succeed before returning any rows. Cache entries remain per profile. */
export function listClaudeSessions({ exec = execFileSync, env = process.env, all = false, accountOptions, timeout = 30_000 } = {}) {
  return sessionProfileEnvs(env, accountOptions).flatMap(profile => {
    const out = cachedClaudeAgents({ all, env: profile, fetch: () => readProfile(exec, profile, all, timeout) });
    const rows = JSON.parse(String(out || '[]'));
    if (!Array.isArray(rows)) throw new Error('claude-account: invalid session listing');
    return rows;
  });
}

function readProfile(exec, env, all, timeout = 30_000) {
  return exec('claude', ['agents', '--json', ...(all ? ['--all'] : [])], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    timeout, killSignal: 'SIGKILL', env,
  });
}

export const STOP_EXEC_OPTS = Object.freeze({ encoding: 'utf8', timeout: 30_000 });

/** Resolve the handle against fresh listings, then stop its full session ID in exactly one store.
 * Ambiguous handles never stop anything; absence needs every profile to be readable.
 * A broken account never prevents stopping a job positively identified in a readable one.
 */
export function stopClaudeSession({ id, exec = execFileSync, env = process.env, accountOptions } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('dispatch-abort: stopSession needs a handle to stop');
  id = id.trim().toLowerCase();
  const { profiles, unreadable } = sessionProfiles(env, accountOptions);
  let failure = unreadable.length ? `config directory unavailable for account ${unreadable.join(', ')}` : null;
  const matches = [];
  for (const profile of profiles) {
    try {
      // Never use the discovery cache to authorize a destructive operation or an absence claim.
      const rows = JSON.parse(String(readProfile(exec, profile, true)));
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.sessionId !== 'string' || !row.sessionId.trim())) {
        throw new Error('invalid session listing');
      }
      const ids = new Set(rows.filter(row => row.sessionId.trim().toLowerCase().startsWith(id)
        || (typeof row.id === 'string' && row.id.trim().toLowerCase() === id))
        .map(row => row.sessionId.trim().toLowerCase()));
      for (const fullId of ids) matches.push({ profile, fullId });
    } catch (error) {
      const full = String(error?.stderr ?? error?.message ?? error);
      failure ??= full.split('\n')[0];
    }
  }
  if (matches.length > 1) throw new Error(`dispatch-abort: ambiguous session handle ${id}; use a full session UUID belonging to exactly one profile`);
  if (!matches.length) {
    if (failure) throw new Error(`dispatch-abort: \`claude stop ${id}\` failed: ${failure}`);
    return { stopped: true, alreadyGone: true, output: `No job matching '${id}' in any profile; nothing to stop`, unreadable };
  }
  const { profile, fullId } = matches[0];
  if (failure && id !== fullId) throw new Error(`dispatch-abort: cannot resolve short session handle ${id}: ${failure}`);
  try {
    const output = String(exec('claude', ['stop', fullId], { ...STOP_EXEC_OPTS, env: profile }));
    return { stopped: true, alreadyGone: false, output, unreadable };
  } catch (error) {
    const full = String(error?.stderr ?? error?.message ?? error);
    // The matched job can disappear between listing and stopping. Unknown stores still cannot prove absence.
    if (/No job matching/i.test(full) && !failure) {
      return { stopped: true, alreadyGone: true, output: full.split('\n')[0], unreadable };
    }
    throw new Error(`dispatch-abort: \`claude stop ${id}\` failed: ${failure || full.split('\n')[0]}`);
  }
}
