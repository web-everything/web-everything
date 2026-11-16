/** S2 shadow auto-tune IO shell. Bound ONLY in run.mjs: the read-only declaring module must reach no effects (#3036). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDeliveryCapacity } from '../lib/delivery-capacity.mjs';
import { execFileSync } from 'node:child_process';
import { shadowTune, buildResourceRows } from '../lib/delivery-capacity-tune.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { createAgentActivityReader } from './agent-activity-io.mjs';
import { collectHeavyQueue } from './heavy-queue-io.mjs';
import { assessHeavyQueue } from './heavy-queue.mjs';
import { admissionLockRoot } from '../readiness/heavy-admission.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ghRepoSlug, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';

const TAIL_BYTES = 2 * 1024 * 1024;
const tailLines = (io, file) => {
  const size = io.statSync(file).size;
  const fd = io.openSync(file, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(len);
    io.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    return size > len ? lines.slice(1) : lines; // drop the cut first line
  } finally { io.closeSync(fd); }
};

/** One read per source per tick (never per PR); each failure marks only its own source unreadable. */
export function readResourceSources({ coordinationRoot = resolveCoordinationRoot, io = fs, run = execFileSync,
  readAgents = createAgentActivityReader, heavyQueue = () => assessHeavyQueue(collectHeavyQueue()) } = {}) {
  const attempt = fn => { try { return { ok: true, ...fn() }; } catch { return { ok: false }; } };
  const leases = attempt(() => {
    const status = JSON.parse(run(process.execPath, [fileURLToPath(new URL('../lane-pool.mjs', import.meta.url)), 'status', '--json', '--leased-only'],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!Array.isArray(status?.lanes)) throw new Error('lane status unreadable');
    return { leases: status.lanes.filter(l => l?.lease).map(l => l.lease), laneCount: status.lanes.length };
  });
  return {
    leases,
    // The activity reader swallows lease-read errors, so hand it the strict lease read: no silent zero.
    agents: attempt(() => {
      if (!leases.ok) throw new Error('leases unreadable');
      return { rows: readAgents({ readLeases: () => leases.leases })({}).rows };
    }),
    heavy: attempt(() => {
      const dir = admissionLockRoot(process.cwd(), process.env);
      const records = tailLines(io, path.join(dir, 'durations.jsonl')).flatMap(line => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line)]; } catch { throw new Error('malformed duration record'); }
      });
      return { records, waitMin: heavyQueue().projectedWaitMinutesForNewJob };
    }),
    rebases: attempt(() => ({ events: tailLines(io, path.join(coordinationRoot(), '..', 'logs', 'pr-merge-watch.log')).flatMap(line => {
      const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\b.*\brebas\w*.*#(\d+)/i.exec(line);
      return m ? [{ tsMs: Date.parse(m[1]), number: Number(m[2]) }] : [];
    }) })),
  };
}

const readOpenPrsDefault = () => readSharedOpenPrs({ repo: ghRepoSlug(DEFAULT_REPO_KEY), fields: 'number,headRefName' });

/** Bounded IO shell; injected readers make journal and GitHub failures hermetic. */
export function createDeliveryCapacityTune({
  resolvePolicy = resolveDeliveryCapacity, coordinationRoot = resolveCoordinationRoot,
  io = fs, exec = execFileSyncThrottled, now = Date.now,
  readOpenPrs = readOpenPrsDefault, readSources = readResourceSources,
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
          if (!line.trim()) return [];
          // A torn or foreign row could hide the last adjustment and bypass cooldown: fail closed.
          let row;
          try { row = JSON.parse(line); } catch { throw new Error('malformed journal row'); }
          if (!row || typeof row !== 'object' || Array.isArray(row)
            || row.schema !== 'deliveryCapacity.tune.v1' || typeof row.changed !== 'boolean'
            || !Number.isFinite(row.from) || row.changed !== (row.to !== row.from)
            || !['raise', 'lower', 'hold'].includes(row.action) || (row.action === 'hold') === row.changed
            || !Number.isFinite(row.to) || !Number.isFinite(row.tsMs)) throw new Error('malformed journal row');
          return [row];
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
          // A partial timeline understates hold time and rounds: keep the PR but flag it so raises are blocked.
          const partial = timeline.pageInfo?.hasNextPage !== false;
          const events = [];
          for (const event of timeline.nodes) {
            if (!['LabeledEvent', 'UnlabeledEvent'].includes(event?.__typename)
              || !Number.isFinite(Date.parse(event.createdAt)) || typeof event.label?.name !== 'string') return null;
            events.push({ at: event.createdAt, label: event.label.name,
              type: event.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled' });
          }
          merged.push({ number: pr.number, createdAt: pr.createdAt, mergedAt: pr.mergedAt, events, partial });
        }
        if (!result.pageInfo.hasNextPage) break;
        if (page === 9 || typeof result.pageInfo.endCursor !== 'string'
          || !result.pageInfo.endCursor || result.pageInfo.endCursor === cursor) return null;
        cursor = result.pageInfo.endCursor;
      }
      // Unreadable PR list or source leaves resources null: the tune then holds (fail closed).
      let resources = null;
      try {
        const openPrs = readOpenPrs();
        if (Array.isArray(openPrs)) resources = buildResourceRows({ openPrs, nowMs, sources: readSources({ coordinationRoot, io }) }).resources;
      } catch { resources = null; }
      const tuned = shadowTune({ readout, policy, merged, rows, nowMs, resources });
      if (!tuned) return null;
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.appendFileSync(file, `${JSON.stringify(tuned.row)}\n`, 'utf8');
      return tuned;
    } catch { return null; }
  };
}
