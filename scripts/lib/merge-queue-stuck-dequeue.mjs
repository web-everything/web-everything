/** Bounded queue diagnostics and confirmed removal of stuck entries. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { graphql } from './merge-queue-adaptive-batching.mjs';
import { dequeueSentBack } from './drain-queue-safety.mjs';

const errorText = e => String(e?.message ?? e).split('\n')[0];
const validEntry = e => Number.isSafeInteger(e?.num) && e.num > 0
  && typeof e.state === 'string' && e.state.length > 0
  && (e.groupOid === null || typeof e.groupOid === 'string' && /^[a-f0-9]{40}$/i.test(e.groupOid));

export function readQueueEntryStates({ repo, exec = execFileSync }) {
  try {
    const [owner, name] = repo.split('/');
    const data = graphql(exec, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries(first:100){pageInfo{hasNextPage} nodes{state enqueuedAt headCommit{oid statusCheckRollup{state}} checks: headCommit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name conclusion} ... on StatusContext{context state}}}}} pullRequest{number}}}}}}', [`owner=${owner}`, `name=${name}`]);
    const page = data.repository?.mergeQueue?.entries;
    if (!Array.isArray(page?.nodes) || page.nodes.length > 100 || page.pageInfo?.hasNextPage !== false)
      throw new Error('merge queue unreadable or exceeds 100 entries; retry next pass or inspect the queue manually');
    const entries = page.nodes.map(n => ({ num: n?.pullRequest?.number, state: n?.state,
      enqueuedAt: n?.enqueuedAt, groupOid: n?.headCommit === null ? null : n?.headCommit?.oid ?? undefined, ci: n?.headCommit?.statusCheckRollup?.state,
      ...(n?.checks?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage === false
        && Array.isArray(n?.checks?.statusCheckRollup?.contexts?.nodes)
        && n.checks.statusCheckRollup.contexts.nodes.length <= 100 ? {
        failedChecks: n.checks.statusCheckRollup.contexts.nodes.flatMap(check =>
          check?.__typename === 'CheckRun' && ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(check.conclusion) ? [check.name]
            : check?.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(check.state) ? [check.context] : []),
      } : {}) }));
    if (!entries.every(validEntry) || new Set(entries.map(e => e.num)).size !== entries.length)
      throw new Error('invalid merge queue entry; retry next pass');
    return { entries };
  } catch (e) { return { entries: [], error: errorText(e) }; }
}

export function describeBlocker(entry, nowMs = Date.now()) {
  const age = nowMs - Date.parse(entry?.enqueuedAt);
  return `#${entry?.num ?? 'unknown'} in queue ${Number.isFinite(age) && age >= 0 ? Math.floor(age / 60_000) : 'unknown'} min, state ${entry?.state || 'unknown'}, CI ${entry?.ci || 'unknown'}`;
}

export function decideStuckDequeues({ entries, tracker, max, nowMs = Date.now() }) {
  if (!Number.isSafeInteger(max) || max < 1 || !Array.isArray(entries) || !entries.every(validEntry))
    return { dequeue: [], tracker: {} };
  const next = {};
  const dequeue = [];
  for (const entry of entries) {
    // A null group commit cannot prove a rebuild. Unknown enqueue identity cannot inherit history.
    const trackable = typeof entry.groupOid === 'string' && typeof entry.enqueuedAt === 'string'
      && Number.isFinite(Date.parse(entry.enqueuedAt));
    const previous = tracker?.[entry.num];
    // Compare enqueue identity by instant, so equivalent spellings (`…:00Z` / `…:00.000Z`) stay one entry.
    const validPrevious = trackable && typeof previous?.enqueuedAt === 'string'
      && Date.parse(previous.enqueuedAt) === Date.parse(entry.enqueuedAt)
      && typeof previous?.oid === 'string' && /^[a-f0-9]{40}$/i.test(previous.oid)
      && Number.isSafeInteger(previous.count) && previous.count >= 0 && previous.count < Number.MAX_SAFE_INTEGER;
    const count = validPrevious ? previous.count + (previous.oid !== entry.groupOid ? 1 : 0) : 0;
    const fails = validPrevious && Array.isArray(previous.fails)
      ? [...new Set(previous.fails.filter(oid => typeof oid === 'string' && /^[a-f0-9]{40}$/i.test(oid)))].slice(-5) : [];
    const standardsFailing = entry.state !== 'MERGEABLE' && entry.ci === 'FAILURE' && entry.failedChecks?.includes('standards');
    if (standardsFailing && trackable && !fails.includes(entry.groupOid)) {
      fails.push(entry.groupOid);
      if (fails.length > 5) fails.shift();
    }
    if (trackable) next[entry.num] = { oid: entry.groupOid, count, enqueuedAt: entry.enqueuedAt, ...(fails.length ? { fails } : {}) };
    const kind = entry.state === 'UNMERGEABLE' ? 'unmergeable'
      : standardsFailing && fails.length >= 2 ? 'standards-failed-twice'
      : entry.state === 'AWAITING_CHECKS' && count >= max ? 'rebuilds' : null;
    if (kind) dequeue.push({ num: entry.num, kind, reason: `${describeBlocker(entry, nowMs)}${kind === 'standards-failed-twice' ? `; standards job failed on ${fails.length} distinct group commits` : kind === 'rebuilds' ? `; group rebuilt ${count} times (max ${max})` : ''}` });
  }
  return { dequeue, tracker: next };
}

function writeTracker(path, json) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, path);
}

export function sweepStuckEntries({ repo, exec = execFileSync, max, nowMs = Date.now(), statePath,
  readFile = readFileSync, writeFile = writeTracker, emit = () => {}, log = () => {}, dryRun = false,
  queue = readQueueEntryStates({ repo, exec }) }) {
  if (queue.error) {
    log(`⚠ merge-queue stuck-entry read failed (${queue.error}) — retry next pass`);
    return { dequeued: [], error: queue.error };
  }
  let tracker = {};
  try { tracker = JSON.parse(readFile(statePath, 'utf8')); } catch { /* Missing/corrupt history starts at zero. */ }
  const decision = decideStuckDequeues({ entries: queue.entries, tracker, max, nowMs });
  if (dryRun) {
    for (const d of decision.dequeue) log(`merge-queue: would dequeue ${d.reason}`);
    return { dequeued: [] };
  }
  try { writeFile(statePath, `${JSON.stringify(decision.tracker)}\n`); }
  catch (e) {
    log(`⚠ merge-queue tracker write failed (${errorText(e)}) — retry next pass`);
    return { dequeued: [], error: errorText(e) };
  }
  const dequeued = [];
  for (const d of decision.dequeue) {
    try {
      if (!dequeueSentBack({ repo, pr: d.num, reason: d.reason, exec, log }).dequeued) continue;
      dequeued.push(d.num);
      const event = { kind: 'queue-entry-dequeued', repo, pr: d.num,
        detail: { reason: d.reason, state: queue.entries.find(e => e.num === d.num).state, kind: d.kind } };
      try { Promise.resolve(emit(event)).catch(() => {}); } catch { /* Events are best effort. */ }
    } catch (e) { log(`⚠ merge-queue dequeue #${d.num} failed (${errorText(e)}) — retry next pass`); }
  }
  if (dequeued.length) { // a PR that re-enters the queue must not inherit the rebuild count that got it removed
    for (const num of dequeued) delete decision.tracker[num];
    try { writeFile(statePath, `${JSON.stringify(decision.tracker)}\n`); } catch { /* next pass rewrites it */ }
  }
  return { dequeued };
}
