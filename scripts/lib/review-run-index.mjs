/** Bounded discovery hint, never review evidence. Lives beside the shared runs folder.
 * Overflow/corruption/missing records fall back to the ordinary scan and its HOLD.
 * Backfill stages a complete pass over review ids, at most 50 payloads per drain tick.
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  if (!validEntries(index)) throw Error('invalid review index');
  return index;
}
function writeBounded(path, value) {
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > MAX_BYTES) throw Error('review index oversized; inspect omitted runs manually');
  writeJsonAtomic(path, value);
}
export function readReviewRunIndex(runsDir, repo, pr) {
  try { return (load(reviewRunIndexPath(runsDir))[keyOf(repo, pr)] ?? []).map(row => row.id); }
  catch { return []; }
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
    delete index[oldest]; // evicted keys use the original bounded scan
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
      let index; try { index = load(path); } catch { index = {}; }
      add(index, key, { id: record.id, mtimeMs });
      writeBounded(path, index);
      return true;
    }, { timeoutMs: 0 });
  } catch { return false; }
}
/** Caller supplies the live open set: qualified repo#PR keys, or numbers with `repo`.
 * Cursor and staging survive daemon restarts. No partial pass is published. Unreadable
 * candidate records abort the batch, leaving the normal fail-closed scan in charge.
 */
export function backfillReviewRunIndex({ runsDir, repo, openPrs, maxParses = 50,
  list = dir => readdirSync(dir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)),
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
      if (state?.signature !== signature || !validEntries(state.entries) || typeof state.after !== 'string') state = { signature, after: '', entries: {} };
      const ids = list(runsDir).filter(reviewId).filter(id => id > state.after).sort();
      const batch = ids.slice(0, maxParses);
      for (const id of batch) {
        const record = read(id), key = keyOf(record?.input?.repo, record?.input?.pr);
        if (record?.id === id && record.op === 'review-pr' && wanted.has(key)) add(state.entries, key, { id, mtimeMs: stat(id).mtimeMs });
        state.after = id;
      }
      const complete = batch.length === ids.length;
      if (complete) {
        let index; try { index = load(path); } catch { index = {}; }
        for (const [key, entries] of Object.entries(state.entries)) {
          if (entries.length === 0) index[key] = [];
          else for (const row of entries) add(index, key, row);
        }
        writeBounded(path, index);
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
