/** Pinned diagnostic store. Journal is authoritative; receipts are a rebuildable atomic index. */
import { openSync, closeSync, readFileSync, readSync, fstatSync, writeSync, fsyncSync, mkdirSync, renameSync, constants, lstatSync, readdirSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { healthDir } from './health-watch-section.mjs';
import { scrubDeep } from './health-watch-core.mjs';
import { DEFAULT_CONFIG, RECEIPT_STATES } from './health-responder-core.mjs';
export const responderDir = (stateRoot, env) => join(dirname(healthDir(stateRoot, env)), 'health-responder');
export function boundedText(file, max = 8 * 1024 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error('non-regular or oversized input');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
const json = (p) => JSON.parse(boundedText(p));
export function readWatchGeneration(dir, { readJson = json, deadline = Infinity, clock = Date.now } = {}) {
  let episodes = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (clock() > deadline) throw new Error('tick deadline');
      const before = readJson(join(dir, 'last-tick.json'));
      const state = readJson(join(dir, 'state.json'));
      if (!state?.episodes || Array.isArray(state.episodes)) throw new Error('missing episode map');
      episodes = Object.values(state.episodes);
      if (episodes.length > 2000) throw new Error('episode limit');
      let matches = JSON.stringify(before) === JSON.stringify(state.lastTick);
      for (const [key, e] of Object.entries(state.episodes)) {
        if (clock() > deadline) throw new Error('tick deadline');
        if (!e || key !== e.key || e.key !== `${e.smell}::${e.subject}`) throw new Error('bad episode identity');
        if (e.status === 'pending') continue;
        if (!['open', 'flapping'].includes(e.status) || !/^[a-zA-Z0-9_-]+$/.test(e.id ?? '') || !e.openedAt) throw new Error('bad open identity/status');
        const report = readJson(join(dir, 'episodes', `${e.id}.json`));
        if (JSON.stringify(scrubDeep(e)) !== JSON.stringify(report)) matches = false;
        for (const field of ['id', 'key', 'smell', 'subject', 'status', 'openedAt', 'samples', 'lastBreachAt']) {
          if (JSON.stringify(e[field]) !== JSON.stringify(report[field])) matches = false;
        }
      }
      const after = readJson(join(dir, 'last-tick.json'));
      if (matches && JSON.stringify(before) === JSON.stringify(after) && Number.isFinite(before.completedAt))
        return { episodes, watchGeneration: { valid: true, completedAt: before.completedAt } };
    }
    throw new Error('mixed watch generation after retry');
  } catch (error) { return { episodes, watchGeneration: { valid: false, reason: error.message } }; }
}
export function readResponderConfig(dir) {
  try { return json(join(dir, 'config.json')); }
  catch (e) { return e.code === 'ENOENT' ? { ...DEFAULT_CONFIG, smells: {} } : null; }
}
const JOURNAL = 'decisions.jsonl';
/** The active segment is rotated out once it reaches this size, so a tick only ever reads a small file. */
export const JOURNAL_ROTATE_BYTES = 8 * 1024 * 1024;
const SEGMENT = /^decisions\.\d{8}T\d{9}Z(-\d+)?\.jsonl$/;
const ARCHIVE = 'receipts-archive.json';
/** Chunked line reader: memory stays bounded by one chunk plus one line, whatever the file size. */
function forEachLine(file, onLine) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('non-regular or oversized input');
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0), n;
    while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        if (end > start) onLine(data.toString('utf8', start, end));
        start = end + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    if (carry.length) throw new Error('partial journal');
  } finally { closeSync(fd); }
}
function parseRow(line) {
  const row = JSON.parse(line);
  if (row.schema !== 1 || row.mode !== 'shadow' || row.applied !== false || !row.rule || !row.episodeIdentity
    || !['act-would-have', 'hold', 'noop', 'escalate', 'cap-reached'].includes(row.decision)) throw new Error('corrupt journal schema');
  return row;
}
/** Rows of the ACTIVE segment only; rotated segments are complete and immutable, summarised by `archivedReceipts`. */
export function readJournal(dir) {
  const rows = [];
  try { forEachLine(join(dir, JOURNAL), (line) => rows.push(parseRow(line))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return rows;
}
/** Oldest first: by stamp, then by collision counter (a plain string sort puts `-1` before the bare name). */
function segmentNames(dir) {
  const key = (n) => { const [, stamp, c] = n.match(/^decisions\.(\d{8}T\d{9}Z)(?:-(\d+))?\.jsonl$/); return [stamp, Number(c ?? 0)]; };
  try {
    return readdirSync(dir).filter((n) => SEGMENT.test(n))
      .sort((a, b) => { const [sa, ca] = key(a), [sb, cb] = key(b); return sa < sb ? -1 : sa > sb ? 1 : ca - cb; });
  }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
/**
 * Receipts held by rotated segments. Rebuildable cache: a segment missing from the archive (a crash between rename
 * and index, or a lost/corrupt archive file) is re-read from the segment itself, so the journal stays authoritative.
 */
export function archivedReceipts(dir) {
  const names = segmentNames(dir);
  if (!names.length) return [];
  let known = [];
  try {
    const archive = JSON.parse(boundedText(join(dir, ARCHIVE), Infinity)); // size must never stop a tick; it holds receipts only
    if (archive?.schema === 1 && Array.isArray(archive.segments)) known = archive.segments;
  } catch (e) { if (!(e.code === 'ENOENT' || e instanceof SyntaxError)) throw e; }
  const byName = new Map(known.filter((s) => s && Array.isArray(s.receipts)).map((s) => [s.name, s.receipts]));
  let dirty = byName.size !== known.length || [...byName.keys()].some((n) => !names.includes(n));
  const segments = names.map((name) => {
    if (!byName.has(name)) {
      const acts = [];
      forEachLine(join(dir, name), (line) => { const row = parseRow(line); if (row.decision === 'act-would-have') acts.push(row); });
      byName.set(name, receiptsFromJournal(acts)); dirty = true;
    }
    return { name, receipts: byName.get(name) };
  });
  if (dirty) atomic(dir, ARCHIVE, { schema: 1, segments });
  return segments.flatMap((s) => s.receipts);
}
/** Every receipt the responder knows about: rotated segments plus the active one. */
export function readReceipts(dir) {
  return [...archivedReceipts(dir), ...receiptsFromJournal(readJournal(dir))];
}
/**
 * Keeps the journal append-only and complete while bounding what a tick reads: once the active segment reaches
 * `rotateBytes` it is renamed (never rewritten, truncated or deleted) to a timestamped segment and indexed.
 */
export function rotateJournalIfNeeded(dir, { rotateBytes = JOURNAL_ROTATE_BYTES, now = Date.now } = {}) {
  const file = join(dir, JOURNAL);
  let stat;
  try { stat = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!stat.isFile()) throw new Error('decision journal is not a regular file');
  if (stat.size < rotateBytes) return null;
  // Validate BEFORE moving it: a corrupt or torn active file must stay where the operator and the freeze expect it,
  // never be buried in a segment that can then never be indexed.
  forEachLine(file, parseRow);
  const stamp = new Date(now()).toISOString().replace(/[-:.]/g, '');
  let name;
  for (let n = 0; ; n++) {
    name = n ? `decisions.${stamp}-${n}.jsonl` : `decisions.${stamp}.jsonl`;
    try { linkSync(file, join(dir, name)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; } // never overwrite a segment
  }
  unlinkSync(file);
  const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
  archivedReceipts(dir);
  return name;
}
export function receiptsFromJournal(rows) {
  return rows.filter((r) => r.decision === 'act-would-have').map((r) => ({
    mode: 'shadow', state: 'prepared', simulated: true, successfulLiveAction: false,
    familyKey: r.familyKey, family: r.actionFamily, identity: r.expectedHeadOrLease,
    episodeIdentity: r.episodeIdentity, configVersion: r.configVersion, firstEligibleAt: r.at,
    submittedAt: null, confirmedAt: null, recoveredAt: null, closedAt: null, jobRef: null,
  }));
}
function ensureStore(dir) {
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('responder store must not be a symlink');
}
function atomic(dir, name, value) {
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(scrubDeep(value)) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(dir, name));
  const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
}
export function appendDecisions(dir, records, { rotateBytes } = {}) {
  ensureStore(dir);
  rotateJournalIfNeeded(dir, { rotateBytes });
  // Refuse corruption; never truncate, skip a malformed line or silently reset budgets.
  const prior = readJournal(dir), archived = archivedReceipts(dir);
  const rows = records.map((r) => scrubDeep({ ...r, schema: 1 }));
  const fd = openSync(join(dir, 'decisions.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join(''));
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  atomic(dir, 'receipts.json', { schema: 1, allowedStates: RECEIPT_STATES,
    receipts: [...archived, ...receiptsFromJournal([...prior, ...rows])], liveBudgets: [], shadowOnly: true });
  return rows;
}
export function writeLastTick(dir, record) { ensureStore(dir); atomic(dir, 'last-tick.json', record); }

/** Bounded read-only tail for the declared feed. No store writes on this path. */
export function readLatestDecisions({ stateRoot, env = process.env, limit = 50 } = {}) {
  const dir = join(dirname(healthDir(stateRoot, env)), 'health-responder');
  const want = Math.max(1, Math.min(100, limit));
  try {
    let { records, truncated } = tailRecords(join(dir, JOURNAL));
    if (records.length < want) { // Just rotated: the newest segment holds the records that precede the active one.
      const newest = segmentNames(dir).pop();
      if (newest) {
        const older = tailRecords(join(dir, newest));
        records = [...older.records, ...records]; truncated = truncated || older.truncated;
      }
    }
    if (!records.length && !truncated && !existsSync(join(dir, JOURNAL)) && !segmentNames(dir).length)
      return { mode: 'shadow', records: [], error: 'No decisions recorded' };
    return { mode: 'shadow', records: records.slice(-want), truncated };
  } catch (e) { return { mode: 'shadow', records: [], error: e.code === 'ENOENT' ? 'No decisions recorded' : e.message }; }
}
function tailRecords(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('decision journal is not a regular file');
    const size = Math.min(stat.size, 1024 * 1024), buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, stat.size - size);
    const text = buffer.toString('utf8');
    if (text && !text.endsWith('\n')) throw new Error('partial decision journal');
    const lines = text.split('\n');
    if (stat.size > size) lines.shift();
    return { records: lines.filter(Boolean).map((s) => JSON.parse(s)), truncated: stat.size > size };
  } catch (e) { if (e.code === 'ENOENT') return { records: [], truncated: false }; throw e; }
  finally { if (fd !== undefined) closeSync(fd); }
}
