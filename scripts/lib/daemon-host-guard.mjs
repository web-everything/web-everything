/**
 * Ownership requires a new successful source read on every call. No ownership
 * evidence is persisted. NOT yet wired into daemons.
 */
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FRESH_READ_MS = 60_000;
export const OWNER_REF = 'daemon-host-owner';
export const OWNER_FILE = 'host';
const MAX_BUFFER = 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;
const validId = (value) => typeof value === 'string' && value.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const validAlias = (value) => typeof value === 'string' && value.length <= 253
  && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?![\s\S])/.test(value) && !validId(value);
const legacyOwner = (value, aliases) => validAlias(value) && Array.isArray(aliases) && aliases.includes(value);
const validOwner = (value, aliases) => validId(value) || legacyOwner(value, aliases);
const standby = (reason) => ({ role: 'standby', reason });
const lineValue = (value) => value.replace(/\r?\n$/, '');

/** Deprecated migration aliases: exact comma-separated names in local env only. */
export function getLegacyOwnerValues(env = process.env) {
  const raw = env.WE_DAEMON_LEGACY_OWNER_VALUES;
  if (typeof raw !== 'string' || raw.length > 1024) return Object.freeze([]);
  const aliases = raw.split(',');
  return Object.freeze(aliases.every(validAlias) ? aliases : []);
}

export function defaultHostIdPath(home = homedir()) {
  return join(home, '.claude', 'host-id');
}

function readHostId(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > 38
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('invalid host ID file');
    const bytes = Buffer.alloc(39);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const id = lineValue(bytes.subarray(0, length).toString('utf8'));
    if (!validId(id)) throw new Error('invalid host ID');
    return id;
  } finally { closeSync(fd); }
}

/** Provision once with atomic, no-overwrite publication; corrupt IDs stay closed. */
export function getThisHost({ home = homedir(), create = true } = {}) {
  const path = defaultHostIdPath(home);
  try {
    try { return readHostId(path); }
    catch (error) { if (!create || error.code !== 'ENOENT') return ''; }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, randomUUID() + '\n', { mode: 0o600, flag: 'wx' });
      try { linkSync(temporary, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { unlinkSync(temporary); }
    return readHostId(path);
  } catch { return ''; }
}

/** Local names are consulted only for the deprecated migration aliases. */
export function getLegacyHost({ exec = execFileSync, hostname: fallback = hostname,
  legacyOwnerValues = getLegacyOwnerValues() } = {}) {
  if (!Array.isArray(legacyOwnerValues) || legacyOwnerValues.length === 0) return '';
  let name;
  try {
    name = String(exec('scutil', ['--get', 'HostName'], {
      encoding: 'utf8', timeout: READ_TIMEOUT_MS, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
  } catch { /* The OS name remains a migration-only fallback. */ }
  if (!name) {
    try { name = String(fallback()).trim(); } catch { return ''; }
  }
  return legacyOwner(name, legacyOwnerValues) ? name : '';
}

/** Pure decision over fresh evidence; timestamps in the future fail closed. */
export function decideHostRole({ thisHost, owner, ownerReadAt, now, legacyHost = '', legacyOwnerValues = [] } = {}) {
  if (!validId(thisHost) || !Number.isFinite(now)) return standby('invalid-input');
  if (!Number.isFinite(ownerReadAt) || ownerReadAt > now || now - ownerReadAt > FRESH_READ_MS) {
    return standby('owner-unreadable');
  }
  if (owner === '') return standby('owner-unset');
  if (!validOwner(owner, legacyOwnerValues)) return standby('owner-unreadable');
  return owner === thisHost || (legacyOwner(owner, legacyOwnerValues) && owner === legacyHost)
    ? { role: 'active', reason: 'fresh-owner-is-this-host' }
    : standby('owner-is-other-host');
}

export function runGhApi(path, { execFile = execFileSync } = {}) {
  try {
    const output = execFile('gh', ['api', path], {
      timeout: READ_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 200, body: JSON.parse(output) };
  } catch (error) {
    const message = String(error?.stderr ?? '') + '\n' + String(error?.stdout ?? '') + '\n' + String(error?.message ?? error);
    const status = /(?:HTTP\s+|["']?status["']?\s*:\s*)(\d{3})\b/i.exec(message);
    return { ok: false, status: status ? Number(status[1]) : null };
  }
}

/** OwnershipSource: readOwner() -> Promise<{host: string, version: string}>. */
export function createGitHubOwnershipSource({ ghApi: api = runGhApi, legacyOwnerValues = getLegacyOwnerValues() } = {}) {
  return {
    async readOwner() {
      const base = `repos/${CONSTELLATION_REPOS.we.slug}`;
      const ref = await api(`${base}/git/ref/heads/${OWNER_REF}`);
      if (ref?.ok === false && ref.status === 404) return { host: '', version: 'unset' };
      const version = ref?.body?.object?.sha;
      if (ref?.ok !== true || ref.status !== 200 || ref.body?.object?.type !== 'commit'
        || typeof version !== 'string' || version.length !== 40 || !/^[a-f0-9]{40}$/.test(version)) throw new Error('owner ref unreadable');
      // Pin contents to the observed commit so a moving branch cannot mix versions.
      const file = await api(`${base}/contents/${OWNER_FILE}?ref=${version}`);
      if (file?.ok !== true || file.status !== 200 || file.body?.type !== 'file'
        || file.body.encoding !== 'base64' || typeof file.body.content !== 'string'
        || file.body.content.length > 1024) throw new Error('owner contents unreadable');
      const encoded = file.body.content.replace(/[\r\n]/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('invalid owner encoding');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error('noncanonical owner encoding');
      const host = lineValue(bytes.toString('utf8'));
      if (host !== '' && !validOwner(host, legacyOwnerValues)) throw new Error('invalid owner ID');
      return { host, version };
    },
  };
}

/** Each invocation performs its own bounded read, including startup and retries. */
export async function resolveHostRole({ thisHost = getThisHost(), legacyOwnerValues = getLegacyOwnerValues(),
  source = createGitHubOwnershipSource({ legacyOwnerValues }),
  legacyHost, clock = () => performance.now(), timeoutMs = READ_TIMEOUT_MS } = {}) {
  let timer;
  try {
    if (!validId(thisHost) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > FRESH_READ_MS) {
      return { ...standby('invalid-input'), source: 'remote-failed' };
    }
    const started = clock();
    const result = await Promise.race([
      Promise.resolve().then(() => source.readOwner()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owner read timeout')), timeoutMs); }),
    ]);
    if (!result || Object.keys(result).some((key) => !['host', 'version'].includes(key))
      || (result.host !== '' && !validOwner(result.host, legacyOwnerValues))
      || typeof result.version !== 'string' || result.version.length < 1 || result.version.length > 128
      || /[^A-Za-z0-9._-]/.test(result.version)) {
      throw new Error('unexpected owner result');
    }
    const localAlias = legacyOwner(result.host, legacyOwnerValues) ? legacyHost ?? getLegacyHost({ legacyOwnerValues }) : '';
    const finished = clock();
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started
      || finished - started >= timeoutMs) throw new Error('owner read expired');
    return { ...decideHostRole({ thisHost, owner: result.host, ownerReadAt: started, now: finished,
      legacyHost: localAlias, legacyOwnerValues }),
      source: 'remote' };
  } catch {
    return { ...standby('owner-unreadable'), source: 'remote-failed' };
  } finally { clearTimeout(timer); }
}
