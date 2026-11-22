#!/usr/bin/env node
/** Read-only forge evidence collector. Shadow records never participate in merge admission. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { buildChangeEvidence } from './record.mjs';
import { execFileSyncThrottled } from '../gh-throttle.mjs';
import { defaultListPrComments } from '../../conveyor/pr-comments-list.mjs';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { cascadePolicy } from '../policy-cascade.mjs';
import { readSettings } from '../settings-files.mjs';
import { withLedgerAppendLock } from '../ledger-append-lock.mjs';

const DEFAULT_REPO = 'web-everything/web-everything';
const POLICY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/merge-policy.json');
const RECORDER = 'https://github.com/web-everything/web-everything/blob/main/scripts/lib/change-evidence/writer.mjs';
const FIELDS = 'number,url,title,author,baseRefName,headRefName,headRefOid,mergedAt,mergedBy,mergeCommit,commits';
const clean = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const defaultGh = argv => JSON.parse(execFileSyncThrottled('gh', argv, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}));

export function resolveChangeEvidenceMode({ tool = readSettings().changeEvidence, platform, env = process.env, log } = {}) {
  return cascadePolicy('changeEvidence', tool, { standard: { mode: 'shadow' }, platform, env, log,
    envValues: { mode: env.WE_CHANGE_EVIDENCE_MODE }, valid: { mode: v => ['off', 'shadow', 'on'].includes(v) } });
}
function atomic(io, file, bytes) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { io.writeFileSync(tmp, bytes); io.renameSync(tmp, file); }
  finally { if (io.existsSync(tmp)) io.unlinkSync(tmp); }
}
function optional(io, file, fallback) {
  try { return io.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function identity(item, repo) {
  const slug = item.repo || repo, num = Number(item.num ?? item.number);
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isSafeInteger(num) || num < 1) throw Error('invalid merge identity');
  return { repo: slug, num };
}
const key = item => `${item.repo}#${item.num}`;

/** One shared call budget includes pagination, pending retries and all merges in the pass. */
function reader(gh, maxCalls, maxPages) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1) throw Error('invalid read bounds');
  let calls = 0;
  const read = argv => {
    if (++calls > maxCalls) throw Error('read budget exhausted; operator: retry backfill for this date');
    return gh(argv);
  };
  const pages = (endpoint, field) => {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const value = read(['api', `${endpoint}?per_page=100&page=${page}`]);
      const rows = field ? value?.[field] : value;
      if (!Array.isArray(rows) || rows.length > 100) throw Error('incomplete forge page');
      all.push(...rows);
      if (rows.length < 100) {
        if (field && (!Number.isSafeInteger(value.total_count) || all.length !== value.total_count)) throw Error('incomplete check-runs count');
        return all;
      }
    }
    throw Error('page cap reached; operator: inspect full evidence and retry backfill with a larger maxPages');
  };
  return { read, pages };
}
function collect(item, reads, maxPages) {
  const { repo, num } = item, api = `repos/${repo}`;
  const pr = reads.read(['pr', 'view', String(num), '--repo', repo, '--json', FIELDS]);
  if (pr.number !== num || pr.url !== `https://github.com/${repo}/pull/${num}` || !pr.mergedAt || !pr.mergeCommit?.oid)
    throw Error('PR is not a verified merged change');
  const events = reads.pages(`${api}/issues/${num}/events`);
  const comments = defaultListPrComments({ number: num, repo, gh: reads.read, maxPages });
  const mergeCommit = reads.read(['api', `${api}/commits/${pr.mergeCommit.oid}`]);
  const commits = reads.pages(`${api}/pulls/${num}/commits`);
  if (!commits.length || commits.at(-1).sha !== pr.headRefOid) throw Error('incomplete PR commit history');
  const checkRuns = reads.pages(`${api}/commits/${pr.mergeCommit.oid}/check-runs`, 'check_runs');
  return { pr, events, comments, mergeCommit, commits, checkRuns };
}

