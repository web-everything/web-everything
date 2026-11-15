/** S2 shadow auto-tune IO shell. Bound ONLY in run.mjs: the read-only declaring module must reach no effects (#3036). */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDeliveryCapacity } from '../lib/delivery-capacity.mjs';
import { shadowTune } from '../lib/delivery-capacity-tune.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ghRepoSlug, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';

/** Bounded IO shell; injected readers make journal and GitHub failures hermetic. */
export function createDeliveryCapacityTune({
  resolvePolicy = resolveDeliveryCapacity, coordinationRoot = resolveCoordinationRoot,
  io = fs, exec = execFileSyncThrottled, now = Date.now,
} = {}) {
  return readout => {
    try {
      const policy = resolvePolicy().value;
      if (policy.autoTune.mode === 'off') return null;
      const nowMs = now();
      const file = path.join(coordinationRoot(), 'delivery-capacity-tune.jsonl');
      let rows = [];
      try {
        // An oversized journal needs operator rotation; leave the readout alone.
        if (io.statSync(file).size > 8 * 1024 * 1024) return null;
        rows = io.readFileSync(file, 'utf8').split('\n').flatMap(line => {
          try {
            const row = JSON.parse(line);
            return row && typeof row === 'object' && !Array.isArray(row)
              && Number.isFinite(row.to) && Number.isFinite(row.tsMs) ? [row] : [];
          } catch { return []; }
        });
        // Keep the latest adjustment even after frequent holds fill the recent tail.
        const lastChange = rows.findLast(row => row.changed === true);
        rows = rows.slice(-200);
        if (lastChange && !rows.includes(lastChange)) rows.unshift(lastChange);
      } catch (error) { if (error?.code !== 'ENOENT') return null; }
      const since = new Date(nowMs - policy.autoTune.windowH * 3600000).toISOString();
      const search = `repo:${ghRepoSlug(DEFAULT_REPO_KEY)} is:pr is:merged merged:>=${since}`;
      const query = `query($search:String!,$cursor:String) {
        search(query:$search,type:ISSUE,first:50,after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest { number createdAt mergedAt
            timelineItems(first:100,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]) {
              pageInfo { hasNextPage }
              nodes { __typename ... on LabeledEvent { createdAt label { name } }
                ... on UnlabeledEvent { createdAt label { name } } }
            }
          } }
        }
      }`;
      const merged = [];
      let cursor;
      for (let page = 0; page < 10; page++) {
        const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `search=${search}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : [])];
        const response = JSON.parse(exec('gh', args, {
          encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
        const result = response?.data?.search;
        if (response.errors?.length || !Array.isArray(result?.nodes)
          || typeof result.pageInfo?.hasNextPage !== 'boolean') return null;
        for (const pr of result.nodes) {
          const timeline = pr?.timelineItems;
          if (!Number.isInteger(pr?.number) || !Number.isFinite(Date.parse(pr.createdAt))
            || !Number.isFinite(Date.parse(pr.mergedAt)) || !Array.isArray(timeline?.nodes)) return null;
          // A partial timeline cannot prove hold durations or review rounds: leave that PR out of the sample.
          if (timeline.pageInfo?.hasNextPage !== false) continue;
          const events = [];
          for (const event of timeline.nodes) {
            if (!['LabeledEvent', 'UnlabeledEvent'].includes(event?.__typename)
              || !Number.isFinite(Date.parse(event.createdAt)) || typeof event.label?.name !== 'string') return null;
            events.push({ at: event.createdAt, label: event.label.name,
              type: event.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled' });
          }
          merged.push({ number: pr.number, createdAt: pr.createdAt, mergedAt: pr.mergedAt, events });
        }
        if (!result.pageInfo.hasNextPage) break;
        if (page === 9 || typeof result.pageInfo.endCursor !== 'string'
          || !result.pageInfo.endCursor || result.pageInfo.endCursor === cursor) return null;
        cursor = result.pageInfo.endCursor;
      }
      const tuned = shadowTune({ readout, policy, merged, rows, nowMs });
      if (!tuned) return null;
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.appendFileSync(file, `${JSON.stringify(tuned.row)}\n`, 'utf8');
      return tuned;
    } catch { return null; }
  };
}
