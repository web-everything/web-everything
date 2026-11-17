/**
 * Ownership is granted only by a fresh source read on each invocation.
 * Local identity is a persistent random token; no ownership evidence is stored.
 * NOT yet wired into daemons.
 */
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';

export const FRESH_READ_MS = 60_000;
export const OWNER_READ_TIMEOUT_MS = 15_000;
export const OWNER_REF = 'daemon-host-owner';
export const OWNER_FILE = 'host';
// Deprecated: accept these local aliases only until the owner branch contains IDs.
export const LEGACY_OWNER_VALUES = Object.freeze(['studio', 'macbook']);
const MAX_BUFFER = 1024 * 1024;
const validId = (value) => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(value);
const validOwner = (value) => validId(value) || LEGACY_OWNER_VALUES.includes(value);
const validVersion = (value) => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const standby = (reason) => ({ role: 'standby', reason });
const stripFileNewline = (value) => value.replace(/\r?\n(?![\s\S])/, '');

export function defaultHostIdPath(home = homedir()) {
  return join(home, '.claude', 'host-id');
}

function readHostId(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 38) return '';
    const bytes = Buffer.alloc(39);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const id = stripFileNewline(bytes.subarray(0, count).toString('utf8'));
    return validId(id) ? id : '';
  } finally { closeSync(fd); }
}

/** Publish a complete ID once; concurrent creators read the winner, never replace it. */
export function getThisHost({ home = homedir(), create = true } = {}) {
  const path = defaultHostIdPath(home);
  try { return readHostId(path); }
  catch (error) { if (error.code !== 'ENOENT' || !create) return ''; }
  let temporary;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, randomUUID() + '\n', { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return readHostId(path);
  } catch { return ''; }
  finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* An orphan cannot grant ownership. */ }
    }
  }
}

export function getLegacyHost({ exec = execFileSync, hostname: fallback = hostname } = {}) {
  try {
    const value = String(exec('scutil', ['--get', 'HostName'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
    if (value) return LEGACY_OWNER_VALUES.includes(value) ? value : '';
  } catch { /* Migration can use the OS alias when the configured alias is absent. */ }
  try {
    const value = String(fallback()).trim();
    return LEGACY_OWNER_VALUES.includes(value) ? value : '';
  } catch { return ''; }
}

/** Pure decision: absent, stale, future or malformed evidence is always standby. */
export function decideHostRole({ thisHost, legacyHost = '', owner, ownerReadAt, now } = {}) {
  if (!validId(thisHost) || !Number.isFinite(now)) return standby('invalid-input');
  if (!Number.isFinite(ownerReadAt) || ownerReadAt > now || now - ownerReadAt > FRESH_READ_MS) {
    return standby('owner-unreadable');
  }
  if (owner === '') return standby('owner-unset');
  if (!validOwner(owner)) return standby('owner-unreadable');
  return owner === thisHost || (LEGACY_OWNER_VALUES.includes(owner) && owner === legacyHost)
    ? { role: 'active', reason: 'fresh-owner-is-this-host' }
    : standby('owner-is-other-host');
}

export function runGhApi(path, { execFile = execFileSync } = {}) {
  try {
    const output = execFile('gh', ['api', path], {
      timeout: 15000, maxBuffer: MAX_BUFFER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 200, body: JSON.parse(output) };
  } catch (error) {
    const message = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`;
    const status = /(?:HTTP\s+|["']?status["']?\s*:\s*)(\d{3})\b/i.exec(message);
    return { ok: false, status: status ? Number(status[1]) : null, body: message };
  }
}

/** Ownership source: readOwner() returns {host, version}; failures reject. */
export function createGithubOwnershipSource({ ghApi: api = runGhApi } = {}) {
  return {
    async readOwner() {
      const base = `repos/${CONSTELLATION_REPOS.we.slug}`;
      const ref = await api(`${base}/git/ref/heads/${OWNER_REF}`);
      if (ref?.ok === false && ref.status === 404) return { host: '', version: null };
      const version = ref?.body?.object?.sha;
      if (ref?.ok !== true || ref.status !== 200 || !validVersion(version)) throw new Error('owner ref unreadable');
      const file = await api(`${base}/contents/${OWNER_FILE}?ref=${version}`);
      if (file?.ok !== true || file.status !== 200 || file.body?.encoding !== 'base64'
        || typeof file.body.content !== 'string' || file.body.content.length > MAX_BUFFER) {
        throw new Error('owner contents unreadable');
      }
      const encoded = file.body.content.replace(/\r?\n/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/.test(encoded)) {
        throw new Error('invalid owner encoding');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error('noncanonical owner encoding');
      const host = stripFileNewline(bytes.toString('utf8'));
      if (host !== '' && !validOwner(host)) throw new Error('invalid owner ID');
      return { host, version };
    },
  };
}

/** A new bounded read for every call, with no remembered authorization. */
export async function resolveHostRole({ thisHost = getThisHost(), legacyHost,
  ownershipSource = createGithubOwnershipSource(), clock = Date.now,
  timeoutMs = OWNER_READ_TIMEOUT_MS } = {}) {
  let timer;
  try {
    if (!validId(thisHost) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > OWNER_READ_TIMEOUT_MS) {
      return { ...standby('invalid-input'), source: 'remote-failed' };
    }
    const ownerReadAt = clock();
    const started = performance.now();
    const record = await Promise.race([
      Promise.resolve().then(() => ownershipSource.readOwner()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owner timeout')), timeoutMs); }),
    ]);
    if (performance.now() - started >= timeoutMs) throw new Error('owner timeout');
    if (!record || Object.keys(record).some((key) => !['host', 'version'].includes(key))
      || !(record.host === '' || validOwner(record.host))
      || !(validVersion(record.version) || (record.host === '' && record.version === null))) {
      throw new Error('invalid owner response');
    }
    const decision = decideHostRole({ thisHost,
      legacyHost: legacyHost ?? (LEGACY_OWNER_VALUES.includes(record.host) ? getLegacyHost() : ''),
      owner: record.host, ownerReadAt, now: clock() });
    return { ...decision, source: decision.reason === 'owner-unreadable' ? 'remote-failed' : 'remote' };
  } catch {
    return { ...standby('owner-unreadable'), source: 'remote-failed' };
  } finally { clearTimeout(timer); }
}
