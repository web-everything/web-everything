/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { scorecardOperationSnapshot, snapshotStoreRecords } from './scorecard-operation-snapshot.mjs';
import { readSavedRedTeamResult, attemptedRedTeamRun, sameRepo } from './drain-saved-red-team.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor, redTeamPanelSeatOwed } from './review-red-team-policy.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';
import { readFilteredInOrder } from './stream-filter-runs.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
// Slugs and shas are case-insensitive: the writer and the drain must name one file whatever case each was handed.
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env),
  `${encodeURIComponent(String(repo).toLowerCase())}-${Number(pr)}-${String(head).toLowerCase()}.json`);

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
  readScorecards } = {}) {
  const legacyStatusPath = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);
  head = String(head ?? '').toLowerCase();
  // One scorecard read for this whole call, shared with the saved-result check below (xwu9oxh S2, per operation).
  // An injected reader keeps the saved-result check on its own fresh read, as before.
  const scorecardSnapshot = readScorecards === undefined ? scorecardOperationSnapshot(resolveScorecardStorePath(env)) : undefined;
  const rows = readScorecards === undefined ? snapshotStoreRecords(scorecardSnapshot) : readScorecards();
  const recorded = rows.some(row => row?.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head);
  let attempted = attemptedRedTeamRun(rows, { repo, pr, head });
  // Saved-result usability is independent of historical scorecard attempts.
  const noSavedResult = readSavedRedTeamResult({ repo, pr, head, env, runsDir, scorecardSnapshot }) === null;
  const withUsability = evidence => ({ ...evidence, noUsableResult: noSavedResult && !evidence.inFlight && !evidence.queued });
  const untrustedSavedResult = rows.some(row => row?.status === 'ok' && row?.dispatchKind === 'review-seat'
    && row.seat === 'red-team' && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && row.rev === head)
    && noSavedResult;
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const latestRun = () => {
    // Read, test and drop one run at a time (xwu9oxh S1a): same reads, order and errors as map-then-filter.
    const hits = readFilteredInOrder(list(runsDir).filter(id => id.startsWith('review-pr-')), id => read(id, runsDir),
      run => run?.op === 'review-pr' && sameRepo(run.input?.repo, repo) && Number(run.input?.pr) === Number(pr)
        && String(run.findings?.read?.netBasis?.rev ?? '').toLowerCase() === head, (run, id) => ({ id, run }))
      .map(hit => ({ ...hit, at: statSync(join(runsDir, `${hit.id}.json`)).mtimeMs }));
    hits.sort((a, b) => b.at - a.at);
    return { run: hits[0]?.run ?? null, at: hits[0]?.at ?? 0 };
  };
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const owes = run => (redTeamPanelSeatOwed(run, env) || (redTeamEnabled(env) && redTeamOwedFor(run)));
  let status, statusAt = 0;
  // Keep pre-normalization status records authoritative during the transition too.
  for (const path of new Set([statusPath({ repo, pr, head }, env), legacyStatusPath])) {
    try {
      const candidate = JSON.parse(readFileSync(path, 'utf8'));
      const at = statSync(path).mtimeMs;
      if (!status || at > statusAt) { status = candidate; statusAt = at; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (sameRepo(status?.repo, repo) && Number(status.pr) === Number(pr) && String(status.head ?? '').toLowerCase() === head) {
    attempted ||= attemptedRedTeamRun([], { repo, pr, head }, status.result);
    // A finished status from an earlier review of this same head never supersedes a newer accepting run (a re-review
    // of an unchanged head labels its accept before its job writes `queued`).
    if (!['queued', 'running'].includes(status.status)) {
      const latest = latestRun();
      if (latest.at > statusAt && owes(latest.run)) return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload: latest.run, inFlight: false, scheduled: true, recorded, attempted, skipCardOnly: false });
    }
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
    const resultStatus = typeof status.result === 'string' ? status.result : status.result?.status;
    return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload: status.loopPayload, inFlight: live && status.status === 'running', ...(live && status.status === 'queued' ? { queued: true } : {}),
      ...(typeof status.skipCardOnly === 'boolean' ? { skipCardOnly: status.skipCardOnly } : {}), scheduled: redTeamPanelSeatOwed(status.loopPayload, env) || ['queued', 'running'].includes(status.status) || ['ran', 'error'].includes(resultStatus),
      recorded: recorded || resultStatus === 'ran',
      // A pass whose job died while running started and left no usable result, like one that errored.
      attempted: attemptedRedTeamRun(rows, { repo, pr, head }, status.result) || (status.status === 'running' && !live) });
  }
  const loopPayload = latestRun().run;
  // An owing run with no job status yet: only the job's process knows its card-only skip decision, so hold the head
  // (skip off) until that status records it (main's guard, kept). A recorded or started pass still holds.
  // A pass that already ran (even unusably) is scheduled, never "never scheduled".
  const ran = attempted || attemptedRedTeamRun([], { repo, pr, head }, loopPayload?.redTeam);
  return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload, inFlight: false, scheduled: recorded || ran || owes(loopPayload),
    recorded, attempted: ran, ...(owes(loopPayload) ? { skipCardOnly: false } : {}) });
}
