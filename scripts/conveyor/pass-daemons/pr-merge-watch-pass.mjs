#!/usr/bin/env node
/** Read-only PR watcher. Durable timers start at observed readiness, never PR age.
 * Receipts advance only after delivery; interrupted publication may be retried.
 */
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
// This setting is scalar: a nested object must not become valid numeric cascade leaves.
const thresholdLayer = layer => ({ readyNotMergingMinutes: object(layer?.readyNotMergingMinutes)
  ? undefined : layer?.readyNotMergingMinutes });
export function resolveMergeWatchSettings({ env = process.env, log = console.error } = {}) {
  const raw = env.WE_PR_MERGE_WATCH_READY_MINUTES;
  const result = resolveCascade({
    standard: { readyNotMergingMinutes: 60 }, platform: thresholdLayer(readPlatformPreferences({ env }).prefs.prMergeWatch),
    tool: thresholdLayer(readSettings().prMergeWatch),
    envValues: { readyNotMergingMinutes: raw?.trim() ? Number(raw) : undefined },
    valid: { readyNotMergingMinutes: minutesValid },
  });
  log(formatCascadeSourcesLine('prMergeWatch', result));
  return result.value;
}

export async function runMergeWatch({ repos = [], gh, now = new Date().toISOString(),
  stateDir = join(handoffHome(), 'pr-merge-watch'), settings, emitEvent = appendDaemonEvent,
  log = console.error } = {}) {
  // Load the analysis graph after the shared gate graph has finished evaluating.
  const { atomicJson, readOptionalJson, ghJson, repoFilenameKey } = await import('../../operations/coroner-pr-postmortem.mjs');
  const { defaultListPrComments } = await import('../pr-comments-list.mjs');
  const { listOpenPrs } = await import('./pr-postmortem-pass.mjs');
  gh ??= ghJson;
  const config = settings ?? resolveMergeWatchSettings({ log });
  const stamp = Date.parse(now);
  if (!Number.isFinite(stamp) || !minutesValid(config.readyNotMergingMinutes)) throw Error('invalid merge-watch time/settings');
  let calls = 0, delivered = 0, incomplete = false;
  const read = args => {
    if (++calls > 128) throw Error('GitHub evidence tick budget exceeded');
    return gh(args);
  };
  // Fixed diagnostics keep untrusted PR text and child stderr out of terminal logs.
  const failure = () => {
    incomplete = true;
    log('pr-merge-watch: incomplete/unavailable evidence or delivery; operator must inspect PR evidence, page caps, state and event sink');
  };
  for (const repo of new Set(repos)) {
    try {
      const file = join(stateDir, `${repoFilenameKey(repo)}.json`);
      const state = readOptionalJson(file, { prs: {} });
      if (!object(state.prs) || Object.entries(state.prs).some(([n, p]) =>
        !/^[1-9]\d*$/.test(n) || !object(p) || !object(p.heads) || typeof p.merged !== 'boolean'
        || Object.entries(p.heads).some(([h, r]) => !sha(h) || !object(r) || typeof r.alerted !== 'boolean'
          || !(r.since === null || (Number.isFinite(r.since) && r.since <= stamp))))) throw Error('invalid saved evidence');
      const save = () => atomicJson(file, state);
      const send = async event => {
        if (await emitEvent(event) === false) throw Error('event delivery unavailable');
        delivered++;
      };
      const open = listOpenPrs(repo, { gh: read });
      const numbers = new Set(open.map(p => p.number));
      for (const listed of open) {
        try {
          const pr = read(['pr', 'view', String(listed.number), '--repo', repo, '--json',
            'number,state,isDraft,headRefOid,labels,mergeStateStatus']);
          if (pr?.number !== listed.number || pr.state !== 'OPEN' || typeof pr.isDraft !== 'boolean'
            || !sha(pr.headRefOid) || !Array.isArray(pr.labels) || pr.labels.some(l => typeof l?.name !== 'string')
            || typeof pr.mergeStateStatus !== 'string'
            || !pr.mergeStateStatus || pr.headRefOid !== listed.head?.sha) throw Error('incomplete PR evidence');
          pr.comments = defaultListPrComments({ number: pr.number, repo, gh: read, maxPages: 10 });
          if (pr.comments.some(c => typeof c.body !== 'string' || typeof c.author?.login !== 'string'
            || !Number.isFinite(Date.parse(c.createdAt)))) throw Error('incomplete comment evidence');
          const tracked = state.prs[pr.number] ??= { heads: {}, merged: false };
          for (const [head, receipt] of Object.entries(tracked.heads)) if (head !== pr.headRefOid) receipt.since = null;
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
        } catch { failure(); }
      }
      for (const [number, tracked] of Object.entries(state.prs)) {
        if (numbers.has(Number(number)) || tracked.merged) continue;
        try {
          const pr = read(['api', `repos/${repo}/pulls/${number}`]);
          if (pr?.number !== Number(number) || !['open', 'closed'].includes(pr.state)
            || !(pr.merged_at === null || (typeof pr.merged_at === 'string'
              && Number.isFinite(Date.parse(pr.merged_at)) && Date.parse(pr.merged_at) <= stamp))) throw Error('invalid merge evidence');
          for (const receipt of Object.values(tracked.heads)) receipt.since = null;
          save();
          if (pr.state === 'closed' && pr.merged_at) {
            await send({ kind: 'pr-merged', repo, pr: Number(number) });
            tracked.merged = true;
            save();
          }
        } catch { failure(); }
      }
    } catch { failure(); }
  }
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
