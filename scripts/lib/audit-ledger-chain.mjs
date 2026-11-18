/** @file Serialized, durable audit appends; legacy records stay unchained until genesis. */
import { createHash, randomBytes } from 'node:crypto';
import * as realFs from 'node:fs';
import { dirname, join } from 'node:path';
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
export function buildGenesis(rawBytes, reseal) {
  const raw = Buffer.from(rawBytes), lines = linesOf(raw);
  if (!reseal && lines.some(line => parse(line)?.kind === 'genesis')) return null;
  return { ...reseal, kind: 'genesis', seq: 0, id: newId(), legacyCount: lines.length,
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

const hwmPath = path => join(dirname(path), 'audits.hwm.json');
const isChained = entry => Number.isSafeInteger(entry?.seq) && typeof entry.id === 'string' && (typeof entry.prev === 'string' || entry.kind === 'genesis');
const tamper = message => Object.assign(new Error(message), { code: 'LEDGER_TAMPER' });
/**
 * Refuses only real tampering: rewritten legacy bytes or chained records, a rollback below the
 * high-water mark, or a missing sidecar after genesis. Unchained post-genesis lines (stale writers)
 * are skipped for linking. Returns the index of the last chained line, or -1 before genesis.
 */
function assertHighWater(path, raw, lines, parsed, fs) {
  const g = parsed.findLastIndex(entry => entry?.kind === 'genesis');
  let hwm;
  try { hwm = JSON.parse(fs.readFileSync(hwmPath(path), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && g === -1) return -1;
    throw tamper(error.code === 'ENOENT' ? 'Audit ledger high-water mark missing after genesis; orchestrator reseal required.'
      : 'Audit ledger high-water mark unreadable; orchestrator reseal required.');
  }
  const broken = () => { throw tamper(`Audit ledger chain broken, rollback detected (high-water seq ${hwm?.seq}); refusing to append.`); };
  if (g === -1) broken();
  // Every legacy byte before genesis and every chained link since must still match.
  if (sha256Line(raw.subarray(0, lines[g].byteOffset - raw.byteOffset)) !== parsed[g].legacyDigest) broken();
  let last = g;
  for (let i = g + 1; i < lines.length; i++) {
    if (!isChained(parsed[i])) continue;
    if (parsed[i].seq !== parsed[last].seq + 1 || parsed[i].prev !== sha256Line(lines[last])) broken();
    last = i;
  }
  const at = parsed.findIndex((entry, i) => i >= g && isChained(entry) && entry.seq === hwm?.seq);
  if (at === -1 || parsed[last].seq < hwm.seq || sha256Line(lines[at]) !== hwm.lineHash) broken();
  return last;
}
function writeHighWater(path, record, line, fs) {
  const tmp = `${hwmPath(path)}.${process.pid}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ seq: record.seq, lineHash: sha256Line(line) })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, hwmPath(path));
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
    const lastIdx = record.reseal ? -1 : assertHighWater(path, raw, lines, parsed, fs);
    if (record.kind === 'genesis') {
      record = buildGenesis(separator ? Buffer.concat([raw, Buffer.from(separator)]) : raw, record.reseal && record);
      if (!record) return null;
    } else if (lastIdx !== -1) {
      const last = parsed[lastIdx];
      if (last.seq === Number.MAX_SAFE_INTEGER) throw new Error('Invalid audit sequence; repair the ledger before retrying.');
      record = { ...record, id: newId(), seq: last.seq + 1, prev: sha256Line(lines[lastIdx]) };
    } else {
      record = { ...record };
      delete record.id; delete record.seq; delete record.prev;
    }
    const fd = fs.openSync(path, 'a', 0o600);
    try {
      fs.appendFileSync(fd, `${separator}${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (Number.isSafeInteger(record.seq)) writeHighWater(path, record, Buffer.from(JSON.stringify(record)), fs);
    return record;
  } catch (error) {
    // Nothing is silently lost: the record the writer meant to append goes to a side file.
    if (error.code === 'LEDGER_TAMPER') {
      fs.appendFileSync(join(dirname(path), 'audits.quarantine.jsonl'),
        `${JSON.stringify({ ...record, quarantinedAt: new Date().toISOString(), quarantineReason: error.message })}\n`, { mode: 0o600 });
    }
    throw error;
  } finally {
    try {
      try { fs.closeSync(owner); } finally { fs.unlinkSync(lock); }
    } finally {
      try { fs.closeSync(guard); } finally { fs.unlinkSync(coordinator); }
    }
  }
}
