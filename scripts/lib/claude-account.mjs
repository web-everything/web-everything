/** Auth split: pick the Claude account a launchd daemon's spawned sessions should use.
 *  Pure resolution + a config directory or an in-process Keychain read. The token is never logged, returned in an error, or put in argv. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync as defaultStatSync, accessSync as defaultAccessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'claude-accounts.json');
export const CREDENTIAL_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const DAEMON_LABEL = /^com\.(we|plateau)\./;

/** The map, or null when unreadable (callers treat null as "nothing mapped"). */
export function loadAccountMap({ path = MAP_PATH } = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** @returns {{kind:'none'}|{kind:'account',account:string,label:string}|{kind:'refuse',label:string}} */
export function resolveAccount(env, map) {
  const label = env && typeof env === 'object' ? env.XPC_SERVICE_NAME : undefined;
  if (typeof label !== 'string' || !DAEMON_LABEL.test(label)) return { kind: 'none' };
  if (!map || typeof map !== 'object') return { kind: 'none' };
  if (map.daemons && Object.hasOwn(map.daemons, label)) {
    const account = map.daemons[label];
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

/** Env entries for `account`. Config directories require a directory and a readable, non-empty regular .claude.json;
 *  login contents are never read. IO failures throw a safe error without the underlying error's contents. */
export function accountEnv(account, map, { readKeychain = defaultReadKeychain, statSync = defaultStatSync, accessSync = defaultAccessSync } = {}) {
  const entry = map?.accounts && Object.hasOwn(map.accounts, account) ? map.accounts[account] : undefined;
  if (!entry) throw new Error(`claude-account: unknown account ${JSON.stringify(String(account))}`);
  if (Object.hasOwn(entry, 'configDir')) {
    const configDir = entry.configDir;
    const dir = typeof configDir === 'string' && configDir.startsWith('~/') ? join(homedir(), configDir.slice(2)) : configDir === '~' ? homedir() : configDir;
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
