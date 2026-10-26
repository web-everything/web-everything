#!/usr/bin/env node
/** Read-only PR watcher. Durable timers start at observed readiness, never PR age.
 * Receipts advance only after delivery; interrupted publication may be retried.
 * State lifecycle: unpublished heads retire when superseded; unmerged closes retire
 * polling, retaining delivered identities only for reopening deduplication. Merges
 * compact to a terminal delivery marker. The cursor resets after a complete sweep.
 */
import { runMergeWatchSignals } from './pr-merge-watch-signals.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { humanReviewHold } from '../../operations/pr-sweep-core.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { readSettings } from '../../lib/settings-files.mjs';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from '../../lib/policy-cascade.mjs';
import { handoffHome } from '../../operations/handoff-home.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const minutesValid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const defaults = { readyNotMergingMinutes: 60, noProgressDraftMinutes: 240, noProgressMinutes: 180, ciJobOverdueFactor: 2 };
const envKeys = ['READY_MINUTES', 'NO_PROGRESS_DRAFT_MINUTES', 'NO_PROGRESS_MINUTES', 'CI_JOB_OVERDUE_FACTOR'];
const thresholdLayer = layer => Object.fromEntries(Object.keys(defaults).map(key =>
  [key, object(layer?.[key]) ? undefined : layer?.[key]]));
export function resolveMergeWatchSettings({ env = process.env, log = console.error, settingsFiles } = {}) {
  const result = resolveCascade({
    standard: defaults, platform: thresholdLayer(readPlatformPreferences({ env }).prefs.prMergeWatch),
    tool: thresholdLayer(readSettings(settingsFiles).prMergeWatch),
    envValues: Object.fromEntries(Object.keys(defaults).map((key, i) => {
      const raw = env[`WE_PR_MERGE_WATCH_${envKeys[i]}`];
      return [key, raw?.trim() ? Number(raw) : undefined];
    })),
    valid: Object.fromEntries(Object.keys(defaults).map(key => [key, v => minutesValid(v) && (key !== 'ciJobOverdueFactor' || v > 0)])),
  });
  log(formatCascadeSourcesLine('prMergeWatch', result));
  return result.value;
}

