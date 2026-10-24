/** Read-only GitHub shell for PR digests; the only writes are local digest files, never GitHub mutations. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { validateReferralRecord, validateOperatorRuling, buildOperatorRulingComment } from '../lib/jury-core.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { defaultListPrComments } from '../conveyor/pr-comments-list.mjs';
import { notApplied } from './effect-executor.mjs';
import { cacheHeader, renderPrDigest, PR_DIGEST_EFFECT } from './pr-digest.mjs';

const REPO = 'web-everything/web-everything';
export const COMMENTS_MAX_BUFFER = 256 * 1024 * 1024;
export const HISTORY_LINE_MAX_BYTES = 1024 * 1024;
export const ALL_THREAD_PR_BUDGET = 100;
// Supported by conveyor/fix-loop-ledger.mjs; it has no exported outcome enum.
const LEDGER_OUTCOMES = ['pushed', 'no-change', 'failed'];
const hash = text => createHash('sha256').update(text).digest('hex');
const READ_OPTIONS = { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: COMMENTS_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] };

/** Keep the throttle around the env invocation (passing env to execFileSyncThrottled would bypass it). */
export function digestGh(args, options = {}) {
  return runGhSync(args, { ...READ_OPTIONS, ...options, throttle: {
    personalRoute: false,
    exec: (argv, opts) => execFileSync('env', ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', process.env.WE_OPERATOR_GH || 'gh', ...argv], opts),
  } });
}

function firstLine(path) {
  let file;
  try {
    file = openSync(path, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead).split('\n')[0];
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { if (file !== undefined) closeSync(file); }
}

/** Unique sibling files make each replacement atomic even with interleaved writers. */
function atomicWrite(path, text, write) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { write(temp, text, 'utf8'); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
function contentHash(path) {
  let file;
  try {
    file = openSync(path, 'r');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size;
    while ((size = readSync(file, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size));
    return digest.digest('hex');
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { if (file !== undefined) closeSync(file); }
}

/** Scan files synchronously in bounded chunks; callers retain only the newest five matching rows. */
function scanLines(path, visit) {
  let file;
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const consume = chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of [...lines, pending]) if (Buffer.byteLength(line) > HISTORY_LINE_MAX_BYTES) {
      throw new Error('pr-digest: history line exceeds 1 MiB; repair or rotate the history before regenerating');
    }
    for (const line of lines) visit(line);
  };
  try {
    file = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = readSync(file, buffer, 0, buffer.length, null)) > 0) {
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (pending) visit(pending);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  finally { if (file !== undefined) closeSync(file); }
}

export function readDigestLedger(path, pr) {
  const rows = [];
  scanLines(path, line => {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error('pr-digest: malformed ledger; repair the JSONL before regenerating'); }
    const incomplete = () => { throw new Error('pr-digest: incomplete outcome evidence; repair the ledger before regenerating'); };
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.kind !== 'string') incomplete();
    if (row.kind !== 'outcome') return;
    if (typeof row.repo !== 'string' || !row.repo || !Number.isSafeInteger(row.pr) || row.pr <= 0) incomplete();
    if (row.repo !== REPO || row.pr !== pr) return;
    if (row.v !== 1 || !LEDGER_OUTCOMES.includes(row.outcome) || typeof row.at !== 'string'
      || !Number.isFinite(Date.parse(row.at)) || typeof row.session !== 'string' || !row.session.trim()
      || typeof row.head !== 'string' || !/^[a-f0-9]{40}$/i.test(row.head) || typeof row.infra !== 'boolean'
      || (row.reason !== undefined && typeof row.reason !== 'string')) {
      incomplete();
    }
    rows.push(row);
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (rows.length > 5) rows.shift();
  });
  return rows;
}

export function readDigestDaemon(path, pr, now) {
  const rows = [];
  const mentions = new RegExp(`(?:#${pr}\\b|\\bPR\\s+${pr}\\b|\\bpr=${pr}\\b)`);
  scanLines(path, line => {
    const at = Date.parse(line.match(/^\d{4}-\d\d-\d\dT\S+/)?.[0]);
    if (!(at >= now - 2 * 60 * 60 * 1000 && at <= now) || !mentions.test(line)) return;
    rows.push({ at, line });
    rows.sort((a, b) => a.at - b.at);
    if (rows.length > 5) rows.shift();
  });
  return rows.map(r => r.line);
}

/** One comment body at most per metadata request; follow only the numeric last-page parameter, never a supplied URL. */
export function readLatestCommentId(pr, gh) {
  const endpoint = `repos/${REPO}/issues/${pr}/comments?per_page=1`;
  const response = String(gh(['api', '--include', endpoint], READ_OPTIONS));
  const split = response.search(/\r?\n\r?\n/);
  if (split < 0 || !/^HTTP\/\S+ 200\b/m.test(response.slice(0, split))) throw new Error('pr-digest: invalid comments metadata response');
  const header = response.slice(0, split);
  const last = header.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/i)?.[1];
  if (!last && /rel="next"/i.test(header)) throw new Error('pr-digest: missing last-page link; retry metadata read');
  if (last) {
    const id = String(gh(['api', `${endpoint}&page=${last}`, '--jq', '.[-1].id // 0'], READ_OPTIONS)).trim();
    if (!/^\d+$/.test(id)) throw new Error('pr-digest: invalid last comment id');
    return id;
  }
  const page = JSON.parse(response.slice(split).trim());
  if (!Array.isArray(page) || page.length > 1 || (page.length && !Number.isSafeInteger(page[0].id))) {
    throw new Error('pr-digest: invalid latest comments page');
  }
  return String(page.at(-1)?.id ?? 0);
}

