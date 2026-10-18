/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { recordedRedTeamResult } from './drain-saved-red-team.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';

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
  const rows = readScorecards();
  const recorded = recordedRedTeamResult(rows, { repo, pr, head });
  let status;
  try { status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (status?.repo === repo && Number(status.pr) === Number(pr) && status.head === head) {
    // A local pid probe says nothing about another host or namespace: keep that pass held for its result.
    // For local records, a changed birth time proves pid reuse. An unavailable birth time is unknown,
    // so preserve the conservative liveness probe (also supports records written before this field).
    let inFlight = false;
    if (status.status === 'running') {
      if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) inFlight = true;
      else if (isAlive(status.pid)) {
        const start = status.pidStart ? readPidStart(status.pid) : null;
        inFlight = !start || !status.pidStart || start === status.pidStart;
      }
    }
    return { loopPayload: status.loopPayload, inFlight, recorded: recordedRedTeamResult(rows, { repo, pr, head }, status.result) };
  }
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const hits = list(runsDir).filter(id => id.startsWith('review-pr-')).map(id => ({ id, run: read(id, runsDir) }))
    .filter(({ run }) => run?.op === 'review-pr' && run.input?.repo === repo && Number(run.input?.pr) === Number(pr)
      && run.findings?.read?.netBasis?.rev === head);
  hits.sort((a, b) => statSync(join(runsDir, `${b.id}.json`)).mtimeMs - statSync(join(runsDir, `${a.id}.json`)).mtimeMs);
  return { loopPayload: hits[0]?.run ?? null, inFlight: false, recorded: recorded || recordedRedTeamResult([], { repo, pr, head }, hits[0]?.run?.redTeam) };
}