/** Atomic record, then index, then pending retirement. Retry reconciles either crash window. */
function publish({ io, dir, record, retire }) {
  const name = `${record.predicate.change.number}-${record.subject[0].digest.gitCommit}.json`;
  const file = path.join(dir, name), index = path.join(dir, 'index.jsonl');
  const before = optional(io, index, '');
  const rows = before.trim() ? before.trim().split('\n').map(line => JSON.parse(line)) : [];
  const indexed = rows.some(row => row.file === name);
  const existed = io.existsSync(file);
  if (existed) {
    // Recollect first, then reconcile a crash only if the persisted statement agrees.
    // Recorder/time metadata may differ across retries; subject, policy and verdict may not.
    const saved = JSON.parse(io.readFileSync(file, 'utf8'));
    const normalize = value => JSON.parse(JSON.stringify(value, (k, v) =>
      ['recordedAt', 'recorder', 'evaluatedAt'].includes(k) ? undefined : v));
    const expected = structuredClone(record);
    if (!Number.isFinite(Date.parse(saved.predicate?.recordedAt))) throw Error('invalid existing record timestamp; operator must inspect record');
    expected.predicate.id = expected.predicate.id.replace(record.predicate.recordedAt.slice(0, 10), saved.predicate.recordedAt.slice(0, 10));
    if (!isDeepStrictEqual(normalize(saved), normalize(expected)))
      throw Error('existing record differs from verified subject, policy or verdict; operator must inspect record and retry backfill');
  }
  let appended = false;
  try {
    if (!existed) atomic(io, file, `${JSON.stringify(record, null, 2)}\n`);
    if (!indexed) {
      // Mark before the call: a failed append may have written a partial line.
      appended = true;
      io.appendFileSync(index, `${JSON.stringify({ file: name, pr: record.predicate.change.number,
        mergeSha: record.subject[0].digest.gitCommit, recordedAt: record.predicate.recordedAt })}\n`);
    }
    retire();
  } catch (error) {
    if (!existed && io.existsSync(file)) io.unlinkSync(file);
    if (appended) atomic(io, index, before);
    throw error;
  }
  return file;
}

export async function writeChangeEvidenceForMerged({ merged = [], queueFollowUps = [],
  repo = DEFAULT_REPO, coordination = resolveCoordinationRoot(), gh = defaultGh, io = fs,
  emit = appendDaemonEvent, mode, configBytes, now = () => new Date(), recorder = RECORDER,
  maxCalls = 256, maxPages = 10, reads: sharedReads,
} = {}) {
  if ((mode ?? resolveChangeEvidenceMode().value.mode) === 'off') return [];
  const failures = [], written = [];
  const missing = (item, error) => failures.push({ kind: 'change-evidence-missing', repo: item.repo, pr: item.num,
    daemon: 'merge-ai-prs', detail: { reason: clean(error.message), fallback: 'retry pending next pass or run --backfill --since=YYYY-MM-DD' } });
  try {
    // An immutable inbox entry survives lock contention and concurrent drain callers.
    // Never read/modify the shared pending ledger outside its lock.
    const inbox = path.join(coordination, 'change-evidence-incoming');
    const incoming = [...merged, ...queueFollowUps].map(item => ({ ...item, ...identity(item, repo) }));
    if (incoming.length) atomic(io, path.join(inbox, `${randomUUID()}.json`), JSON.stringify(incoming));
    withLedgerAppendLock(`change-evidence:${coordination}`, () => {
      const pendingFile = path.join(coordination, 'change-evidence-pending.json');
      let pending = JSON.parse(optional(io, pendingFile, '[]'));
      if (!Array.isArray(pending)) throw Error('invalid change-evidence pending ledger; operator must repair it');
      const batches = io.existsSync(inbox) ? io.readdirSync(inbox).filter(name => name.endsWith('.json')) : [];
      const queued = batches.flatMap(name => {
        const batch = JSON.parse(io.readFileSync(path.join(inbox, name), 'utf8'));
        if (!Array.isArray(batch)) throw Error('invalid incoming evidence batch; operator must repair it');
        return batch;
      });
      const candidates = new Map([...pending, ...queued].map(item => {
        const id = identity(item, repo); return [key(id), { ...item, ...id }];
      }));
      pending = [...candidates.values()];
      const save = () => atomic(io, pendingFile, `${JSON.stringify(pending, null, 2)}\n`);
      if (!pending.length) return;
      save();
      for (const name of batches) io.unlinkSync(path.join(inbox, name));
      const reads = sharedReads ?? reader(gh, maxCalls, maxPages);
      const bytes = configBytes ?? io.readFileSync(POLICY), config = JSON.parse(String(bytes));
      for (const item of candidates.values()) {
        try {
          const evidence = collect(item, reads, maxPages);
          const record = buildChangeEvidence({ ...evidence, config, configBytes: bytes, recordedAt: now().toISOString(), recorder });
          const dir = path.join(coordination, 'change-evidence', 'shadow', item.repo.replace('/', '__'));
          written.push(publish({ io, dir, record, retire: () => {
            const previous = pending;
            pending = pending.filter(p => key(p) !== key(item));
            try { save(); } catch (error) { pending = previous; throw error; }
          } }));
        } catch (error) { missing(item, error); }
      }
    }, { dir: coordination, waitMs: 0 });
  } catch (error) { missing({ repo }, error); }
  for (const event of failures) {
    try { await emit(event); } catch { /* stderr still makes an unavailable event sink visible */ }
    console.error(`change-evidence-missing: ${event.repo}#${event.pr ?? '?'}: ${event.detail.reason}; ${event.detail.fallback}`);
  }
  return written;
}

