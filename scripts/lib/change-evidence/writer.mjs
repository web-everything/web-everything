#!/usr/bin/env node
/** Read-only forge evidence collector. Shadow records never participate in merge admission. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  try { io.writeFileSync(tmp, bytes, { flag: 'wx' }); io.renameSync(tmp, file); }
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
    withLedgerAppendLock(`change-evidence:${coordination}`, () => {
      const pendingFile = path.join(coordination, 'change-evidence-pending.json');
      let pending = JSON.parse(optional(io, pendingFile, '[]'));
      if (!Array.isArray(pending)) throw Error('invalid change-evidence pending ledger; operator must repair it');
      const candidates = new Map([...pending, ...merged, ...queueFollowUps].map(item => {
        const id = identity(item, repo); return [key(id), { ...item, ...id }];
      }));
      pending = [...candidates.values()];
      const save = () => atomic(io, pendingFile, `${JSON.stringify(pending, null, 2)}\n`);
      if (!pending.length) return;
      save();
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

export async function backfillChangeEvidence({ since, repo = DEFAULT_REPO, gh = defaultGh, maxCalls = 256, maxPages = 10, ...options } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? '') || new Date(since).toISOString().slice(0, 10) !== since) throw Error('expected --since=YYYY-MM-DD');
  if ((options.mode ?? resolveChangeEvidenceMode().value.mode) === 'off') return [];
  const listing = reader(gh, 1, maxPages);
  const prs = listing.read(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '1000', '--json', 'number']);
  if (!Array.isArray(prs) || prs.length >= 1000) throw Error('merged listing capped; operator must backfill a narrower window');
  // Root cause of the first live backfill failing ~20 of 30: ONE 256-call budget shared by every merge (about 9 reads
  // each). The backfill budget scales with the number of merges. Backfill never emits to the live daemon-events log
  // (only the drain hook at merge time does); failures stay on stderr and in the pending ledger.
  const reads = reader(gh, Math.max(maxCalls, 64 * prs.length), maxPages);
  return writeChangeEvidenceForMerged({ ...options, emit: async () => {}, repo, gh, maxPages, reads,
    merged: prs.map(pr => ({ num: pr.number, repo })) });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--backfill') || args.some(arg => arg !== '--backfill' && !arg.startsWith('--since=') && !arg.startsWith('--repo='))) {
    console.error('usage: writer.mjs --backfill --since=YYYY-MM-DD [--repo=owner/repo]'); process.exitCode = 1;
  } else {
    try {
      await backfillChangeEvidence({ since: args.find(arg => arg.startsWith('--since='))?.slice(8),
        repo: args.find(arg => arg.startsWith('--repo='))?.slice(7) ?? DEFAULT_REPO });
    } catch (error) { console.error(clean(error.message)); process.exitCode = 1; }
  }
}
