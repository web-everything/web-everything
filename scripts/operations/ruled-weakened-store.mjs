/** Append-only operator rulings. Invalid or unreadable evidence grants no waiver. */
import nodeFs from 'node:fs';
import { dirname, join } from 'node:path';

export function storePath(env = process.env) {
  if (typeof env.HOME !== 'string' || !env.HOME.trim()) throw new Error('ruled-weakened store requires HOME');
  return join(env.HOME, 'workspace/.operations/coordination/ruled-weakened.jsonl');
}
const nonblank = (v) => typeof v === 'string' && v.trim().length > 0;
const entryFields = new Set(['ref', 'sha', 'ruling', 'findings', 'actor', 'at', 'quote', 'auditId']);
export function validateEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && Object.keys(e).every(key => entryFields.has(key))
    && (e.auditId === undefined || nonblank(e.auditId))
    && nonblank(e.ref) && typeof e.sha === 'string' && /^[a-f0-9]{40}$/i.test(e.sha)
    && typeof e.ruling === 'string' && /^R\d+(?:\+R\d+)*$/.test(e.ruling)
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
      entries.push({ ref, sha, ruling, findings, actor, at, quote, ...(entry.auditId ? { auditId: entry.auditId } : {}) });
    } catch { warn(`WARNING: ruled-weakened store line ${i + 1}: malformed JSON or invalid entry; ignored`); }
  });
  return { entries, error: null };
}

export function appendEntry(entry, { path = storePath(), fs = nodeFs, now = () => new Date() } = {}) {
  const value = { ...entry, at: new Date(typeof now === 'function' ? now() : now).toISOString() };
  if (!validateEntry(value)) throw new Error('invalid ruled-weakened entry: requires ref, full sha, ruling (R12 or R12+R13), findings, actor, quote and ISO at');
  fs.mkdirSync(dirname(path), { recursive: true });
  let separator = '';
  try {
    const existing = fs.readFileSync(path, 'utf8');
    if (existing.length && !existing.endsWith('\n')) separator = '\n';
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Include any missing separator in the same append write, preserving every existing byte.
  fs.appendFileSync(path, `${separator}${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
  return value;
}