/**
 * Merges at or after `since`, read from closed PRs newest-update first (no search listing, #no-label-search).
 * A merge updates the PR, so updated_at >= merged_at: the first row updated before `since` ends the scan,
 * and the read is bounded by the window, not by the repository's history (red-team x1b8hlo).
 * Offset pages shift when a PR is touched mid-scan: the touched PR jumps to page 1, already read. `state=all`
 * keeps a reopened PR in the listing (it jumps too, instead of vanishing and shifting later rows up), and a
 * multi-page scan re-reads page 1 afterwards; any change rescans, and a listing that never settles fails closed.
 */
export const LISTING_SCANS = 3;
function mergedSince({ listing, repo, since, maxPages }) {
  const time = (value, field) => {
    const t = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(t)) throw Error(`incomplete merged listing: unreadable ${field}`);
    return t;
  };
  const page = n => {
    const rows = listing.read(['api', `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${n}`]);
    if (!Array.isArray(rows) || rows.length > 100) throw Error('incomplete merged listing page');
    return rows;
  };
  const signature = rows => JSON.stringify(rows.map(row => [row?.number, row?.updated_at, row?.merged_at]));
  const scan = () => {
    const found = new Map();
    let first;
    for (let n = 1; n <= maxPages; n++) {
      const rows = page(n);
      if (n === 1) first = signature(rows);
      let done = rows.length < 100;
      for (const row of rows) {
        if (!Number.isSafeInteger(row?.number) || row.number < 1) throw Error('incomplete merged listing: unreadable number');
        if (time(row.updated_at, 'updated_at') < since) { done = true; break; }
        if (row.merged_at !== null && time(row.merged_at, 'merged_at') >= since) found.set(row.number, { number: row.number });
      }
      if (done) return { prs: [...found.values()], first, pages: n };
    }
    throw Error(`merged listing exceeds ${maxPages} pages of PRs; operator: retry backfill with a later --since or a larger --max-pages`);
  };
  for (let attempt = 1; attempt <= LISTING_SCANS; attempt++) {
    const { prs, first, pages } = scan();
    // One page is one atomic read: nothing can shift. Otherwise page 1 must be unchanged after the scan.
    if (pages === 1 || signature(page(1)) === first) return prs;
  }
  throw Error(`merged listing kept changing during ${LISTING_SCANS} scans; operator: retry backfill with a later --since (a one-page window is read atomically)`);
}

export async function backfillChangeEvidence({ since, repo = DEFAULT_REPO, gh = defaultGh, maxCalls = 256, maxPages = 10, ...options } = {}) {
  // utc-day-slice-ok: validates the supplied UTC calendar date, not the operator's current day.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? '') || new Date(since).toISOString().slice(0, 10) !== since) throw Error('expected --since=YYYY-MM-DD');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || repo.split('/').some(part => /^\.+$/.test(part))) throw Error('expected --repo=owner/repo');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw Error('expected --max-pages=N (a positive integer)');
  if ((options.mode ?? resolveChangeEvidenceMode().value.mode) === 'off') return [];
  const listing = reader(gh, LISTING_SCANS * (maxPages + 1), maxPages);
  const prs = mergedSince({ listing, repo, since: Date.parse(`${since}T00:00:00Z`), maxPages });
  // Root cause of the first live backfill failing ~20 of 30: ONE 256-call budget shared by every merge (about 9 reads
  // each). The backfill budget scales with the number of merges, and per merge with --max-pages (collect reads up to
  // four paged endpoints), so raising --max-pages does not by itself exhaust the per-merge share (pending retries
  // from earlier passes share the same budget and stay pending on exhaustion). Backfill never emits to the
  // live daemon-events log (only the drain hook at merge time does); failures stay on stderr and in the pending ledger.
  const reads = reader(gh, Math.max(maxCalls, Math.max(64, 4 * maxPages + 8) * prs.length), maxPages);
  return writeChangeEvidenceForMerged({ ...options, emit: async () => {}, repo, gh, maxPages, reads,
    merged: prs.map(pr => ({ num: pr.number, repo })) });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args.find(arg => arg.startsWith(flag))?.slice(flag.length);
  if (!args.includes('--backfill') || args.some(arg => arg !== '--backfill' && !['--since=', '--repo=', '--max-pages='].some(f => arg.startsWith(f)))) {
    console.error('usage: writer.mjs --backfill --since=YYYY-MM-DD [--repo=owner/repo] [--max-pages=N]'); process.exitCode = 1;
  } else {
    try {
      const pages = value('--max-pages=');
      // Digits only: '', '0', '1e3' and '0x10' are refused by backfill's --max-pages check.
      await backfillChangeEvidence({ since: value('--since='), repo: value('--repo=') ?? DEFAULT_REPO,
        ...(pages === undefined ? {} : { maxPages: /^[1-9]\d*$/.test(pages) ? Number(pages) : NaN }) });
    } catch (error) { console.error(clean(error.message)); process.exitCode = 1; }
  }
}
