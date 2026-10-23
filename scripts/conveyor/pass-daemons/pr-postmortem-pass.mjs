#!/usr/bin/env node
/** Standalone merge watcher. --watch polls every minute; one-shot mode is scheduler-friendly.
 * GitHub merged_at is the landed confirmation; no drain mutation or shared conveyor-file edit.
 * Receipts and retries persist per item. The cursor advances once at batch end,
 * only when no non-quarantined error remains; otherwise the discovery window is retained.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPostmortem, shouldPostmortem, publishPostmortem, collectPrTimeline, resolvePostmortemSettings,
  coronerStateDir, readOptionalJson, atomicJson, ghJson, validateSubject, withCoronerLock, repoFilenameKey } from '../../operations/coroner-pr-postmortem.mjs';

const MAX_COLLECTION_ATTEMPTS = 3;
const MIN_COLLECTION_FAILURE_SPAN_MS = 30*60000;

/** Updated-order REST listing avoids search-index lag and its separate rate budget.
 * A failed/capped listing never advances the cursor. Recent closed-but-unmerged PRs are ignored.
 */
export function listMergedSince(repo, since, until, { gh = ghJson, maxPages = 100 } = {}) {
  const found = new Map();
  const readPage = page => {
    const rows = gh(['api',`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`]);
    if (!Array.isArray(rows) || rows.some(p => !Number.isFinite(Date.parse(p.updated_at)))) throw Error('invalid merged PR listing');
    if (rows.some(p => Date.parse(p.updated_at) > Date.parse(until))) throw Error('listing shifted; cursor retained');
    return rows;
  };
  for (let page = 1; page <= maxPages; page++) {
    const rows = readPage(page);
    for (const p of rows) if (p.merged_at && Date.parse(p.merged_at) >= Date.parse(since) && Date.parse(p.merged_at) <= Date.parse(until)) found.set(p.number,p);
    if (rows.length < 100 || Date.parse(rows.at(-1).updated_at) < Date.parse(since)) {
      // A lone updated row can move onto an already-read page without leaving
      // any newer timestamps on the remaining pages. Recheck the newest rows.
      if (page > 1) readPage(1);
      return [...found.values()].sort((a,b) => a.merged_at.localeCompare(b.merged_at) || a.number-b.number);
    }
  }
  throw Error('merged PR listing exceeds page cap; cursor retained');
}
export async function runPostmortemPass({ repo, dir = coronerStateDir(), now = new Date().toISOString(),
  settings = resolvePostmortemSettings(), listMerged = listMergedSince, collect = collectPrTimeline } = {}) {
  validateSubject(repo,1);
  return withCoronerLock(dir, async ({ beat }) => {
    beat();
    const file = join(dir,`merge-cursor-${repoFilenameKey(repo)}.json`);
    const state = readOptionalJson(file,{ cursor:new Date(Date.parse(now)-86400000).toISOString(), done:[] });
    if (!Array.isArray(state.done) || !Number.isFinite(Date.parse(state.cursor)) || Date.parse(now) < Date.parse(state.cursor)) throw Error('invalid merge cursor');
    state.failures ??= {};
    state.quarantined ??= [];
    if (!state.failures || typeof state.failures !== 'object' || Array.isArray(state.failures) || !Array.isArray(state.quarantined)
      || Object.entries(state.failures).some(([pr,f]) => !/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(f?.attempts) || f.attempts < 1
        || !Number.isFinite(Date.parse(f.at)) || Date.parse(f.at) > Date.parse(now)
        || (f.firstFailedAt !== undefined && (!Number.isFinite(Date.parse(f.firstFailedAt)) || Date.parse(f.firstFailedAt) > Date.parse(f.at))))) throw Error('invalid merge retry state');
    // Upgrade old quarantines that discarded their retry subject. Keep the subject when
    // quarantining so removing only the quarantine row works after cursor advancement.
    for (const failure of state.quarantined) state.failures[failure.pr] ??= failure;
    const config = settings.value ?? settings;
    let published = 0;
    const prs = await listMerged(repo,new Date(Date.parse(state.cursor)-60000).toISOString(),now);
    // Retain failed subjects even if a later listing temporarily omits them.
    const pending = new Map(prs.map(p => [p.number,p]));
    for (const pr of Object.keys(state.failures)) if (!pending.has(Number(pr))) pending.set(Number(pr),{number:Number(pr)});
    const errors = [];
    for (const p of pending.values()) {
      beat(); // fence: stop if a reclaimer took the lock while the previous item ran
      if (state.done.includes(p.number) || state.quarantined.some(q => q.pr === p.number)) continue;
      let r;
      try {
        r = { ...buildPostmortem(await collect(repo,p.number)), settings };
        if (r.repo !== repo || r.pr !== p.number || Date.parse(r.mergedAt) > Date.parse(now)) throw Error('timeline subject or merge time disagrees with listing');
      } catch (error) {
        const previous = state.failures[p.number];
        const failure = { pr:p.number, attempts:(previous?.attempts ?? 0)+1,
          firstFailedAt:previous?.firstFailedAt ?? previous?.at ?? now,
          at:now, incomplete:true, error:String(error?.message ?? error).slice(0,2000) };
        state.failures[p.number] = failure;
        if (failure.attempts >= MAX_COLLECTION_ATTEMPTS && Date.parse(now)-Date.parse(failure.firstFailedAt) >= MIN_COLLECTION_FAILURE_SPAN_MS) {
          state.quarantined.push(failure);
        } else {
          errors.push(`PR ${p.number}: ${failure.error}`);
        }
        beat(); atomicJson(file,state); // fence every write: a reclaimed owner must not overwrite the new owner's state
        continue;
      }
      // Storage/publication failures are pass failures, never poison-item quarantines.
      beat();
      if (shouldPostmortem(r,config)) { publishPostmortem(r,{dir,beat}); published++; }
      delete state.failures[p.number];
      state.done.push(p.number); state.done.sort((a,b) => a-b);
      beat(); atomicJson(file,state);
    }
    if (errors.length) throw Error(`postmortem incomplete; cursor retained: ${errors.join('; ')}`);
    beat(); state.cursor = now; atomicJson(file,state);
    return { published, cursor:state.cursor, done:state.done.length, quarantined:state.quarantined };
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
