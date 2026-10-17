/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor } from './review-red-team-policy.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

/** A status is written before settling speculation or starting the sequential pass; crashes leave a dead pid. */
export function recordRedTeamStatus({ repo, pr, loopPayload, status, result = null }, { env = process.env, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime } = {}) {
  const head = loopPayload?.findings?.read?.netBasis?.rev;
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) return;
  const path = statusPath({ repo, pr, head }, env);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, { repo, pr, head, loopPayload, status, result, pid: process.pid, host, pidNamespace: namespace, pidStart: readPidStart(process.pid) });
}

/** Absence of a review payload is not an accept. Labels alone never schedule a post-accept pass. */
export function readDrainRedTeamEvidence({ repo, pr, head, env = process.env,
  runsDir = resolveRunsDir(), list = listRunIds, read = readRun, isAlive = pidAlive, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime,
  readScorecards = () => readStore({ path: resolveScorecardStorePath(env) }).records } = {}) {
  const recorded = readScorecards().some(row => row.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && row.repo === repo && Number(row.pr) === Number(pr) && row.rev === head);
  let status;
  try { status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (status?.repo === repo && Number(status.pr) === Number(pr) && status.head === head) {
    // A local pid probe says nothing about another host or namespace: keep that pass held for its result.
    // For local records, a changed birth time proves pid reuse. An unavailable birth time is unknown,
    // so preserve the conservative liveness probe (also supports records written before this field).
    // A queued pass is a live queue entry only while the job that queued it is alive (the same probe).
    let live = false;
    if (['queued', 'running'].includes(status.status)) {
      if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) live = true;
      else if (isAlive(status.pid)) {
        const start = status.pidStart ? readPidStart(status.pid) : null;
        live = !start || !status.pidStart || start === status.pidStart;
      }
    }
    return { loopPayload: status.loopPayload, inFlight: live && status.status === 'running', ...(live && status.status === 'queued' ? { queued: true } : {}), scheduled: ['queued', 'running'].includes(status.status) || ['ran', 'error'].includes(status.result), recorded: recorded || status.result === 'ran' };
  }
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const hits = list(runsDir).filter(id => id.startsWith('review-pr-')).map(id => ({ id, run: read(id, runsDir) }))
    .filter(({ run }) => run?.op === 'review-pr' && run.input?.repo === repo && Number(run.input?.pr) === Number(pr)
      && run.findings?.read?.netBasis?.rev === head);
  hits.sort((a, b) => statSync(join(runsDir, `${b.id}.json`)).mtimeMs - statSync(join(runsDir, `${a.id}.json`)).mtimeMs);
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const loopPayload = hits[0]?.run ?? null;
  return { loopPayload, inFlight: false, scheduled: recorded || (redTeamEnabled(env) && redTeamOwedFor(loopPayload)), recorded };
}
