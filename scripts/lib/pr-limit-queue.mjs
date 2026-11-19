/** Durable, bounded FIFO for already-admitted PRs. Missing file = empty; corrupt state fails closed. */
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { countOpenPrsForRepo, decideOpenPr, isBranchAllowedLive, isGlobalOffLive } from './pr-limit.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { runGhSync } from './gh-throttle.mjs';

export const MAX_QUEUE_ENTRIES = 1000;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const fallback = 'inspect the queue file and drain or dequeue old entries, then retry open-pr';
export function resolveQueuePath(env = process.env, home = homedir()) {
  return env.WE_PR_LIMIT_QUEUE_FILE?.trim() || join(home, '.claude', 'conveyor', 'pr-limit-queue.json');
}

function validate(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_QUEUE_ENTRIES || entries.some(e =>
    !e || !/^[\w.-]+\/[\w.-]+$/.test(e.repoSlug) || !/^lane\/\S+$/.test(e.ref)
    || !/^[a-f0-9]{40}$/i.test(e.sha) || !e.base || typeof e.base !== 'string'
    || typeof e.title !== 'string' || !e.title.trim() || typeof e.body !== 'string' || !e.body.trim()
    || e.draft !== false || !Number.isFinite(Date.parse(e.queuedAt))
    || ((e.parkLabel ?? e.label) != null && typeof (e.parkLabel ?? e.label) !== 'string'))) {
    throw new Error(`invalid/oversized pr-limit queue; ${fallback}`);
  }
  if (Buffer.byteLength(JSON.stringify(entries)) > MAX_QUEUE_BYTES) throw new Error(`oversized pr-limit queue; ${fallback}`);
  return entries;
}

/** Pure upsert: latest payload replaces the ref while preserving its place in line. */
export function enqueueEntry(entries, entry, now = new Date().toISOString()) {
  const old = entries.find(e => e.repoSlug === entry.repoSlug && e.ref === entry.ref);
  const next = { ...entry, draft: false, queuedAt: old?.queuedAt || now };
  return validate([...entries.filter(e => e !== old), next].sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt)));
}

export function readQueue(path = resolveQueuePath()) {
  try {
    if (statSync(path).size > MAX_QUEUE_BYTES) throw new Error(`oversized pr-limit queue; ${fallback}`);
    return validate(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

function locked(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, fn, { timeoutMs: 1000 });
}
function writeQueue(path, entries) { writeJsonAtomic(path, validate(entries)); }
export function enqueue(entry, { path = resolveQueuePath(), now } = {}) {
  return locked(path, () => { const next = enqueueEntry(readQueue(path), entry, now); writeQueue(path, next); return next; });
}
export function dequeue({ repoSlug, ref, sha }, { path = resolveQueuePath() } = {}) {
  return locked(path, () => {
    const next = readQueue(path).filter(e => !(e.repoSlug === repoSlug && e.ref === ref && (!sha || e.sha === sha)));
    writeQueue(path, next); return next;
  });
}

const gh = args => runGhSync(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }).trim();
function remoteHead(entry) {
  try {
    const data = JSON.parse(gh(['api', `repos/${entry.repoSlug}/git/ref/heads/${entry.ref}`]));
    if (!/^[a-f0-9]{40}$/i.test(data?.object?.sha)) throw new Error('remote ref evidence incomplete');
    return data.object.sha;
  } catch (e) { if (/HTTP 404/.test(String(e.stderr || e.message))) return null; throw e; }
}
function existingPr(entry) {
  const prs = JSON.parse(gh(['pr', 'list', '--repo', entry.repoSlug, '--head', entry.ref, '--state', 'all', '--limit', '1000', '--json', 'number,headRefOid']));
  if (!Array.isArray(prs) || prs.length >= 1000 || prs.some(p => !p.number || !p.headRefOid)) throw new Error('PR lookup incomplete');
  return prs.some(p => p.headRefOid === entry.sha);
}
function createQueuedPr(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-limit-body-'));
  const bodyFile = join(dir, 'body.md');
  try {
    writeFileSync(bodyFile, entry.body);
    // Passing the label at create also avoids an opened-but-unlabelled queue head on a label API failure.
    return gh(['pr', 'create', '--repo', entry.repoSlug, '--head', entry.ref, '--base', entry.base,
      '--title', entry.title, '--body-file', bodyFile, ...((entry.parkLabel || entry.label) ? ['--label', entry.parkLabel || entry.label] : [])]);
  } finally { unlinkSync(bodyFile); rmdirSync(dir); }
}

/** All IO ports are synchronous, like pr-land/reconcile. Lock covers create to serialize competing drains.
 * At most ten entries per invocation; unknown count/head/PR evidence retains the entry for a later tick. */
export function drainPrLimitQueue({ repoKey, open = countOpenPrsForRepo, create = createQueuedPr,
  head = remoteHead, hasPr = existingPr, path = resolveQueuePath(), dryRun = false,
  env = process.env, branchAllowed = isBranchAllowedLive, globalOff = isGlobalOffLive } = {}) {
  if (dryRun) return { pending: readQueue(path), opened: [], dropped: [] };
  if (!readQueue(path).length) return { opened: [], dropped: [], errors: [] };
  return locked(path, () => {
    let entries = readQueue(path);
    const opened = [], dropped = [], errors = [], counts = new Map(), blocked = new Set();
    for (const entry of entries.filter(e => !repoKey || repoKeyForSlug(e.repoSlug) === repoKey).slice(0, 10)) {
      const key = repoKeyForSlug(entry.repoSlug);
      if (!key || blocked.has(key)) continue;
      try {
        if (!counts.has(key)) counts.set(key, open(key, { env, maxApiFetches: 3 }));
        const countsForRepo = counts.get(key);
        const decision = decideOpenPr({ repoKey: key, limit: countsForRepo.limit, openCount: countsForRepo.count,
          branch: entry.ref, branchAllowed: branchAllowed(entry.ref), globalOff: globalOff({ env }) });
        if (countsForRepo.count == null || !decision.allowed) continue;
        if (head(entry) !== entry.sha || hasPr(entry)) dropped.push(entry);
        else { create(entry); opened.push(entry); countsForRepo.count++; }
        entries = entries.filter(e => e !== entry);
        writeQueue(path, entries); // persist every completed effect, even if the next entry fails
      } catch (e) { blocked.add(key); errors.push({ ref: entry.ref, detail: String(e.message || e) }); }
    }
    return { opened, dropped, errors };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'drain') throw new Error('usage: pr-limit-queue.mjs drain [--dry-run]');
    console.log(JSON.stringify(drainPrLimitQueue({ dryRun: process.argv.includes('--dry-run') })));
  } catch (e) { console.error(e.message); process.exitCode = 3; }
}
