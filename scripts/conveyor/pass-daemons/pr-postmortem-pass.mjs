#!/usr/bin/env node
/** Standalone merge watcher. --watch polls every minute; one-shot mode is scheduler-friendly.
 * GitHub merged_at is the landed confirmation; no drain mutation or shared conveyor-file edit.
 * Cursor advances only after a complete window succeeds; per-PR receipts survive partial failures.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPostmortem, shouldPostmortem, publishPostmortem, collectPrTimeline, resolvePostmortemSettings,
  coronerStateDir, readOptionalJson, atomicJson, ghJson, validateSubject, withCoronerLock } from '../../operations/coroner-pr-postmortem.mjs';

/** Updated-order REST listing avoids search-index lag and its separate rate budget.
 * A failed/capped listing never advances the cursor. Recent closed-but-unmerged PRs are ignored.
 */
export function listMergedSince(repo, since, until, { gh = ghJson, maxPages = 100 } = {}) {
  const found = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const rows = gh(['api',`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`]);
    if (!Array.isArray(rows) || rows.some(p => !Number.isFinite(Date.parse(p.updated_at)))) throw Error('invalid merged PR listing');
    for (const p of rows) if (p.merged_at && Date.parse(p.merged_at) >= Date.parse(since) && Date.parse(p.merged_at) <= Date.parse(until)) found.set(p.number,p);
    if (rows.length < 100 || Date.parse(rows.at(-1).updated_at) < Date.parse(since)) return [...found.values()].sort((a,b) => a.merged_at.localeCompare(b.merged_at) || a.number-b.number);
  }
  throw Error('merged PR listing exceeds page cap; cursor retained');
}
export async function runPostmortemPass({ repo, dir = coronerStateDir(), now = new Date().toISOString(),
  settings = resolvePostmortemSettings(), listMerged = listMergedSince, collect = collectPrTimeline } = {}) {
  validateSubject(repo,1);
  return withCoronerLock(dir, async () => {
    const file = join(dir,`merge-cursor-${repo.replace('/','-')}.json`);
    const state = readOptionalJson(file,{ cursor:new Date(Date.parse(now)-86400000).toISOString(), done:[] });
    if (!Array.isArray(state.done) || !Number.isFinite(Date.parse(state.cursor)) || Date.parse(now) < Date.parse(state.cursor)) throw Error('invalid merge cursor');
    const config = settings.value ?? settings;
    let published = 0;
    const prs = await listMerged(repo,new Date(Date.parse(state.cursor)-60000).toISOString(),now);
    for (const p of prs) {
      if (state.done.includes(p.number)) continue;
      const r = { ...buildPostmortem(await collect(repo,p.number)), settings };
      if (Date.parse(r.mergedAt) > Date.parse(now)) continue;
      if (shouldPostmortem(r,config)) { publishPostmortem(r,{dir}); published++; }
      state.done.push(p.number); state.done.sort((a,b) => a-b);
      atomicJson(file,state);
    }
    state.cursor = now; atomicJson(file,state);
    return { published, cursor:state.cursor, done:state.done.length };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { repo:{type:'string'}, out:{type:'string'}, watch:{type:'boolean'} } });
  const abort = new AbortController();
  process.once('SIGTERM',() => abort.abort()); process.once('SIGINT',() => abort.abort());
  do {
    try { console.log(JSON.stringify(await runPostmortemPass({repo:values.repo,dir:values.out}))); }
    catch(e) { console.error(`pr-postmortem-pass: ${e.message}`); if (!values.watch) process.exitCode = 1; }
    if (values.watch && !abort.signal.aborted) await sleep(60000,undefined,{signal:abort.signal}).catch(() => {});
  } while (values.watch && !abort.signal.aborted);
}
