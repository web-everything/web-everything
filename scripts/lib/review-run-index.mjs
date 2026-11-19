/** Bounded discovery hint, never review evidence. Lives beside the shared runs folder.
 * Overflow/corruption/missing records fall back to the ordinary scan and its HOLD.
 * Backfill stages a complete pass over review ids, at most 50 payloads per drain tick.
 */
import { closeSync, openSync, writeSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isValidRunId, parseRunRecord } from '../operations/run-record.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';

/** Shared scan/backfill guard: even unrelated malformed evidence prevents a negative proof. */
export function assertReviewRunEvidence(run) {
  const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
  if (!object(run) || typeof run.op !== 'string' || !run.op.trim()) throw Error('run identity unreadable');
  // The filename is only a candidate selector. Missing identity must not classify
  // a corrupt review as unrelated and turn an incomplete scan into a proof.
  if (run.op === 'review-pr' && (!object(run.input)
    || typeof run.input.repo !== 'string' || !run.input.repo.trim()
    || !['string', 'number'].includes(typeof run.input.pr)
    || !Number.isSafeInteger(Number(run.input.pr)) || Number(run.input.pr) <= 0
    || !Array.isArray(run.effects)
    || !(run.pending == null || object(run.pending))
    || !(run.verdict === null || (object(run.verdict)
      && typeof run.verdict.verdict === 'string' && run.verdict.verdict.trim())))) {
    throw Error('review run identity or evidence unreadable');
  }
}

const FULL_VALIDATION_VERSION = 1; // Older full snapshots did not validate verdict evidence.
const MAX_KEYS = 512, MAX_IDS = 32, MAX_BYTES = 1024 * 1024;
const FULL_MAX_BYTES = 4 * MAX_BYTES; // open/full snapshots plus a bounded staged pass
const reviewId = id => isValidRunId(id) && id.startsWith('review-pr-');
const keyOf = (repo, pr) => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)
  && Number.isSafeInteger(Number(pr)) && Number(pr) > 0 ? `${repo}#${Number(pr)}` : null;
export const reviewRunIndexPath = runsDir => join(dirname(runsDir), `${basename(runsDir)}-review-index.json`);
/** Append-only discovery journal; payloads remain the authority. */
export const reviewRunJournalPath = runsDir => join(dirname(runsDir), `${basename(runsDir)}-review-index.jsonl`);
const journalIdentity = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs, metadata.birthtimeMs];
const validJournalIdentity = identity => Array.isArray(identity) && identity.length === 6
  && identity.every(Number.isFinite);
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/** One O_APPEND write: an intent before publication, or a seal of the final path afterward.
 * The writer owns best-effort error handling. Never seal temporary-file metadata. */
export function appendReviewRunJournal(record, runsDir, at = Date.now(), metadata) {
  const key = keyOf(record?.input?.repo, record?.input?.pr);
  if (record?.op !== 'review-pr' || !reviewId(record.id) || !key) return false;
  const row = metadata ? { id: record.id, key, seal: journalIdentity(metadata) } : { id: record.id, key, at };
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
  const fd = openSync(reviewRunJournalPath(runsDir), 'a');
  try {
    if (writeSync(fd, bytes) !== bytes.length) throw Error('short review journal write');
  } finally { closeSync(fd); }
  return true;
}

function journalKeys(runsDir) {
  const path = reviewRunJournalPath(runsDir);
  if (statSync(path).size > JOURNAL_MAX_BYTES) throw Error('review journal oversized');
  const bytes = readFileSync(path);
  if (bytes.length > JOURNAL_MAX_BYTES) throw Error('review journal oversized');
  const rows = bytes.toString('utf8').split('\n');
  rows.pop(); // Never trust a final line without its publication newline.
  const keys = new Map();
  for (const text of rows) {
    let row;
    try { row = JSON.parse(text); } catch { continue; } // Invalid lines supply no evidence.
    if (!reviewId(row?.id)) continue;
    const match = typeof row.key === 'string' && /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(row.key);
    const rowKey = match && keyOf(match[1], match[2]) === row.key ? row.key : null;
    const prior = keys.get(row.id);
    const key = prior && prior.key !== rowKey ? null : rowKey;
    keys.set(row.id, { key, seal: row.seal }); // Conflicts remain unknown; only the last line can seal.
  }
  return keys;
}

