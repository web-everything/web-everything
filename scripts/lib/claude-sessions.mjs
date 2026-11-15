/** One boundary for profile-aware Claude session discovery and stopping.
 * Launch routing chooses NEW workers; management also visits provisioned B after rollback.
 * Keep B configured until its workers have drained. An unreadable profile is never evidence of absence.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { accountSessionEnv } from '../operations/session-role.mjs';
import { accountConfigDir, accountEnv, CREDENTIAL_ENV_VARS, loadAccountMap } from './claude-account.mjs';
import { cachedClaudeAgents } from './claude-agents-cache.mjs';

export function sessionProfileEnvs(env = process.env, options = {}) {
  const map = options.map === undefined ? loadAccountMap() : options.map;
  const selected = accountSessionEnv(env, { ...options, map });
  const profiles = [selected];
  const b = map?.accounts?.b;
  if (b && Object.hasOwn(b, 'configDir')) {
    const dir = accountConfigDir(b.configDir);
    // OFF on a machine that has never provisioned B is supported. Once its directory exists,
    // missing/unreadable login state refuses management even OFF, protecting pre-rollback workers.
    let absent = false;
    try { (options.statSync ?? statSync)(dir); }
    catch (error) {
      if (error?.code === 'ENOENT' && map.routing?.accountB !== true) absent = true;
      else throw new Error('claude-account: config directory unavailable for session management');
    }
    if (!absent) {
      const alternate = { ...env };
      for (const key of CREDENTIAL_ENV_VARS) delete alternate[key];
      profiles.push({ ...alternate }); // preserve an explicitly inherited A job store too
      delete alternate.CLAUDE_CONFIG_DIR;
      // Legacy A jobs live in the default job store; no Keychain read is needed to inspect them.
      profiles.push(alternate, { ...alternate, ...accountEnv('b', map, options) });
    }
  }
  const seen = new Set();
  return profiles.filter(profile => {
    const key = profile.CLAUDE_CONFIG_DIR || '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/** A missing job in one profile cannot authorize ownership release in another.
 * Validate all targets before the first stop, and require success/confirmed absence in every target.
 */
export function stopClaudeSession({ id, exec = execFileSync, env = process.env, accountOptions } = {}) {
  let alreadyGone = true;
  const outputs = [];
  for (const profile of sessionProfileEnvs(env, accountOptions)) {
    try {
      outputs.push(String(exec('claude', ['stop', id], { ...STOP_EXEC_OPTS, env: profile })));
      alreadyGone = false;
    } catch (error) {
      const full = String(error?.stderr ?? error?.message ?? error);
      if (!/No job matching/i.test(full)) throw new Error(`dispatch-abort: \`claude stop ${id}\` failed: ${full.split('\n')[0]}`);
      outputs.push(full.split('\n')[0]);
    }
  }
  return { stopped: true, alreadyGone, output: outputs.join('\n') };
}
