/** Auth split (PR1): pick the Claude account a launchd daemon's spawned sessions should use.
 *  Pure resolution + an in-process Keychain read. The token is never logged, returned in an error, or put in argv. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'claude-accounts.json');
export const CREDENTIAL_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const DAEMON_LABEL = /^com\.(we|plateau)\./;

/** Expand only absolute selectors; preserve segments for filesystem symlink resolution. */
export function expandConfigDir(dir, home) {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) return null;
  if (dir === '~' || dir.startsWith('~/')) {
    if (typeof home !== 'string' || !isAbsolute(home)) return null;
    const separator = home.endsWith('/') ? '' : '/';
    dir = dir === '~' ? home : `${home}${separator}${dir.slice(2)}`;
  }
  return isAbsolute(dir) ? dir : null;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Strict validation for new consumers; legacy resolution remains unchanged. */
export function isAccountMap(map) {
  if (!record(map) || !record(map.accounts) || !record(map.daemons)) return false;
  if (map.enforce !== undefined && typeof map.enforce !== 'boolean') return false;
  if (map['*'] !== undefined && map['*'] !== 'refuse') return false;
  if (map.routing !== undefined && (!record(map.routing)
    || (map.routing.accountB !== undefined && typeof map.routing.accountB !== 'boolean'))) return false;
  if (!Object.values(map.accounts).every(entry => record(entry) && (Object.hasOwn(entry, 'configDir')
    ? expandConfigDir(entry.configDir, '/') !== null
    : nonempty(entry.service) && nonempty(entry.account)
      && (entry.type === undefined || entry.type === 'oauth' || entry.type === 'apikey')))) return false;
  return Object.values(map.daemons).every(account => typeof account === 'string' && Object.hasOwn(map.accounts, account));
}

export class AccountRefusal extends Error {
  constructor(reason = 'account-unavailable') {
    super(`claude-account: ${reason}; repair account configuration and retry`);
    this.name = 'AccountRefusal';
    this.reason = reason;
    this.notApplied = true;
  }
}

export function isNotApplied(error) {
  return error instanceof AccountRefusal && error.notApplied === true;
}

/** The map, or null when unreadable (callers treat null as "nothing mapped"). */
export function loadAccountMap({ path = MAP_PATH } = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** @returns {{kind:'none'}|{kind:'account',account:string,label:string}|{kind:'refuse',label:string}} */
export function resolveAccount(env, map) {
  const label = env && typeof env === 'object' ? env.XPC_SERVICE_NAME : undefined;
  if (typeof label !== 'string' || !DAEMON_LABEL.test(label)) return { kind: 'none' };
  if (!map || typeof map !== 'object') return { kind: 'none' };
  const mapped = map.daemons && Object.hasOwn(map.daemons, label) ? map.daemons[label] : undefined;
  if (mapped !== undefined) {
    return map.accounts && Object.hasOwn(map.accounts, mapped) ? { kind: 'account', account: mapped, label } : { kind: 'refuse', label };
  }
  return map.enforce === true && map['*'] === 'refuse' ? { kind: 'refuse', label } : { kind: 'none' };
}

function defaultReadKeychain(service, account) {
  return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
}

/** Env entries for `account`. Throws a generic error (never the secret) when the item cannot be read. */
export function accountEnv(account, map, { readKeychain = defaultReadKeychain } = {}) {
  const entry = map?.accounts && Object.hasOwn(map.accounts, account) ? map.accounts[account] : undefined;
  if (!entry) throw new Error(`claude-account: unknown account ${JSON.stringify(String(account))}`);
  let value;
  try { value = String(readKeychain(entry.service, entry.account) ?? '').trim(); }
  catch { throw new Error(`claude-account: could not read the Keychain item for account ${account} (${entry.service}/${entry.account})`); }
  if (!value) throw new Error(`claude-account: empty Keychain item for account ${account} (${entry.service}/${entry.account})`);
  const name = entry.type === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  return { [name]: value, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
}