/** Complete candidate set, or null to request the bounded fallback. The non-enumerable
 * journalSet identifies candidates requiring full key verification by the payload reader. */
export function readJournalCandidates(runsDir, repo, pr, {
  list = listReviewIds, stat = id => statSync(join(runsDir, `${id}.json`)),
} = {}) {
  try {
    const key = keyOf(repo, pr);
    if (!key) return null;
    if (statSync(reviewRunJournalPath(runsDir)).size > JOURNAL_MAX_BYTES) return null;
    const snapshot = () => {
      const names = readdirSync(runsDir);
      if (names.some(name => /^\.review-pr-.*\.archiving-/.test(name))) throw Error('review archive in progress');
      return { names: names.sort(), ids: list(runsDir).filter(reviewId).sort() };
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = snapshot(), keys = journalKeys(runsDir), after = snapshot();
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      const ids = [], journalSet = new Set();
      let unjournaled = 0;
      for (const id of after.ids) {
        const entry = keys.get(id);
        let target = entry?.key;
        try {
          if (target === key) { ids.push(id); journalSet.add(id); continue; }
          const metadata = stat(id);
          if (!validJournalIdentity(entry?.seal)
            || JSON.stringify(entry.seal) !== JSON.stringify(journalIdentity(metadata))) target = null;
        } catch { target = null; }
        if (target == null) { ids.push(id); unjournaled++; }
      }
      return Object.defineProperty({ ids, source: 'journal', unjournaled }, 'journalSet', { value: journalSet });
    }
    return null;
  } catch { return null; }
}

