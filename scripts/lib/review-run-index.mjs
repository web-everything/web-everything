/** Bounded discovery hint, never review evidence. Lives beside the shared runs folder.
 * Overflow/corruption/missing records fall back to the ordinary scan and its HOLD.
 * Backfill stages a complete pass over review ids, at most 50 payloads per drain tick.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
function readJson(path, maxBytes = MAX_BYTES) {
  if (statSync(path).size > maxBytes) throw Error('review index oversized');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function validEntries(index) {
  return index && typeof index === 'object' && !Array.isArray(index) && Object.keys(index).length <= MAX_KEYS
    && Object.entries(index).every(([key, entries]) => key.length <= 256 && Array.isArray(entries) && entries.length <= MAX_IDS
      && entries.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs)));
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
function readIndexedRuns(runsDir, repo, pr, full, {
  list = listReviewIds, stat = id => statSync(join(runsDir, `${id}.json`)),
} = {}) {
  try {
    const path = reviewRunIndexPath(runsDir), loaded = load(path), index = full ? loaded.fullReviewRuns : loaded, proof = index?.completeness;
    const key = keyOf(repo, pr);
    if (!key || !validEntries(index?.entries)) return null;
    const rows = index.entries[key] ?? [];
    if (full && (proof?.validationVersion !== FULL_VALIDATION_VERSION || proof?.all !== true || !Array.isArray(index.evicted)
      || index.evicted.some(key => typeof key !== 'string') || index.evicted.includes(key)
      || (Object.hasOwn(index.entries, key) && rows.length === 0))) return null;
    if (!proof || !Number.isFinite(proof.completeThroughMtimeMs)
      || (!full && (!Array.isArray(proof.keys) || proof.keys.length > MAX_KEYS || !proof.keys.includes(key)))
      || !Array.isArray(proof.files) || !proof.files.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs))
      || !Array.isArray(proof.poisons)
      || JSON.stringify(proof.poisons) !== JSON.stringify(poisonNames(path))) return null;
    const seen = new Map(proof.files.map(row => [row.id, JSON.stringify(row)]));
    const indexed = new Map(rows.map(row => [row.id, row.mtimeMs]));
    for (const row of listing(runsDir, list, stat)) {
      if (indexed.get(row.id) === row.mtimeMs) continue;
      // Also reject absent ids with old/coarse mtimes: a failed poison write cannot hide them.
      if (seen.get(row.id) !== JSON.stringify(row) || row.mtimeMs > proof.completeThroughMtimeMs) return null;
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
/** Caller supplies the live open set: qualified repo#PR keys, or numbers with `repo`.
 * Cursor and staging survive daemon restarts. No partial pass is published. Unreadable
 * candidate records abort the batch, leaving the normal fail-closed scan in charge.
 */