/** Synchronous injection boundary for the writing effect and hermetic fixtures; PRs are processed sequentially. */
export function createPrDigestReader({
  gh = digestGh, readHeader = firstLine, write = writeFileSync, makeDir = mkdirSync,
  writeCache = writeFileSync,
  readLedger = readDigestLedger, readDaemon = readDigestDaemon, now = () => Date.now(),
  readLatest = readLatestCommentId,
  readComments = (pr, runner) => defaultListPrComments({ number: pr, repo: REPO,
    exec: (_file, args, opts) => runner(args, { ...opts, maxBuffer: COMMENTS_MAX_BUFFER }) }),
  home = homedir(),
} = {}) {
  return input => {
    const outDir = resolve(input['out-dir'] ?? join(home, 'workspace', '.operations', 'digests'));
    const ledgerPath = input.ledger ?? join(home, '.claude', 'conveyor', 'fix-loop-ledger.jsonl');
    const daemonPath = input['daemon-log'] ?? join(home, 'workspace', 'wev-review-daemon', '.conveyor', 'review-daemon.log');
    const list = input.all ? JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--json', 'number', '--limit', '1000'], READ_OPTIONS)) : [{ number: input.pr }];
    if (!Array.isArray(list) || list.some(p => !Number.isSafeInteger(p?.number) || p.number <= 0)) throw new Error('pr-digest: invalid PR list');
    if (input.all && list.length >= 1000) {
      throw notApplied('pr-digest: incomplete coverage at the 1000 PR limit; enumerate the full open PR list and use --pr=<number> for each PR');
    }
    const results = [];
    for (const [index, { number }] of list.entries()) {
      if (input.all && index >= ALL_THREAD_PR_BUDGET) {
        throw notApplied(`pr-digest: incomplete; budget exhausted, ${list.length - index} PRs not processed; run --pr=<number> for remaining PRs (full-thread budget ${ALL_THREAD_PR_BUDGET}, constant default)`);
      }
      const pr = JSON.parse(gh(['pr', 'view', String(number), '--repo', REPO, '--json', 'number,title,body,headRefOid,labels'], READ_OPTIONS));
      if (pr?.number !== number || !/^[a-f0-9]{40}$/i.test(pr.headRefOid) || typeof pr.title !== 'string'
        || typeof pr.body !== 'string' || !Array.isArray(pr.labels)
        || pr.labels.some(l => typeof l !== 'string' && typeof l?.name !== 'string')) throw new Error('pr-digest: incomplete PR metadata');
      const lastComment = readLatest(number, gh);
      const path = join(outDir, `pr-${number}.md`);
      const ledger = readLedger(ledgerPath, number);
      const daemon = readDaemon(daemonPath, number, now());
      // Re-read the complete thread: existing comments can be edited without changing the latest ID.
      const comments = readComments(number, gh);
      if (!Array.isArray(comments) || comments.some(c => typeof c?.body !== 'string')) throw new Error('pr-digest: incomplete comment thread');
      const digestComments = comments.map(c => ({ ...c, trusted: isTrustedMarkerAuthor(c) }));
      // Keep the digest's header/output stable; a bounded sidecar fingerprints the other rendered inputs.
      // Re-reading the filtered daemon rows also invalidates decisions that age out of the two-hour window.
      const cachePath = `${path}.cache`;
      const fingerprint = hash(JSON.stringify({ schema: 6, pr, lastComment, ledger, daemon, comments: digestComments }));
      if (readHeader(path) === cacheHeader(pr.headRefOid, lastComment) && readHeader(cachePath) === `${fingerprint} ${contentHash(path)}`) {
        results.push({ pr: number, path, status: 'cached' });
        continue;
      }
      const text = renderPrDigest({ pr, lastComment, comments: digestComments, ledger, daemon,
        validateRuling: (record, referral, body) => referral ? validateReferralRecord(record)
          : validateOperatorRuling(record) && buildOperatorRulingComment(record) === body.replace(/\r\n/g, '\n').trimEnd() });
      makeDir(outDir, { recursive: true });
      // Invalidate first so an interrupted write cannot leave an old fingerprint blessing new digest text.
      atomicWrite(cachePath, '', writeCache);
      atomicWrite(path, text, write);
      atomicWrite(cachePath, `${fingerprint} ${hash(text)}\n`, writeCache);
      results.push({ pr: number, path, status: 'written' });
    }
    return { results, all: Boolean(input.all) };
  };
}

/** The digest reader writes files, so only the executor's writing sink may call it. */
export function createPrDigestSinks(options) {
  return { [PR_DIGEST_EFFECT]: createPrDigestReader(options) };
}
