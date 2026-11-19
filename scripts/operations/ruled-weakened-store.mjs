/** Canonical audit-waiver store: append operator rulings; prune explicitly. Invalid or unreadable evidence grants no waiver. */
import nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { withLedgerAppendLock } from '../lib/ledger-append-lock.mjs';

export const findingsHash = findings => createHash('sha256').update(JSON.stringify(findings)).digest('hex');

export function storePath(env = process.env) {
  if (typeof env.HOME !== 'string' || !env.HOME.trim()) throw new Error('ruled-weakened store requires HOME');
  return join(env.HOME, 'workspace/.operations/coordination/ruled-weakened.jsonl');
}
const nonblank = (v) => typeof v === 'string' && v.trim().length > 0;
const entryFields = new Set(['ref', 'sha', 'ruling', 'findings', 'actor', 'at', 'quote', 'fingerprint']);
export function validateEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && Object.keys(e).every(key => entryFields.has(key))
    && (!Object.hasOwn(e, 'fingerprint') || (typeof e.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(e.fingerprint)))
    && nonblank(e.ref) && typeof e.sha === 'string' && /^[a-f0-9]{40}$/i.test(e.sha)
    && typeof e.ruling === 'string' && /^R\d+[a-z]?(?:\+R\d+[a-z]?)*$/.test(e.ruling)
    && Array.isArray(e.findings) && e.findings.length > 0 && e.findings.every(nonblank)
    && nonblank(e.actor) && nonblank(e.quote) && typeof e.at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(e.at)
    && Number.isFinite(Date.parse(e.at));
}

export function readStore({ path = storePath(), fs = nodeFs, warn = console.warn } = {}) {
  let body;
  try { body = fs.readFileSync(path, 'utf8'); }
  catch (e) { return { entries: [], error: e.code === 'ENOENT' ? null : String(e.message ?? e) }; }
  const entries = [];
  String(body).split(/\r?\n/).forEach((line, i, lines) => {
    if (!line && i === lines.length - 1) return;
    try {
      const entry = JSON.parse(line);
      if (!validateEntry(entry)) throw new Error('invalid entry');
      const { ref, sha, ruling, findings, actor, at, quote } = entry;
      entries.push({ ref, sha, ruling, findings, actor, at, quote,
        ...(Object.hasOwn(entry, 'fingerprint') ? { fingerprint: entry.fingerprint } : {}) });
    } catch { warn(`WARNING: ruled-weakened store line ${i + 1}: malformed JSON or invalid entry; ignored`); }
  });
  return { entries, error: null };
}

/** Share one lock across append and the entire prune transaction, independent of checkout/TMPDIR.
 * The parent realpath stays stable when the store inode is replaced. Busy/unreadable locks refuse writes.
 */
export function withRuledWeakenedLock(path, fn, options = {}) {
  const parent = dirname(resolve(path));
  nodeFs.mkdirSync(parent, { recursive: true });
  const dir = nodeFs.realpathSync(parent);
  return withLedgerAppendLock(join(dir, basename(path)), fn, { ...options, dir });
}

export function appendEntry(entry, { path = storePath(), fs = nodeFs, now = () => new Date(), lockOptions, dedupe = false } = {}) {
  const value = { ...entry, at: new Date(typeof now === 'function' ? now() : now).toISOString() };
  if (!validateEntry(value)) throw new Error('invalid ruled-weakened entry: requires ref, full sha, ruling (R12 or R12+R13), findings, actor, quote and ISO at');
  return withRuledWeakenedLock(path, () => {
    if (dedupe) {
      const store = readStore({ path, fs, warn: message => { throw Error(message); } });
      if (store.error) throw Error(`Cannot deduplicate unreadable store: ${store.error}; restore readability and retry`);
      if (store.entries.some(e => e.ref === value.ref && e.sha.toLowerCase() === value.sha.toLowerCase() && e.ruling === value.ruling)) return null;
    }
    fs.mkdirSync(dirname(path), { recursive: true });
    let separator = '';
    try {
      const existing = fs.readFileSync(path, 'utf8');
      if (existing.length && !existing.endsWith('\n')) separator = '\n';
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Include any missing separator in the same append write, preserving every existing byte.
    fs.appendFileSync(path, `${separator}${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
    return value;
  }, lockOptions);
}

/** PURE: unknown lookup/carry evidence retains the original entry for operator inspection. */
export function pruneEntries(entries, { headOf, isMerged, carries }) {
  const kept = [], dropped = [];
  for (const entry of entries) {
    let drop = false;
    try {
      const head = headOf(entry.ref);
      if (head === null) drop = true;
      else if (typeof head !== 'string' || !/^[a-f0-9]{40}$/i.test(head)) throw Error('unknown ref head');
      else {
        const merged = isMerged(entry.ref);
        if (typeof merged !== 'boolean') throw Error('unknown merge status');
        drop = merged || (entry.sha.toLowerCase() !== head.toLowerCase() && carries(entry, head) === false);
      }
    } catch { /* Lookup errors are never proof that a waiver is obsolete. */ }
    (drop ? dropped : kept).push(entry);
  }
  return { kept, dropped };
}

/** IO: validate before replacing; a failed write/rename leaves the original store intact. */
export function rewriteStore({ entries, path = storePath(), fs = nodeFs }) {
  if (!Array.isArray(entries) || !entries.every(validateEntry)) throw Error('invalid ruled-weakened entries');
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = fs.mkdtempSync(`${path}.rewrite-`);
  try {
    const file = join(tmp, 'store.jsonl');
    fs.writeFileSync(file, entries.map(e => `${JSON.stringify(e)}\n`).join(''), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(file, path);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
