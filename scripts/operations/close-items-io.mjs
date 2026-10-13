/** IO shell for close/reopen. All card mutations use the existing guarded writer. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './resolve-io.mjs';
import { writeBacklogMd } from '../backlog/guarded-write.mjs';
import { localToday } from '../lib/local-date.mjs';
import { openPrItemNums } from '../lib/open-pr-items.mjs';
import { readQueueFile, writeQueueFile, removeFromQueue, resolveQueuePath } from '../conveyor/queue-store.mjs';
import { CLOSE_ITEMS_EFFECT } from './close-items.mjs';
import { REOPEN_ITEMS_EFFECT } from './reopen-items.mjs';
const matter = createRequire(import.meta.url)('gray-matter');
export function createCloseItemsReader({ root = REPO_ROOT, today = localToday, openPrs = openPrItemNums,
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
