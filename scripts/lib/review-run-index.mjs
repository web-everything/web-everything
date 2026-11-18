/** Bounded discovery hint, never review evidence. Lives beside the shared runs folder.
 * Overflow/corruption/missing records fall back to the ordinary scan and its HOLD.
 * Backfill stages a complete pass over review ids, at most 50 payloads per drain tick.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isValidRunId, parseRunRecord } from '../operations/run-record.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';

const MAX_KEYS = 512, MAX_IDS = 32, MAX_BYTES = 1024 * 1024;
const reviewId = id => isValidRunId(id) && id.startsWith('review-pr-');
const keyOf = (repo, pr) => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)
  && Number.isSafeInteger(Number(pr)) && Number(pr) > 0 ? `${repo}#${Number(pr)}` : null;
export const reviewRunIndexPath = runsDir => join(dirname(runsDir), `${basename(runsDir)}-review-index.json`);
function readJson(path) {
  if (statSync(path).size > MAX_BYTES) throw Error('review index oversized');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function validEntries(index) {
  return index && typeof index === 'object' && !Array.isArray(index) && Object.keys(index).length <= MAX_KEYS
    && Object.entries(index).every(([key, entries]) => key.length <= 256 && Array.isArray(entries) && entries.length <= MAX_IDS
      && entries.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs)));
}
function load(path) {
  const index = readJson(path);
  if (index?.version === 2 && validEntries(index.entries)) return index;
  if (validEntries(index)) return { version: 2, entries: index }; // legacy hints have no completeness proof
  throw Error('invalid review index');
}
function writeBounded(path, value) {
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > MAX_BYTES) throw Error('review index oversized; inspect omitted runs manually');
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
  const key = keyOf(record?.input?.repo, record?.input?.pr);
  if (record?.id !== id || record.op !== 'review-pr' || !key) throw Error('unverified backfill record');
  return key;
}
export function readReviewRunIndex(runsDir, repo, pr, {
  list = listReviewIds, stat = id => statSync(join(runsDir, `${id}.json`)),
  read = id => readRecord(runsDir, id),
} = {}) {
  try {
    const path = reviewRunIndexPath(runsDir), index = load(path), proof = index.completeness;
    const key = keyOf(repo, pr), rows = index.entries[key] ?? [];
    if (!proof || !Number.isFinite(proof.completeThroughMtimeMs)
      || !Array.isArray(proof.keys) || proof.keys.length > MAX_KEYS || !proof.keys.includes(key)
      || !Array.isArray(proof.files) || !proof.files.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs))
      || !Array.isArray(proof.poisons)
      || JSON.stringify(proof.poisons) !== JSON.stringify(poisonNames(path))) return [];
    const seen = new Map(proof.files.map(row => [row.id, JSON.stringify(row)]));
    const indexed = new Map(rows.map(row => [row.id, row.mtimeMs]));
    let unknownReads = 0;
    for (const row of listing(runsDir, list, stat)) {
      if (indexed.get(row.id) === row.mtimeMs) continue;
      if (seen.get(row.id) === JSON.stringify(row) && row.mtimeMs <= proof.completeThroughMtimeMs) continue;
      // Unknown includes replacements at the same mtime. Never infer ownership from
      // a stale key. The caller shares these reads with its bounded fallback scan.
      if (unknownReads++ >= 20) return [];
      if (recordKey(read(row.id), row.id) === key) return [];
      if (JSON.stringify(row) !== JSON.stringify(listing(runsDir, () => [row.id], stat)[0])) return [];
    }
    if (JSON.stringify(proof.poisons) !== JSON.stringify(poisonNames(path))) return [];
    return rows.map(row => row.id);
  } catch { return []; }
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
    return true;
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
  read = id => readRecord(runsDir, id),
  stat = id => statSync(join(runsDir, `${id}.json`)), now = Date.now,
  warn = message => console.warn(message) } = {}) {
  const path = reviewRunIndexPath(runsDir), statePath = `${path}.backfill`;
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
      if (state?.version !== 3 || !Array.isArray(state.verified) || !state.blocked
        || typeof state.blocked !== 'object' || Array.isArray(state.blocked) || !Array.isArray(state.poisons)
        || new Set(state.verified.map(row => row?.id)).size !== state.verified.length
        || !state.verified.every(row => reviewId(row?.id) && Number.isFinite(row.mtimeMs)
          && Array.isArray(row.identity) && row.identity.length === 5 && keyOf(...String(row.key).split('#')))) {
        state = { version: 3, verified: [], blocked: {}, poisons: poisonNames(path) };
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
          writeBounded(statePath, state);
          warn(`review run index backfill blocked at ${row.id}: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
          return { complete: false, parsed };
        }
      }
      const complete = state.verified.length === files.length && Object.keys(state.blocked).length === 0;
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
        writeBounded(path, { version: 2, entries,
          completeness: { keys, files, completeThroughMtimeMs, poisons: state.poisons } });
        state = {};
      }
      writeBounded(statePath, state);
      return { complete, parsed };
    }, { timeoutMs: 0 });
  } catch (error) {
    warn(`review run index backfill unavailable: ${error.message}; bounded scan still applies; HOLD on scan-capped and inspect omitted runs`);
    return { complete: false, parsed: 0 };
  }
}
