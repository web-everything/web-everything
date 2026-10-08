/**
 * @file scripts/operations/ledger-backfill-rulings.mjs
 * @description Backfill recent `ruling` / `send-back` rows from the machine-local ledger into the shared git store
 *   (`ops/review-requests`). Until card x89y6dn, `record-referral-ruling` wrote those rows to the home file only, and
 *   stored the raw finding key. This copies rows for OPEN PRs since `--since` (default: today, ET), hashing each key
 *   the way referral rows do (a key the row builder truncated is recovered from the PR's ruling comments). The derive
 *   reads in append order, so a row whose meaning would change by landing after later git rows (a later referral,
 *   clearing verdict, or ruling for the same finding) is skipped as `out-of-order`, never reordered. A clearing
 *   ruling (`not-real` / `card`) is copied only when the PR thread carries a ruling comment for the same key and
 *   result; otherwise it is skipped as `unposted`. Dry-run by default; `--apply` appends through the git store contract.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildLedgerEvent, parseLedgerEvents, resolveLedgerBoard, verdictClears, verdictLedgerPath } from '../lib/verdict-ledger.mjs';
import { ledgerFindingKey, sameHead, verdictHead } from '../lib/pr-state/referrals.mjs';
import { getLedgerStore } from '../lib/verdict-ledger-store.mjs';
import '../lib/verdict-ledger-io.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readOperatorRulings } from '../lib/jury-core.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const CLEARING_RULINGS = new Set(['not-real', 'card']);
const hashed = key => /^sha256:[0-9a-f]{64}$/.test(key);
const oneLine200 = value => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};
const candidatesFor = (rows, openPrs, since) => rows.filter(row =>
  ['ruling', 'send-back'].includes(row.type) && openPrs.has(row.pr) && Date.parse(row.at) >= Date.parse(since));

function headAt(rows) {
  let head = null;
  for (const row of rows) {
    const value = row.type === 'verdict' ? verdictHead(row) : row.headSha;
    if (typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value)) head = value;
  }
  return head;
}

/**
 * `threadRulings` maps a PR number to the rulings its public thread comments carry (`{ key, result }`, the raw key as
 * the comment states it). A clearing ruling is only copied when a comment backs that exact key AND result.
 */
export function planRulingBackfill({ homeRows, gitRows, openPrs, since, threadRulings = new Map() }) {
  const append = [], skipped = [];
  const candidates = candidatesFor(homeRows, openPrs, since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const row of candidates) {
    const { pr, type, at } = row;
    const skip = reason => skipped.push({ pr, type, at, reason });
    const thread = threadRulings.get(pr) ?? [];
    let findingKey;
    if (type === 'ruling') {
      const fk = row.findingKey;
      if (hashed(fk)) findingKey = fk;
      else {
        const matches = [...new Set(thread.map(t => t.key).filter(k => k === fk || oneLine200(k) === fk))];
        if (matches.length === 1) findingKey = ledgerFindingKey(matches[0]);
        else if (!fk.endsWith('…')) findingKey = ledgerFindingKey(fk);
        else { skip('key-truncated-unresolved'); continue; }
      }
    }
    if ([...gitRows, ...append].some(other => other.type === type && other.pr === pr && other.at === at &&
      (type === 'ruling' ? ledgerFindingKey(other.findingKey) === findingKey : other.cause === row.cause))) {
      skip('already-in-git'); continue;
    }
    // The live path writes the row before it posts the comment, so a clearing row can exist with no public ruling.
    // `block` is fail-safe (it only holds), so only the closed clearing set needs a comment naming the same key and result.
    if (type === 'ruling' && CLEARING_RULINGS.has(row.ruling) &&
      !thread.some(t => t.result === row.ruling && ledgerFindingKey(t.key) === findingKey)) {
      skip('unposted'); continue;
    }
    const history = gitRows.filter(other => other.pr === pr);
    let outOfOrder;
    if (type === 'ruling') {
      // A later row for the same finding replaces its state in the derive's append-order fold, so landing this one after it would undo it.
      outOfOrder = history.some(other => Date.parse(other.at) > Date.parse(at) &&
        ((other.type === 'referral' && other.findingKeys.some(k => ledgerFindingKey(k) === findingKey)) ||
          (other.type === 'ruling' && ledgerFindingKey(other.findingKey) === findingKey) ||
          (other.type === 'verdict' && verdictClears(other.verdict))));
    } else {
      const before = headAt(history.filter(other => Date.parse(other.at) <= Date.parse(at)));
      const current = headAt(history);
      outOfOrder = !(before === null && current === null) && !sameHead(before, current);
    }
    if (outOfOrder) { skip('out-of-order'); continue; }
    append.push(buildLedgerEvent({
      type, repo: row.repo, pr, at, source: row.source, writer: row.writer,
      declaredActor: row.actor?.declared, session: row.actor?.session, channel: row.actor?.channel,
      ...(type === 'ruling' ? { findingKey, ruling: row.ruling } : { cause: row.cause }),
    }));
  }
  return { append, skipped };
}

