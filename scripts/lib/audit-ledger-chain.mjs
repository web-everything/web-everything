/** @file Serialized, durable audit appends; legacy records stay unchained until genesis. */
import { createHash, randomBytes } from 'node:crypto';
import * as realFs from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export const sha256Line = rawLine => createHash('sha256').update(rawLine).digest('hex');
export const newId = () => randomBytes(16).toString('hex');
const parse = line => { try { return JSON.parse(line.toString('utf8')); } catch { return null; } };
function linesOf(raw) {
  const lines = [];
  for (let start = 0, end = 0; end <= raw.length; end++) {
    if (end !== raw.length && raw[end] !== 10) continue;
    const line = raw.subarray(start, end);
    if (line.toString('utf8').trim()) lines.push(line);
    start = end + 1;
  }
  return lines;
}

/** Returns null when already migrated. Hashes original bytes, including trailing newlines. */
export function buildGenesis(rawBytes) {
  const raw = Buffer.from(rawBytes), lines = linesOf(raw);
  if (lines.some(line => parse(line)?.kind === 'genesis')) return null;
  return { kind: 'genesis', seq: 0, id: newId(), legacyCount: lines.length,
    legacyDigest: sha256Line(raw), prev: lines.length ? sha256Line(lines.at(-1)) : null,
    at: new Date().toISOString() };
}

export function readLedger(path, fs = realFs) {
  try { return Buffer.from(fs.readFileSync(path)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return Buffer.alloc(0); }
}

// Caller holds .reap through acquisition, append and release. Never reap that mutex:
// an abandoned coordinator needs operator repair rather than an unsafe lock replacement.
function reclaimStale(lock, fs, now) {
  try {
    if (now() - fs.statSync(lock).mtimeMs <= 60_000) return;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
    }
    fs.unlinkSync(lock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** 40 bounded retries; on contention, inspect both lock files before operator repair. */
export async function appendChained(path, record, { fs = realFs, sleep = setTimeout, now = Date.now } = {}) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`, coordinator = `${lock}.reap`;
  let owner, guard;
  for (let attempt = 0; owner === undefined; attempt++) {
    try {
      guard = fs.openSync(coordinator, 'wx', 0o600);
      try {
        try { owner = fs.openSync(lock, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          reclaimStale(lock, fs, now);
          owner = fs.openSync(lock, 'wx', 0o600);
        }
      } catch (error) {
        try { fs.closeSync(guard); } finally { fs.unlinkSync(coordinator); }
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= 40) throw new Error('Audit ledger lock busy; retry later or inspect the lock owner and .lock.reap coordinator; abandoned coordinators require operator repair.');
      await sleep(Math.min(10 * (attempt + 1), 100));
    }
  }
  try {
    fs.writeFileSync(owner, String(process.pid));
    const raw = readLedger(path, fs), lines = linesOf(raw), parsed = lines.map(parse);
    const separator = raw.length && raw.at(-1) !== 10 ? '\n' : '';
    const genesis = parsed.findIndex(entry => entry?.kind === 'genesis');
    if (record.kind === 'genesis') {
      record = buildGenesis(separator ? Buffer.concat([raw, Buffer.from(separator)]) : raw);
      if (!record) return null;
    } else if (genesis !== -1) {
      const last = parsed.slice(genesis).findLast(entry => Number.isSafeInteger(entry?.seq) && entry.seq >= 0);
      if (!last || last.seq === Number.MAX_SAFE_INTEGER) throw new Error('Invalid audit sequence; repair the ledger before retrying.');
      record = { ...record, id: newId(), seq: last.seq + 1, prev: sha256Line(lines.at(-1)) };
    } else {
      record = { ...record };
      delete record.id; delete record.seq; delete record.prev;
    }
    const fd = fs.openSync(path, 'a', 0o600);
    try {
      fs.appendFileSync(fd, `${separator}${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return record;
  } finally {
    try {
      try { fs.closeSync(owner); } finally { fs.unlinkSync(lock); }
    } finally {
      try { fs.closeSync(guard); } finally { fs.unlinkSync(coordinator); }
    }
  }
}