export async function runMergeWatch({ repos = [], gh, now = new Date().toISOString(),
  stateDir = join(handoffHome(), 'pr-merge-watch'), settings, emitEvent = appendDaemonEvent,
  log = console.error, signalLogs } = {}) {
  // Load the analysis graph after the shared gate graph has finished evaluating.
  const { atomicJson, readOptionalJson, ghJson, repoFilenameKey } = await import('../../operations/coroner-pr-postmortem.mjs');
  const { defaultListPrComments } = await import('../pr-comments-list.mjs');
  const { listOpenPrs } = await import('./pr-postmortem-pass.mjs');
  gh ??= ghJson;
  const config = settings ? { ...defaults, ...settings } : resolveMergeWatchSettings({ log });
  const stamp = Date.parse(now);
  if (!Number.isFinite(stamp) || Object.entries(config).some(([k, v]) => !minutesValid(v) || (k === 'ciJobOverdueFactor' && v <= 0))) throw Error('invalid merge-watch time/settings');
  let calls = 0, delivered = 0, incomplete = false, budgetExhausted = false;
  const read = args => {
    if (calls >= 128) { budgetExhausted = true; throw Error('GitHub evidence tick budget exceeded'); }
    calls++;
    return gh(args);
  };
  // Fixed diagnostics keep untrusted PR text and child stderr out of terminal logs.
  const failure = () => {
    incomplete = true;
    log('pr-merge-watch: incomplete/unavailable evidence or delivery; operator must inspect PR evidence, page caps, state and event sink');
  };
  // A single durable cursor covers repositories and both kinds of PR work. A partial
  // subject restarts with a fresh budget; bounded readers fit within that budget.
  const cursorFile = join(stateDir, 'cursor.json');
  let cursor;
  try {
    cursor = readOptionalJson(cursorFile, null);
    if (cursor !== null && (!object(cursor) || typeof cursor.repo !== 'string'
      || !(cursor.number === null || (Number.isSafeInteger(cursor.number) && cursor.number > 0)))) throw Error('invalid cursor');
  } catch { failure(); return { delivered, incomplete }; }
  const repoOrder = [...new Set(repos)];
  const startRepo = Math.max(0, repoOrder.indexOf(cursor?.repo));
  const defer = (repo, number = null) => {
    atomicJson(cursorFile, { repo, number });
    failure();
    return { delivered, incomplete };
  };
  for (const repo of [...repoOrder.slice(startRepo), ...repoOrder.slice(0, startRepo)]) {
    try {
      if (calls >= 128) return defer(repo);
      const file = join(stateDir, `${repoFilenameKey(repo)}.json`);
      const state = readOptionalJson(file, { prs: {} });
      if (!object(state.prs) || Object.entries(state.prs).some(([n, p]) =>
        !/^[1-9]\d*$/.test(n) || !object(p) || !object(p.heads) || typeof p.merged !== 'boolean'
        || (p.closed !== undefined && typeof p.closed !== 'boolean')
        || Object.entries(p.heads).some(([h, r]) => !sha(h) || !object(r) || typeof r.alerted !== 'boolean'
          || (r.signals !== undefined && (!object(r.signals) || Object.entries(r.signals).some(([k, v]) => !/^(progress|ci:\d+|loop:[a-f0-9]{64})$/.test(k) || v !== true)))
          || !(r.since === null || (Number.isFinite(r.since) && r.since <= stamp))))) throw Error('invalid saved evidence');
      const save = () => atomicJson(file, state);
      // Migrate old terminal entries without making another GitHub request.
      let compacted = false;
      for (const tracked of Object.values(state.prs)) if (tracked.merged && Object.keys(tracked.heads).length) {
        tracked.heads = {};
        compacted = true;
      }
      if (compacted) save();
      const send = async event => {
        if (await emitEvent(event) === false) throw Error('event delivery unavailable');
        delivered++;
      };
      const open = listOpenPrs(repo, { gh: read });
      // Persist discovery before readiness reads or budget deferral.
      // Empty heads schedule merge checks without claiming any readiness evidence.
      let discovered = false;
      for (const listed of open) {
        if (!state.prs[listed.number]) {
          state.prs[listed.number] = { heads: {}, merged: false };
          discovered = true;
        }
        const tracked = state.prs[listed.number];
        if (tracked.closed !== undefined) {
          delete tracked.closed; // Reopened PRs need merge checks even if evidence fails.
          discovered = true;
        }
      }
      if (discovered) save();
      const jobs = new Map(open.map(p => [p.number, p]));
      for (const [number, tracked] of Object.entries(state.prs)) {
        if (!tracked.merged && !tracked.closed && !jobs.has(Number(number))) jobs.set(Number(number), null);
      }
      const numbers = [...jobs.keys()].sort((a, b) => a - b);
      const start = cursor?.repo === repo && cursor.number !== null
        ? Math.max(0, numbers.findIndex(n => n >= cursor.number)) : 0;
      // Finish this sweep's suffix before advancing to the next repository. Wrapping
      // here would let an oversized first repository monopolize every tick again.
      for (const number of numbers.slice(start)) {
        if (calls >= 128) return defer(repo, number);
        const listed = jobs.get(number);
        try {
          if (!listed) {
            const tracked = state.prs[number];
            const pr = read(['api', `repos/${repo}/pulls/${number}`]);
            if (pr?.number !== number || !['open', 'closed'].includes(pr.state)
              || !(pr.merged_at === null || (typeof pr.merged_at === 'string'
                && Number.isFinite(Date.parse(pr.merged_at)) && Date.parse(pr.merged_at) <= stamp))) throw Error('invalid merge evidence');
            for (const receipt of Object.values(tracked.heads)) receipt.since = null;
            save();
            if (pr.state === 'closed') {
              if (pr.merged_at) {
                await send({ kind: 'pr-merged', repo, pr: number });
                // Keep only the terminal delivery marker to suppress duplicate merges.
                state.prs[number] = { merged: true, heads: {} };
              } else {
                // Retire polling. Keep only delivered identities if reopening could
                // otherwise publish a second alert for the same head.
                tracked.heads = Object.fromEntries(Object.entries(tracked.heads)
                  .filter(([, receipt]) => receipt.alerted || Object.keys(receipt.signals ?? {}).length));
                if (Object.keys(tracked.heads).length) tracked.closed = true;
                else delete state.prs[number];
              }
              save();
            }
            continue;
          }
          const pr = read(['pr', 'view', String(listed.number), '--repo', repo, '--json',
            'number,state,isDraft,headRefOid,labels,mergeStateStatus']);
          if (pr?.number !== listed.number || pr.state !== 'OPEN' || typeof pr.isDraft !== 'boolean'
            || !sha(pr.headRefOid) || !Array.isArray(pr.labels) || pr.labels.some(l => typeof l?.name !== 'string')
            || typeof pr.mergeStateStatus !== 'string'
            || !pr.mergeStateStatus || pr.headRefOid !== listed.head?.sha) throw Error('incomplete PR evidence');
          pr.comments = defaultListPrComments({ number: pr.number, repo, gh: read, maxPages: 10 });
          if (pr.comments.some(c => typeof c.body !== 'string' || typeof c.author?.login !== 'string'
            || !Number.isFinite(Date.parse(c.createdAt)))) throw Error('incomplete comment evidence');
          const tracked = state.prs[pr.number];
          for (const [head, receipt] of Object.entries(tracked.heads)) if (head !== pr.headRefOid) {
            receipt.since = null;
            // Unpublished superseded heads retire; delivered identities remain for deduplication.
            if (!receipt.alerted && !Object.keys(receipt.signals ?? {}).length) delete tracked.heads[head];
          }
          const receipt = tracked.heads[pr.headRefOid] ??= { since: null, alerted: false };
          const names = pr.labels.map(l => l.name);
          const ready = !pr.isDraft && names.includes('review:accepted') && names.includes('red-team:clear')
            && pr.mergeStateStatus === 'CLEAN' && humanReviewHold(pr, stamp).length === 0;
          if (!ready) receipt.since = null;
          else receipt.since ??= stamp;
          save();
          const minutes = (stamp - receipt.since) / 60000;
          if (ready && !receipt.alerted && minutes > config.readyNotMergingMinutes) {
            await send({ kind: 'pr-ready-not-merging', repo, pr: pr.number, detail: { minutes, head: pr.headRefOid } });
            receipt.alerted = true;
            save();
          }
          await runMergeWatchSignals({ repo, pr, receipt, now: stamp, config, read, send, save, failure, signalLogs });
        } catch { failure(); }
        if (budgetExhausted) return defer(repo, number);
      }
    } catch {
      failure();
      if (budgetExhausted) return defer(repo);
    }
  }
  if (cursor !== null && repoOrder.length) atomicJson(cursorFile, { repo: repoOrder[0], number: null });
  return { delivered, incomplete };
}

export async function runMergeWatchCli(values, { runPass = runMergeWatch, sleep: wait = sleep,
  signal, log = console.log } = {}) {
  do {
    try {
      const result = await runPass({ repos: values.repos ?? [values.repo], stateDir: values.out, log });
      log(JSON.stringify(result));
      if (result.incomplete && !values.watch) process.exitCode = 1;
    } catch {
      log('pr-merge-watch: unavailable evidence; operator must inspect watcher state');
      if (!values.watch) process.exitCode = 1;
    }
    if (values.watch && !signal?.aborted) await wait(60_000, undefined, { signal }).catch(() => {});
  } while (values.watch && !signal?.aborted);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { repo: { type: 'string', multiple: true },
    out: { type: 'string' }, watch: { type: 'boolean' } } });
  if (!values.repo?.length) throw Error('expected --repo=owner/name');
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  await runMergeWatchCli({ ...values, repos: values.repo }, { signal: abort.signal });
}
