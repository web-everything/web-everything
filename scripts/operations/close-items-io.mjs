/** IO shell for close/reopen. All card mutations use the existing guarded writer. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './resolve-io.mjs';
import { writeBacklogMd } from '../backlog/guarded-write.mjs';
import { localToday } from '../lib/local-date.mjs';
import { execFileSync } from 'node:child_process';
import { listOpenPrsPagedHydrated, resolvePrListPaging } from '../lib/pr-list-paged.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { readQueueFile, writeQueueFile, removeFromQueue, resolveQueuePath } from '../conveyor/queue-store.mjs';
import { CLOSE_ITEMS_EFFECT } from './close-items.mjs';
import { REOPEN_ITEMS_EFFECT } from './reopen-items.mjs';
const matter = createRequire(import.meta.url)('gray-matter');
const GH_FILES_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000, killSignal: 'SIGKILL' };
/** Every changed path of one PR, renamed-from paths included. REST pages fully; `gh pr view` stops at 100 files. */
function readPrFiles({ repo, number, exec }) {
  const text = String(exec('gh', ['api', `repos/${repo}/pulls/${number}/files`, '--paginate',
    '--jq', '.[] | [.filename, (.previous_filename // "")] | @tsv'], GH_FILES_OPTS));
  const lines = text.split('\n').filter(Boolean);
  return { count: lines.length, paths: lines.flatMap(l => l.split('\t')).filter(Boolean) };
}
/**
 * The close guard's open-PR read: every open PR in every constellation repo, fully paged, with ref, title, body
 * and the full changed-file list. Fails closed — a primary-repo failure is `unavailable`, a sibling failure is
 * `partial`, and a capped page listing or a file list shorter than `changedFiles` is `truncated`.
 */
export function readOpenPrsForClose({ exec = execFileSync, repos = Object.values(CONSTELLATION_REPOS).map(r => r.slug),
  paging = resolvePrListPaging(), maxRows = 1000 } = {}) {
  const prs = [], partial = [], truncated = [];
  for (const [i, repo] of repos.entries()) {
    try {
      const list = listOpenPrsPagedHydrated({ repo, exec, paging, heavyFields: ['body', 'changedFiles'], maxRows });
      if (list.truncated || list.rows.length < list.totalCount) truncated.push({ repo, reason: `listed ${list.rows.length} of ${list.totalCount} open PRs` });
      for (const row of list.rows) {
        const files = readPrFiles({ repo, number: row.number, exec });
        if (!Number.isInteger(row.changedFiles) || files.count < row.changedFiles) {
          truncated.push({ repo, reason: `PR #${row.number}: read ${files.count} of ${row.changedFiles} changed files` });
        }
        prs.push({ repo, number: row.number, headRefName: row.headRefName, title: row.title, body: row.body ?? '', files: files.paths });
      }
    } catch (e) {
      const reason = String(e?.message ?? e).split('\n')[0];
      if (i === 0) return { prs: [], unavailable: true, reason };
      partial.push({ repo, reason });
    }
  }
  return { prs, ...(partial.length ? { partial } : {}), ...(truncated.length ? { truncated } : {}) };
}
export function createCloseItemsReader({ root = REPO_ROOT, today = localToday, openPrRead = {}, openPrs = () => readOpenPrsForClose(openPrRead),
  queueFile, env = process.env, actor = env.OPERATION_ACTOR || env.USER || 'unknown', channel = 'cli', reopen = false } = {}) {
  return input => {
    const cards = readdirSync(join(root, 'backlog')).filter(f => f.endsWith('.md')).map(f => {
      const abs = join(root, 'backlog', f), content = readFileSync(abs, 'utf8'), data = matter(content).data;
      const num = f.replace(/\.md$/, '').split('-')[0];
      return { ...data, id: num, num, status: data.status || 'open', blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [], abs, file: `backlog/${f}`, content };
    });
    const settings = join(root, 'scripts/settings/build-priority.json');
    let prs;
    if (!reopen) { try { prs = openPrs(); } catch (e) { prs = { unavailable: true, reason: e.message }; } }
    return { cards, today: today(), actor, channel,
      triage: input.triage ? JSON.parse(readFileSync(resolve(root, input.triage), 'utf8')) : null,
      priority: existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')).build?.priority ?? [] : [],
      openPrs: prs, queue: reopen ? [] : readQueueFile(queueFile ?? resolveQueuePath(env)) };
  };
}
export function createCloseItemsSinks({ root = REPO_ROOT, queueFile, env = process.env, writeCard = writeBacklogMd } = {}) {
  const write = async (plan, close) => {
    for (const w of plan.writes) writeCard(w.abs, w.rel, w.content, { root });
    if (close) {
      const path = queueFile ?? resolveQueuePath(env);
      let queue = readQueueFile(path);
      for (const w of plan.writes) for (const id of w.ids) queue = removeFromQueue(queue, id);
      writeQueueFile(queue, path);
    }
    return { ...plan.audit, written: plan.writes.map(w => w.rel) };
  };
  return { [CLOSE_ITEMS_EFFECT]: p => write(p, true), [REOPEN_ITEMS_EFFECT]: p => write(p, false) };
}
export const createReopenItemsReader = options => createCloseItemsReader({ ...options, reopen: true });
export const createReopenItemsSinks = createCloseItemsSinks;
export function finishItemsOutcome({ run, code, lines }) {
  return { code, lines: run?.verdict ? [JSON.stringify(run.verdict)] : lines };
}