// Resolve midnight using the offset at that midnight, including DST transition days.
export function newYorkMidnight(now = new Date()) {
  const zone = 'America/New_York';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T04:00:00Z`)).find(p => p.type === 'timeZoneName').value.replace('GMT', '');
  return new Date(`${date}T00:00:00${offset}`).toISOString();
}

const ghJson = args => JSON.parse(execFileSyncThrottled('gh', args, { encoding: 'utf8' }));
function readHome(repo) {
  try { return parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function main({
  repos = Object.values(CONSTELLATION_REPOS).map(r => r.slug), since = newYorkMidnight(), apply = false,
  readHome: home = readHome,
  readGit = ctx => getLedgerStore('git').read(ctx),
  listOpenPrs = repo => ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number']).map(pr => pr.number),
  readThreadRulings = (repo, pr) => readOperatorRulings(readCompletePrComments(pr, { repo })).rulings.map(r => ({ key: r.key, result: r.result })),
  appendGit = (rows, ctx) => getLedgerStore('git').append(rows, ctx),
  resolveBoard = repo => resolveLedgerBoard(repo, {}, process.env),
} = {}) {
  if (!Number.isFinite(Date.parse(since))) throw new TypeError('Invalid --since timestamp');
  const results = [];
  let exitCode = 0;
  for (const repo of repos) {
    const result = { repo, mode: apply ? 'apply' : 'dry-run', candidates: 0, append: 0, skipped: {}, appended: 0 };
    results.push(result);
    try {
      const homeRows = await home(repo);
      const board = await resolveBoard(repo);
      if (!board) { result.status = 'no-board'; continue; }
      const git = await readGit({ board, repo });
      if (git.status !== 'ok') {
        result.status = git.status;
        result.error = git.error ?? git.reason;
        exitCode = 1;
        continue;
      }
      const openPrs = new Set(await listOpenPrs(repo));
      const candidates = candidatesFor(homeRows, openPrs, since);
      result.candidates = candidates.length;
      // Raw keys need the thread to recover the full key; clearing rulings need it to prove a comment was posted.
      const threadRulings = new Map();
      const needsThread = row => row.type === 'ruling' && (!hashed(row.findingKey) || CLEARING_RULINGS.has(row.ruling));
      for (const pr of new Set(candidates.filter(needsThread).map(row => row.pr))) {
        threadRulings.set(pr, await readThreadRulings(repo, pr));
      }
      const plan = planRulingBackfill({ homeRows, gitRows: git.rows, openPrs, since, threadRulings });
      result.append = plan.append.length;
      for (const { reason } of plan.skipped) result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
      if (apply && plan.append.length) {
        const written = await appendGit(plan.append, { board, repo });
        result.appended = written.appended ?? 0;
        if (written.ok === false) {
          result.status = 'append-failed';
          result.error = written.error;
          exitCode = 1;
        }
      }
    } catch (error) {
      result.status = 'error'; result.error = error.message; exitCode = 1;
    }
  }
  return { results, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {};
    let json = false;
    for (const arg of process.argv.slice(2)) {
      if (arg === '--apply') options.apply = true;
      else if (arg === '--json') json = true;
      else if (arg.startsWith('--repo=')) options.repos = arg.slice(7).split(',');
      else if (arg.startsWith('--since=')) options.since = arg.slice(8);
      else throw new Error(`Unknown argument: ${arg}`);
    }
    const { results, exitCode } = await main(options);
    if (json) console.log(JSON.stringify(results));
    else for (const r of results) console.log(`${r.repo}: ${r.mode}, candidates=${r.candidates}, append=${r.append}, skipped=${JSON.stringify(r.skipped)}, appended=${r.appended}${r.status ? `, ${r.status}` : ''}${r.error ? `: ${r.error}` : ''}`);
    process.exitCode = exitCode;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
