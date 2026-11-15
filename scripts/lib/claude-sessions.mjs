/** One boundary for profile-aware Claude session discovery and stopping.
 * Launch routing chooses NEW workers; management also visits every provisioned account directory after rollback.
 * Keep an account configured until its workers have drained. An unreadable profile is never evidence of absence.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { accountSessionEnv } from '../operations/session-role.mjs';
import { accountConfigDir, accountEnv, CREDENTIAL_ENV_VARS, loadAccountMap } from './claude-account.mjs';
import { cachedClaudeAgents } from './claude-agents-cache.mjs';

/** True when some daemon would launch NEW workers into `account` right now (B also needs its switch). */
function accountRouted(map, account) {
  const daemons = map?.daemons && typeof map.daemons === 'object' ? Object.values(map.daemons) : [];
  return daemons.includes(account) && (account !== 'b' || map.routing?.accountB === true);
}

/** Every job store a worker may live in, as `{ profiles, unreadable }`.
 * `profiles` are envs for the selected launch profile, the inherited and default profiles, and EVERY account
 * with a configDir (one list for all management readers). No Keychain read: config-dir accounts need only stat.
 * `unreadable` names account directories that exist but fail the login check (or are missing while routed);
 * callers must treat them as unknown, never as empty, and one unknown account never blocks another.
 */
export function sessionProfiles(env = process.env, options = {}) {
  const map = options.map === undefined ? loadAccountMap() : options.map;
  const selected = accountSessionEnv(env, { ...options, map });
  const profiles = [selected];
  const unreadable = [];
  const accounts = map?.accounts && typeof map.accounts === 'object' ? map.accounts : {};
  const dirs = Object.entries(accounts)
    .filter(([, entry]) => entry && typeof entry === 'object' && Object.hasOwn(entry, 'configDir'))
    .map(([account, entry]) => [account, accountConfigDir(entry.configDir)]);
  if (dirs.length) {
    const alternate = { ...env };
    for (const key of CREDENTIAL_ENV_VARS) delete alternate[key];
    profiles.push({ ...alternate }); // preserve an explicitly inherited A job store too
    delete alternate.CLAUDE_CONFIG_DIR;
    // Legacy A jobs live in the default job store; no Keychain read is needed to inspect them.
    profiles.push(alternate);
    for (const [account, dir] of dirs) {
      try { (options.statSync ?? statSync)(dir); }
      catch (error) {
        // An account never provisioned on this machine holds no jobs, unless NEW workers are routed to it.
        if (error?.code === 'ENOENT' && !accountRouted(map, account)) continue;
        unreadable.push(account);
        continue;
      }
      // Once provisioned, a missing or unreadable login is unknown state (the CLI may not list its jobs).
      try { profiles.push({ ...alternate, ...accountEnv(account, map, options) }); }
      catch { unreadable.push(account); }
    }
  }
  const seen = new Set();
  return {
    profiles: profiles.filter(profile => {
      // Compare resolved paths: `~/x`, `x/` and an absolute `x` are one job store.
      const key = profile.CLAUDE_CONFIG_DIR ? accountConfigDir(profile.CLAUDE_CONFIG_DIR) : '';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    unreadable,
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
    const out = cachedClaudeAgents({ all, env: profile, fetch: () => exec('claude', ['agents', '--json', ...(all ? ['--all'] : [])], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      timeout, killSignal: 'SIGKILL', env: profile,
    }) });
    const rows = JSON.parse(String(out || '[]'));
    if (!Array.isArray(rows)) throw new Error('claude-account: invalid session listing');
    return rows;
  });
}

export const STOP_EXEC_OPTS = Object.freeze({ encoding: 'utf8', timeout: 30_000 });

/** Stop `id` in every readable profile. A missing job in one profile cannot authorize ownership release in
 * another: "already gone" needs a confirmed absence in EVERY profile, with none unreadable or failing.
 * A broken account never prevents stopping a job that lives in a readable one.
 */
export function stopClaudeSession({ id, exec = execFileSync, env = process.env, accountOptions } = {}) {
  const { profiles, unreadable } = sessionProfiles(env, accountOptions);
  let stopped = false;
  let failure = unreadable.length ? `config directory unavailable for account ${unreadable.join(', ')}` : null;
  const outputs = [];
  for (const profile of profiles) {
    try {
      outputs.push(String(exec('claude', ['stop', id], { ...STOP_EXEC_OPTS, env: profile })));
      stopped = true;
    } catch (error) {
      const full = String(error?.stderr ?? error?.message ?? error);
      if (!/No job matching/i.test(full)) failure ??= full.split('\n')[0];
      else outputs.push(full.split('\n')[0]);
    }
  }
  // A job lives in one profile: once it stopped there, another profile's failure cannot un-stop it.
  if (!stopped && failure) throw new Error(`dispatch-abort: \`claude stop ${id}\` failed: ${failure}`);
  return { stopped: true, alreadyGone: !stopped, output: outputs.join('\n') };
}
