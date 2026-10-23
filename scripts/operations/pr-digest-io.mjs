/** Read-only GitHub shell for PR digests; the only writes are local digest files, never GitHub mutations. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { defaultListPrComments } from '../conveyor/pr-comments-list.mjs';
import { cacheHeader, renderPrDigest } from './pr-digest.mjs';

const REPO = 'web-everything/web-everything';
export const COMMENTS_MAX_BUFFER = 256 * 1024 * 1024;
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

/** Scan files synchronously in bounded chunks; callers retain only the newest five matching rows. */
function scanLines(path, visit) {
  let file;
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const consume = chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
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
    if (row.kind !== 'outcome' || Number(row.pr) !== pr) return;
    if (typeof row.outcome !== 'string' || !Number.isFinite(Date.parse(row.at))) {
      throw new Error('pr-digest: incomplete outcome; repair the ledger before regenerating');
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

/** Synchronous injection boundary for compute steps and hermetic fixtures; PRs are processed sequentially. */
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
    const results = [];
    for (const { number } of list) {
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
      const fingerprint = createHash('sha256').update(JSON.stringify({ pr, lastComment, ledger, daemon, comments: digestComments })).digest('hex');
      if (readHeader(path) === cacheHeader(pr.headRefOid, lastComment) && readHeader(cachePath) === fingerprint) {
        results.push({ pr: number, path, status: 'cached' });
        continue;
      }
      const text = renderPrDigest({ pr, lastComment, comments: digestComments, ledger, daemon });
      makeDir(outDir, { recursive: true });
      // Invalidate first so an interrupted write cannot leave an old fingerprint blessing new digest text.
      writeCache(cachePath, '', 'utf8');
      write(path, text, 'utf8');
      writeCache(cachePath, `${fingerprint}\n`, 'utf8');
      results.push({ pr: number, path, status: 'written' });
    }
    return { results, all: Boolean(input.all) };
  };
}
