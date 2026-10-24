/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { readFilteredInOrder } from './stream-filter-runs.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor } from './review-red-team-policy.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

/** Read the head-bound status; unreadable evidence is an error, absence is null. */
export function readRedTeamStatus({ repo, pr, head, env = process.env } = {}) {
  try {
    const status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8'));
    if (!status || status.repo !== repo || Number(status.pr) !== Number(pr) || status.head !== head) throw Error('red-team status identity mismatch');
    return status;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** A status is written before settling speculation or starting the sequential pass; crashes leave a dead pid. */
export function recordRedTeamStatus({ repo, pr, loopPayload, status, result = null }, { env = process.env, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime } = {}) {
  const head = loopPayload?.findings?.read?.netBasis?.rev;
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) return;
  const path = statusPath({ repo, pr, head }, env);
  mkdirSync(dirname(path), { recursive: true });
  // The writer's own card-only skip decision: the drain may resolve a different setting in its own process.
  writeJsonAtomic(path, { repo, pr, head, loopPayload, status, result, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly,
    pid: process.pid, host, pidNamespace: namespace, pidStart: readPidStart(process.pid) });
}

/** Absence of a review payload is not an accept. Labels alone never schedule a post-accept pass. */
export function readDrainRedTeamEvidence({ repo, pr, head, env = process.env,
  runsDir = resolveRunsDir(), list = listRunIds, read = readRun, isAlive = pidAlive, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime,
  readScorecards = () => readStore({ path: resolveScorecardStorePath(env) }).records } = {}) {
  const recorded = readScorecards().some(row => row.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && row.repo === repo && Number(row.pr) === Number(pr) && row.rev === head);
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const latestRun = () => {
    // Read, test and drop one run at a time (xwu9oxh S1a): same reads, order and errors as map-then-filter.
    const hits = readFilteredInOrder(list(runsDir).filter(id => id.startsWith('review-pr-')), id => read(id, runsDir),
      run => run?.op === 'review-pr' && run.input?.repo === repo && Number(run.input?.pr) === Number(pr)
        && run.findings?.read?.netBasis?.rev === head, (run, id) => ({ id, run }))
      .map(hit => ({ ...hit, at: statSync(join(runsDir, `${hit.id}.json`)).mtimeMs }));
    hits.sort((a, b) => b.at - a.at);
    return { run: hits[0]?.run ?? null, at: hits[0]?.at ?? 0 };
  };
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const owes = run => redTeamEnabled(env) && redTeamOwedFor(run);
  let status, statusAt = 0;
  try {
    status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8'));
    statusAt = statSync(statusPath({ repo, pr, head }, env)).mtimeMs;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (status?.repo === repo && Number(status.pr) === Number(pr) && status.head === head) {
    // A finished status from an earlier review of this same head never supersedes a newer accepting run (a re-review
    // of an unchanged head labels its accept before its job writes `queued`).
    if (!['queued', 'running'].includes(status.status)) {
      const latest = latestRun();
      if (latest.at > statusAt && owes(latest.run)) return { loopPayload: latest.run, inFlight: false, scheduled: true, recorded, skipCardOnly: false };
    }
    // A local pid probe says nothing about another host or namespace: keep that pass held for its result.
    // For local records, a changed birth time proves pid reuse. An unavailable birth time is unknown,
    // so preserve the conservative liveness probe (also supports records written before this field).
    // A queued pass is a live queue entry only while the job that queued it is alive (the same probe).
    // The result is the bare status string or the compact result object that carries it.
    const resultStatus = typeof status.result === 'string' ? status.result : status.result?.status;
    let live = false;
    if (['queued', 'running'].includes(status.status)) {
      if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) live = true;
      else if (isAlive(status.pid)) {
        const start = status.pidStart ? readPidStart(status.pid) : null;
        live = !start || !status.pidStart || start === status.pidStart;
      }
    }
    return { status, loopPayload: status.loopPayload, inFlight: live && status.status === 'running', ...(live && status.status === 'queued' ? { queued: true } : {}),
      ...(typeof status.skipCardOnly === 'boolean' ? { skipCardOnly: status.skipCardOnly } : {}), scheduled: ['queued', 'running'].includes(status.status) || ['ran', 'error'].includes(resultStatus), recorded: recorded || resultStatus === 'ran' };
  }
  const loopPayload = latestRun().run;
  // An owing run with no job status yet: only the job's process knows its card-only skip decision, so hold the head
  // (skip off) until that status records it. The never-scheduled deadline still applies if no job ever writes one.
  return { loopPayload, inFlight: false, scheduled: recorded || owes(loopPayload), recorded, ...(owes(loopPayload) ? { skipCardOnly: false } : {}) };
}
