/** Auth split: pick the Claude account a launchd daemon's spawned sessions should use.
 *  Pure resolution + a config directory or an in-process Keychain read. The token is never logged, returned in an error, or put in argv. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync as defaultStatSync, accessSync as defaultAccessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'claude-accounts.json');
export const CREDENTIAL_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const DAEMON_LABEL = /^com\.(we|plateau)\./;

/** Fixed, repo-relative diagnostic: never the parse/IO error, the absolute path or the file contents. */
export const ACCOUNT_MAP_UNAVAILABLE = 'claude-account: account map unavailable at scripts/settings/claude-accounts.json; '
  + 'daemon launch and session management refused (no fallback to the inherited login); repair scripts/settings/claude-accounts.json and retry';

/** Structural check shared by the loader and by callers that inject a map. An intentionally empty map
 *  must still contain both accounts and daemons objects. */
export function isValidAccountMap(map) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  return record(map) && record(map.accounts) && record(map.daemons)
    && Object.values(map.accounts).every(entry => record(entry)
      && (Object.hasOwn(entry, 'configDir') ? nonempty(entry.configDir)
        : nonempty(entry.service) && nonempty(entry.account)
          && (entry.type === undefined || entry.type === 'oauth' || entry.type === 'apikey')))
    && Object.values(map.daemons).every(account => typeof account === 'string' && Object.hasOwn(map.accounts, account))
    && (map.routing === undefined || (record(map.routing)
      && (map.routing.accountB === undefined || typeof map.routing.accountB === 'boolean')));
}

/** The validated map, read fresh on every call (a repaired file takes effect without a restart).
 *  Fails closed: a missing, unreadable, unparseable or structurally invalid map throws
 *  {@link ACCOUNT_MAP_UNAVAILABLE}; it is never "nothing mapped". */
export function loadAccountMap({ path = MAP_PATH } = {}) {
  let map;
  try { map = JSON.parse(readFileSync(path, 'utf8')); } catch { map = undefined; }
  if (!isValidAccountMap(map)) throw new Error(ACCOUNT_MAP_UNAVAILABLE);
  return map;
}

/** The launchd daemon label in `env`, or null for interactive and non-launchd callers (which never read the map). */
export function daemonLabel(env) {
  const label = env && typeof env === 'object' ? env.XPC_SERVICE_NAME : undefined;
  return typeof label === 'string' && DAEMON_LABEL.test(label) ? label : null;
}

/** @returns {{kind:'none'}|{kind:'account',account:string,label:string}|{kind:'refuse',label:string}} */
export function resolveAccount(env, map) {
  const label = daemonLabel(env);
  if (!label) return { kind: 'none' };
  // An unavailable map cannot prove this daemon is unmapped: refuse rather than keep the inherited login.
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { kind: 'refuse', label };
  if (map.daemons && Object.hasOwn(map.daemons, label)) {
    const account = map.daemons[label];
    if (typeof account !== 'string') return { kind: 'refuse', label };
    if (!map.accounts || !Object.hasOwn(map.accounts, account) || !map.accounts[account]) return { kind: 'refuse', label };
    if (account === 'b') {
      const accountB = map.routing?.accountB;
      if (accountB !== undefined && typeof accountB !== 'boolean') return { kind: 'refuse', label };
      if (accountB !== true) return { kind: 'none' };
    }
    return { kind: 'account', account, label };
  }
  return map.enforce === true && map['*'] === 'refuse' ? { kind: 'refuse', label } : { kind: 'none' };
}

function defaultReadKeychain(service, account) {
  return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
}

/** Resolve once, before a CLI changes cwd. Shared by launch and management profile discovery. */
export function accountConfigDir(configDir) {
  const expanded = typeof configDir === 'string' && configDir.startsWith('~/') ? join(homedir(), configDir.slice(2)) : configDir === '~' ? homedir() : configDir;
  return typeof expanded === 'string' && expanded ? resolve(expanded) : expanded;
}

/** Env entries for `account`. Config directories require a directory and a readable, non-empty regular .claude.json;
 *  login contents are never read. IO failures throw a safe error without the underlying error's contents. */
export function accountEnv(account, map, { readKeychain = defaultReadKeychain, statSync = defaultStatSync, accessSync = defaultAccessSync } = {}) {
  const entry = map?.accounts && Object.hasOwn(map.accounts, account) ? map.accounts[account] : undefined;
  if (!entry) throw new Error(`claude-account: unknown account ${JSON.stringify(String(account))}`);
  if (Object.hasOwn(entry, 'configDir')) {
    const configDir = entry.configDir;
    // The CLI starts in a different scratch cwd: pin the profile before validating and launching it.
    const dir = accountConfigDir(configDir);
    try {
      if (typeof dir !== 'string' || !dir || !statSync(dir).isDirectory()) throw new Error('invalid directory');
      const loginPath = join(dir, '.claude.json');
      const loginStat = statSync(loginPath);
      if (!loginStat.isFile() || !(loginStat.size > 0)) throw new Error('invalid login file');
      accessSync(loginPath, constants.R_OK);
    } catch {
      throw new Error(`claude-account: account ${JSON.stringify(String(account))} config directory ${JSON.stringify(dir)} must exist, be a directory, and contain a readable, non-empty regular .claude.json; provision the login directory before retrying`);
    }
    return { CLAUDE_CONFIG_DIR: dir };
  }
  let value;
  try { value = String(readKeychain(entry.service, entry.account) ?? '').trim(); }
  catch { throw new Error(`claude-account: could not read the Keychain item for account ${account} (${entry.service}/${entry.account})`); }
  if (!value) throw new Error(`claude-account: empty Keychain item for account ${account} (${entry.service}/${entry.account})`);
  const name = entry.type === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  return { [name]: value, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
}