export function backfillReviewRunIndex({ runsDir, repo, openPrs, maxParses = 50,
  list = listReviewIds,
  read = id => {
    const parsed = parseRunRecord(readFileSync(join(runsDir, `${id}.json`), 'utf8'));
    if (!parsed.ok) throw Error(parsed.reason);
    return parsed.record;
  }, stat = id => statSync(join(runsDir, `${id}.json`)), warn = message => console.warn(message) } = {}) {
  const path = reviewRunIndexPath(runsDir), statePath = `${path}.backfill`;
  try {
    if (!Number.isSafeInteger(maxParses) || maxParses < 1 || maxParses > 300) throw Error('invalid backfill budget');
    const keys = [...openPrs].map(pr => repo ? keyOf(repo, pr) : pr).filter(Boolean).sort();
    if (keys.length > MAX_KEYS) throw Error('open PR set oversized; inspect omitted runs manually');
    const signature = JSON.stringify(keys), wanted = new Set(keys);
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      let state;
      try { state = readJson(statePath); } catch { /* start a pass */ }
      const files = listing(runsDir, list, stat);
      if (state?.signature !== signature || !validEntries(state.entries) || typeof state.after !== 'string'
        || JSON.stringify(state.files) !== JSON.stringify(files)) {
        state = { signature, after: '', entries: {}, files, poisons: poisonNames(path) };
      }
      const ids = files.map(row => row.id).filter(id => id > state.after);
      const batch = ids.slice(0, maxParses);
      for (const id of batch) {
        const record = read(id), key = keyOf(record?.input?.repo, record?.input?.pr);
        if (record?.id !== id || record.op !== 'review-pr' || !key) throw Error('unverified backfill record');
        if (wanted.has(key)) add(state.entries, key, { id, mtimeMs: stat(id).mtimeMs });
        state.after = id;
      }
      const complete = batch.length === ids.length;
      if (complete) {
        if (JSON.stringify(files) !== JSON.stringify(listing(runsDir, list, stat))) throw Error('review listing changed during backfill');
        // Replace, rather than merge, every rebuilt key. Only this complete pass clears poison.
        const entries = Object.fromEntries(keys.map(key => [key, state.entries[key] ?? []]));
        const completeThroughMtimeMs = files.reduce((max, row) => Math.max(max, row.mtimeMs), 0);
        let previous;
        try { previous = load(path); } catch { /* hints can be rebuilt */ }
        writeBounded(path, { version: 2, entries,
          ...(previous?.fullReviewRuns ? { fullReviewRuns: previous.fullReviewRuns } : {}),
          completeness: { keys, files, completeThroughMtimeMs, poisons: state.poisons } });
        state = { signature, after: '', entries: {} };
      }
      writeBounded(statePath, state);
      return { complete, parsed: batch.length };
    }, { timeoutMs: 0 });
  } catch (error) {
    warn(`review run index backfill unavailable: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
    return { complete: false, parsed: 0 };
  }
}

/** Full-store backfill, with its cursor in the index itself. Payload work is bounded
 * per tick; listings are stat-only. Open-PR hint refreshes preserve this plane.
 */
export function backfillAllReviewRuns({ runsDir, maxParsesPerCall = 50,
  list = listReviewIds, stat = id => statSync(join(runsDir, `${id}.json`)),
  read = id => {
    const parsed = parseRunRecord(readFileSync(join(runsDir, `${id}.json`), 'utf8'));
    if (!parsed.ok) throw Error(parsed.reason);
    return parsed.record;
  }, warn = message => console.warn(message) } = {}) {
  const path = reviewRunIndexPath(runsDir);
  try {
    if (!Number.isSafeInteger(maxParsesPerCall) || maxParsesPerCall < 1 || maxParsesPerCall > 300) throw Error('invalid backfill budget');
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      let index;
      try { index = load(path); } catch { index = { version: 2, entries: {} }; }
      const files = listing(runsDir, list, stat), poisons = poisonNames(path);
      const full = index.fullReviewRuns;
      if (validEntries(full?.entries) && Array.isArray(full.evicted) && full.completeness?.all === true
        && full.completeness.validationVersion === FULL_VALIDATION_VERSION
        && Number.isFinite(full.completeness.completeThroughMtimeMs)
        && JSON.stringify(full.completeness.files) === JSON.stringify(files)
        && JSON.stringify(full.completeness.poisons) === JSON.stringify(poisons)) return { complete: true, parsed: 0 };
      let state = full?.backfill;
      // A replacement or a new id behind the cursor restarts the snapshot, never
      // publishing a watermark over a file we have not parsed.
      if (state?.validationVersion !== FULL_VALIDATION_VERSION || !validEntries(state?.entries) || !Array.isArray(state.evicted)
        || state.evicted.some(key => typeof key !== 'string') || typeof state.after !== 'string'
        || JSON.stringify(state.files) !== JSON.stringify(files)) {
        state = { validationVersion: FULL_VALIDATION_VERSION, after: '', entries: {}, evicted: [], files, poisons };
      }
      const ids = files.filter(row => row.id > state.after);
      const batch = ids.slice(0, maxParsesPerCall);
      for (const row of batch) {
        const record = read(row.id);
        assertReviewRunEvidence(record);
        const key = keyOf(record.input?.repo, record.input?.pr);
        if (record?.id !== row.id || record.op !== 'review-pr' || !key) throw Error('unverified backfill record');
        const evicted = add(state.entries, key, { id: row.id, mtimeMs: row.mtimeMs });
        if (evicted && !state.evicted.includes(evicted)) state.evicted.push(evicted);
        state.after = row.id;
      }
      const complete = batch.length === ids.length;
      if (complete) {
        if (JSON.stringify(files) !== JSON.stringify(listing(runsDir, list, stat))) throw Error('review listing changed during backfill');
        index.fullReviewRuns = { entries: state.entries, evicted: state.evicted,
          completeness: { validationVersion: FULL_VALIDATION_VERSION, all: true, files, poisons: state.poisons,
            completeThroughMtimeMs: files.reduce((max, row) => Math.max(max, row.mtimeMs), 0) } };
      } else {
        index.fullReviewRuns = { entries: full?.entries ?? {}, evicted: full?.evicted ?? [], backfill: state };
      }
      writeBounded(path, index);
      return { complete, parsed: batch.length };
    }, { timeoutMs: 0 });
  } catch (error) {
    warn(`full review run index backfill unavailable: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
    return { complete: false, parsed: 0 };
  }
}