/** Seed readable, previously unjournaled records without rewriting concurrent appends. */
export function seedReviewRunJournal({ runsDir, list = listReviewIds, read = id => readRecord(runsDir, id),
  stat = id => statSync(join(runsDir, `${id}.json`)),
} = {}) {
  let keys;
  try { keys = journalKeys(runsDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; keys = new Map(); }
  const counts = { seeded: 0, already: 0, skipped: 0 };
  for (const id of list(runsDir).filter(reviewId)) {
    try {
      const before = stat(id);
      const entry = keys.get(id);
      if (entry?.key && validJournalIdentity(entry.seal)
        && JSON.stringify(entry.seal) === JSON.stringify(journalIdentity(before))) { counts.already++; continue; }
      const run = read(id, runsDir);
      recordKey(run, id);
      const after = stat(id);
      if (JSON.stringify(journalIdentity(before)) !== JSON.stringify(journalIdentity(after))) throw Error('run changed during journal seed');
      if (appendReviewRunJournal(run, runsDir, after.mtimeMs, after)) counts.seeded++;
      else counts.skipped++;
    } catch { counts.skipped++; }
  }
  // An empty seed still makes an empty journal available for subsequent writes.
  const fd = openSync(reviewRunJournalPath(runsDir), 'a');
  closeSync(fd);
  return counts;
}

function readJson(path, maxBytes = MAX_BYTES) {
  if (statSync(path).size > maxBytes) throw Error('review index oversized');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function validEntries(index) {
  return index && typeof index === 'object' && !Array.isArray(index) && Object.keys(index).length <= MAX_KEYS
    && Object.entries(index).every(([key, entries]) => key.length <= 256 && Array.isArray(entries) && entries.length <= MAX_IDS
      && entries.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs)));
}
// Bind completeness to the exact rebuilt entries and loss markers. Stat-only
// file coverage cannot detect deleted keys/rows in an otherwise intact sidecar.
// This is a consistency check, not authentication against a writer forging both.
function fullEntriesDigest(full) {
  return createHash('sha256').update(JSON.stringify([full.entries, full.evicted])).digest('hex');
}
function hasFullEntriesProof(full) {
  return typeof full?.completeness?.entriesDigest === 'string'
    && full.completeness.entriesDigest === fullEntriesDigest(full);
}
function load(path) {
  const index = readJson(path, FULL_MAX_BYTES);
  if (index?.version === 2 && validEntries(index.entries)) return index;
  if (validEntries(index)) return { version: 2, entries: index }; // legacy hints have no completeness proof
  throw Error('invalid review index');
}
function writeBounded(path, value) {
  const maxBytes = value.fullReviewRuns ? FULL_MAX_BYTES : MAX_BYTES;
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > maxBytes) throw Error('review index oversized; inspect omitted runs manually');
  writeJsonAtomic(path, value);
}
const listReviewIds = dir => readdirSync(dir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(reviewId);
function poisonNames(path) {
  try { return readdirSync(`${path}.poison`).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function poison(path) {
  try {
    mkdirSync(`${path}.poison`, { recursive: true });
    // Unique, create-only markers cannot lose a failure racing a backfill or another writer.
    writeFileSync(join(`${path}.poison`, randomUUID()), '', { flag: 'wx' });
  } catch { /* The reader's stat-only snapshot check also detects a lost append. */ }
}
function listing(runsDir, list, stat) {
  return list(runsDir).filter(reviewId).sort().map(id => {
    const metadata = stat(id), mtimeMs = metadata.mtimeMs;
    if (!Number.isFinite(mtimeMs)) throw Error('unreadable review mtime');
    // Run-store writes use atomic replacement. File identity detects a missed append
    // even when a replacement preserves a coarse/old mtime and poison creation failed.
    const identity = [metadata.dev, metadata.ino, metadata.size, metadata.ctimeMs, metadata.birthtimeMs].map(value => value ?? null);
    return { id, mtimeMs, identity };
  });
}
function readRecord(runsDir, id) {
  const parsed = parseRunRecord(readFileSync(join(runsDir, `${id}.json`), 'utf8'));
  if (!parsed.ok) throw Error(parsed.reason);
  return parsed.record;
}
function recordKey(record, id) {
  assertReviewRunEvidence(record);
  const key = keyOf(record?.input?.repo, record?.input?.pr);
  if (record?.id !== id || record.op !== 'review-pr' || !key) throw Error('unverified backfill record');
  return key;
}
function readIndexedRuns(runsDir, repo, pr, full, {
  list = listReviewIds, stat = id => statSync(join(runsDir, `${id}.json`)),
  read = id => readRecord(runsDir, id),
} = {}) {
  try {
    const path = reviewRunIndexPath(runsDir), loaded = load(path), index = full ? loaded.fullReviewRuns : loaded, proof = index?.completeness;
    const key = keyOf(repo, pr);
    if (!key || !validEntries(index?.entries)) return null;
    const rows = index.entries[key] ?? [];
    if (full && (!hasFullEntriesProof(index) || proof?.validationVersion !== FULL_VALIDATION_VERSION || proof?.all !== true || !Array.isArray(index.evicted)
      || index.evicted.some(key => typeof key !== 'string') || index.evicted.includes(key)
      || (Object.hasOwn(index.entries, key) && rows.length === 0))) return null;
    if (!proof || !Number.isFinite(proof.completeThroughMtimeMs)
      || (!full && (!Array.isArray(proof.keys) || proof.keys.length > MAX_KEYS || !proof.keys.includes(key)))
      || !Array.isArray(proof.files) || !proof.files.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs))
      || !Array.isArray(proof.poisons)
      || JSON.stringify(proof.poisons) !== JSON.stringify(poisonNames(path))) return null;
    const seen = new Map(proof.files.map(row => [row.id, JSON.stringify(row)]));
    const indexed = new Map(rows.map(row => [row.id, row.mtimeMs]));
    let unknownReads = 0;
    for (const row of listing(runsDir, list, stat)) {
      if (indexed.get(row.id) === row.mtimeMs && seen.get(row.id) === JSON.stringify(row)) continue;
      if (seen.get(row.id) === JSON.stringify(row) && row.mtimeMs <= proof.completeThroughMtimeMs) continue;
      // Negative proofs remain stat-only: every unindexed change needs a full pass.
      if (full || unknownReads++ >= 20) return null;
      if (recordKey(read(row.id), row.id) === key) return null;
      if (JSON.stringify(row) !== JSON.stringify(listing(runsDir, () => [row.id], stat)[0])) return null;
    }
    if (JSON.stringify(proof.poisons) !== JSON.stringify(poisonNames(path))) return null;
    return rows.map(row => row.id);
  } catch { return null; }
}

/** Positive hints preserve the original empty-array fallback contract. */
export function readReviewRunIndex(runsDir, repo, pr, options) {
  return readIndexedRuns(runsDir, repo, pr, false, options) ?? [];
}
/** A negative proof needs a full-store watermark; null means use the bounded scan. */
export function readCompleteReviewRunsForPr(runsDir, repo, pr, options) {
  return readIndexedRuns(runsDir, repo, pr, true, options);
}

function add(index, key, row) {
  if (!reviewId(row.id) || !Number.isFinite(row.mtimeMs)) throw Error('invalid review index metadata');
  // Empty is a persistent overflow sentinel: never silently drop a possibly newer review.
  if (Object.hasOwn(index, key) && index[key].length === 0) return;
  const entries = (index[key] ?? []).filter(entry => entry.id !== row.id).concat(row);
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  index[key] = entries.length > MAX_IDS ? [] : entries;
  if (Object.keys(index).length > MAX_KEYS) {
    const oldest = Object.keys(index).sort((a, b) => (index[a][0]?.mtimeMs ?? -Infinity) - (index[b][0]?.mtimeMs ?? -Infinity))[0];
    delete index[oldest];
    return oldest;
  }
}
/** One shared backfill budget for the existing drain tick, never one batch per PR/repo. */
export function backfillOpenReviewRuns(context, { runsDir, localSlug, ...options } = {}) {
  if (!context?.contextComplete || !(context.prsByRepo instanceof Map)) return { complete: false, parsed: 0 };
  const openPrs = new Set();
  for (const [repo, prs] of context.prsByRepo) for (const pr of prs) {
    const key = keyOf(repo || localSlug, pr.number);
    if (key) openPrs.add(key);
  }
  return backfillReviewRunIndex({ ...options, runsDir, openPrs });
}
/** Every review-pr record write, including initial/pending/resumed writes, updates discovery.
 * Lock contention and IO failures are soft; the run itself has already been persisted.
 */
export function appendReviewRunIndex(record, runsDir, mtimeMs) {
  const key = keyOf(record.input?.repo, record.input?.pr);
  if (!key || record.op !== 'review-pr' || !reviewId(record.id)) return false;
  const path = reviewRunIndexPath(runsDir);
  try {
    mtimeMs ??= statSync(join(runsDir, `${record.id}.json`)).mtimeMs;
    return withFileLock(`${path}.lock`, () => {
      let index;
      try { index = load(path); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        index = { version: 2, entries: {} };
      }
      if (add(index.entries, key, { id: record.id, mtimeMs })) {
        // Eviction can discard a newer rejection while a later append recreates
        // the key with only an older acceptance. Only backfill restores completeness.
        delete index.completeness;
      }
      if (index.fullReviewRuns) {
        const full = index.fullReviewRuns;
        if (!validEntries(full.entries) || !Array.isArray(full.evicted)) throw Error('invalid full review index');
        const evicted = add(full.entries, key, { id: record.id, mtimeMs });
        if (evicted && !full.evicted.includes(evicted)) full.evicted.push(evicted);
      }
      writeBounded(path, index);
      return true;
    }, { timeoutMs: 0 });
  } catch { poison(path); return false; }
}
// Both backfills retain only payloads verified against the current file identity.
// A bad unchanged file cools down while other candidates continue making progress.
function stageReviewRuns(state, { path, runsDir, files, read, stat, now, warn, maxParses }) {
  if (state?.version !== 3 || state.validationVersion !== FULL_VALIDATION_VERSION || !Array.isArray(state.verified) || !state.blocked
    || typeof state.blocked !== 'object' || Array.isArray(state.blocked) || !Array.isArray(state.poisons)
    || new Set(state.verified.map(row => row?.id)).size !== state.verified.length
    || !state.verified.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs)
      && Array.isArray(row.identity) && row.identity.length === 5 && keyOf(...String(row.key).split('#')))) {
    state = { version: 3, validationVersion: FULL_VALIDATION_VERSION, verified: [], blocked: {}, poisons: poisonNames(path) };
  }
  const snapshots = new Map(files.map(row => [row.id, JSON.stringify(row)]));
  state.verified = state.verified.filter(({ key, ...row }) => snapshots.get(row.id) === JSON.stringify(row));
  for (const [id, blocked] of Object.entries(state.blocked)) {
    if (snapshots.get(id) !== blocked.snapshot) delete state.blocked[id];
  }
  const verified = new Set(state.verified.map(row => row.id));
  const batch = files.filter(row => !verified.has(row.id)
    && !(state.blocked[row.id]?.retryAt > now())).slice(0, maxParses);
  let parsed = 0;
  for (const row of batch) {
    try {
      parsed++;
      const key = recordKey(read(row.id), row.id);
      if (JSON.stringify(row) !== JSON.stringify(listing(runsDir, () => [row.id], stat)[0])) throw Error('review record changed during read');
      state.verified.push({ ...row, key });
      delete state.blocked[row.id];
    } catch (error) {
      state.blocked[row.id] = { snapshot: JSON.stringify(row), retryAt: now() + 60_000 };
      warn(`review run index backfill blocked at ${row.id}: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
      return { state, complete: false, parsed };
    }
  }
  return { state, parsed, complete: state.verified.length === files.length && Object.keys(state.blocked).length === 0 };
}

/** Caller supplies the live open set: qualified repo#PR keys, or numbers with `repo`.
 * Cursor and staging survive daemon restarts. No partial pass is published. Unreadable
 * candidate records abort the batch, leaving the normal fail-closed scan in charge.
 */
export function backfillReviewRunIndex({ runsDir, repo, openPrs, maxParses = 50,
  list = listReviewIds,
  read = id => readRecord(runsDir, id),
  stat = id => statSync(join(runsDir, `${id}.json`)), now = Date.now,
  warn = message => console.warn(message) } = {}) {
  const path = reviewRunIndexPath(runsDir), statePath = `${path}.backfill`;
  // Count before entering payload IO so throws (including staging/persistence failures)
  // cannot refund reads to the drain tick's second backfill.
  let parsed = 0;
  const countedRead = id => { parsed++; return read(id); };
  try {
    if (!Number.isSafeInteger(maxParses) || maxParses < 1 || maxParses > 300) throw Error('invalid backfill budget');
    const keys = [...openPrs].map(pr => repo ? keyOf(repo, pr) : pr).filter(Boolean).sort();
    if (keys.length > MAX_KEYS) throw Error('open PR set oversized; inspect omitted runs manually');
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      let state;
      try { state = readJson(statePath); } catch { /* start a pass */ }
      const files = listing(runsDir, list, stat);
      if (Buffer.byteLength(JSON.stringify(files)) > MAX_BYTES) throw Error('review index snapshot oversized; inspect omitted runs manually');
      const staged = stageReviewRuns(state, { path, runsDir, files, read: countedRead, stat, now, warn, maxParses });
      state = staged.state;
      const { complete } = staged;
      if (complete) {
        if (JSON.stringify(files) !== JSON.stringify(listing(runsDir, list, stat))) {
          writeBounded(statePath, state);
          throw Error('review listing changed during backfill');
        }
        // Replace, rather than merge, every rebuilt key. Only this complete pass clears poison.
        const entries = {};
        const wanted = new Set(keys);
        for (const { id, mtimeMs, key } of state.verified) if (wanted.has(key)) add(entries, key, { id, mtimeMs });
        for (const key of keys) entries[key] ??= [];
        const completeThroughMtimeMs = files.reduce((max, row) => Math.max(max, row.mtimeMs), 0);
        let previous;
        try { previous = load(path); } catch { /* hints can be rebuilt */ }
        writeBounded(path, { version: 2, entries,
          ...(previous?.fullReviewRuns ? { fullReviewRuns: previous.fullReviewRuns } : {}),
          completeness: { keys, files, completeThroughMtimeMs, poisons: state.poisons } });
        state = {};
      }
      writeBounded(statePath, state);
      return { complete, parsed };
    }, { timeoutMs: 0 });
  } catch (error) {
    warn(`review run index backfill unavailable: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
    return { complete: false, parsed };
  }
}

/** Full-store backfill, with its verified staging state in the index itself. Payload work is bounded
 * per tick; listings are stat-only. Open-PR hint refreshes preserve this plane.
 */
export function backfillAllReviewRuns({ runsDir, maxParsesPerCall = 50,
  list = listReviewIds, stat = id => statSync(join(runsDir, `${id}.json`)),
  read = id => {
    const parsed = parseRunRecord(readFileSync(join(runsDir, `${id}.json`), 'utf8'));
    if (!parsed.ok) throw Error(parsed.reason);
    return parsed.record;
  }, now = Date.now, warn = message => console.warn(message) } = {}) {
  const path = reviewRunIndexPath(runsDir);
  let parsed = 0;
  const countedRead = id => { parsed++; return read(id); };
  try {
    if (!Number.isSafeInteger(maxParsesPerCall) || maxParsesPerCall < 1 || maxParsesPerCall > 300) throw Error('invalid backfill budget');
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      let index;
      try { index = load(path); } catch { index = { version: 2, entries: {} }; }
      const files = listing(runsDir, list, stat), poisons = poisonNames(path);
      const full = index.fullReviewRuns;
      if (validEntries(full?.entries) && hasFullEntriesProof(full) && Array.isArray(full.evicted) && full.completeness?.all === true
        && full.completeness.validationVersion === FULL_VALIDATION_VERSION
        && Number.isFinite(full.completeness.completeThroughMtimeMs)
        && JSON.stringify(full.completeness.files) === JSON.stringify(files)
        && JSON.stringify(full.completeness.poisons) === JSON.stringify(poisons)) return { complete: true, parsed };
      const staged = stageReviewRuns(full?.backfill, {
        path, runsDir, files, read: countedRead, stat, now, warn, maxParses: maxParsesPerCall,
      });
      const { state, complete } = staged;
      // Keep the cursor as diagnostic metadata; verified identities drive resumption.
      state.after = state.verified.at(-1)?.id ?? '';
      if (complete) {
        if (JSON.stringify(files) !== JSON.stringify(listing(runsDir, list, stat))) {
          index.fullReviewRuns = { entries: full?.entries ?? {}, evicted: full?.evicted ?? [], backfill: state };
          writeBounded(path, index);
          throw Error('review listing changed during backfill');
        }
        const entries = {}, evicted = [];
        for (const { key, id, mtimeMs } of state.verified) {
          const lost = add(entries, key, { id, mtimeMs });
          if (lost && !evicted.includes(lost)) evicted.push(lost);
        }
        index.fullReviewRuns = { entries, evicted,
          completeness: { validationVersion: FULL_VALIDATION_VERSION, all: true, files, poisons: state.poisons,
            entriesDigest: fullEntriesDigest({ entries, evicted }),
            completeThroughMtimeMs: files.reduce((max, row) => Math.max(max, row.mtimeMs), 0) } };
      } else {
        index.fullReviewRuns = { entries: full?.entries ?? {}, evicted: full?.evicted ?? [], backfill: state };
      }
      writeBounded(path, index);
      return { complete, parsed };
    }, { timeoutMs: 0 });
  } catch (error) {
    warn(`full review run index backfill unavailable: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
    return { complete: false, parsed };
  }
}
