/** Pure remote verification decisions; network, clock and timers belong to the caller. */
import { verifyStartBody, verifyFinishBody } from './lane-verify.mjs';

const fullSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);
const sameSha = (a, b) => fullSha(a) && fullSha(b) && a.toLowerCase() === b.toLowerCase();
export const MAX_REMOTE_WAIT_MS = 540000;

export function selectRemoteVerifyRun(runs, sha) {
  if (!Array.isArray(runs) || !fullSha(sha)) return null;
  return runs.filter((run) => sameSha(run?.head_sha, sha))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null;
}

export function remoteVerdict(run) {
  if (run === null) return { state: 'absent' };
  if (run?.status === 'completed') {
    return run.conclusion === 'success' ? { state: 'green' } : { state: 'red', conclusion: run.conclusion };
  }
  if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run?.status)) return { state: 'pending' };
  return { state: 'error' };
}

export function buildRemoteMarker({ sha, treeHash, run, now }) {
  if (remoteVerdict(run).state !== 'green' || !sameSha(run?.head_sha, sha)
    || typeof treeHash !== 'string' || !treeHash.trim() || !Number.isSafeInteger(run?.id) || run.id <= 0) {
    throw new Error('Remote marker requires a successful exact-head run and a tree hash');
  }
  const instant = new Date(now()).toISOString();
  return {
    ...verifyFinishBody(verifyStartBody({ sha, treeHash, suites: `remote-verify:${run.id}`, startedAt: instant }),
      { finishedAt: instant, exitCode: 0, sha, treeHash }),
    remote: { runId: run.id, url: run.html_url },
  };
}

/** Import only a successful attempt whose job proves the required gate actually ran. */
export async function recordRemoteVerification({ sha, treeHash, run, fetchJobs, fetchRuns, treeUnchanged, writeMarker, now }) {
  if (remoteVerdict(run).state !== 'green' || !sameSha(run?.head_sha, sha)
    || !Number.isSafeInteger(run?.id) || run.id <= 0
    || !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0) {
    throw new Error('Missing successful run attempt evidence; use local verify');
  }
  const jobs = await fetchJobs(run);
  if (!Array.isArray(jobs)) throw new Error('Unreadable remote jobs; use local verify');
  const gateJobs = jobs.filter((job) => job?.name === 'verify');
  const job = gateJobs[0];
  if (gateJobs.length !== 1 || job.run_id !== run.id || !sameSha(job.head_sha, sha)
    || job.status !== 'completed' || job.conclusion !== 'success' || !Array.isArray(job.steps)
    || !job.steps.some((step) => step.name === 'Required lane gate'
      && step.status === 'completed' && step.conclusion === 'success')) {
    throw new Error('Run did not prove the required lane gate; use local verify');
  }
  const runs = await fetchRuns();
  if (!readableRuns(runs)) throw new Error('Unreadable final workflow runs; retry remote or use local verify');
  const newest = selectRemoteVerifyRun(runs, sha);
  if (newest?.id !== run.id || newest?.run_attempt !== run.run_attempt || remoteVerdict(newest).state !== 'green') {
    throw new Error('Remote run changed after job verification; retry remote or use local verify');
  }
  if (!treeUnchanged()) throw new Error('HEAD or tree changed during remote verification');
  const marker = buildRemoteMarker({ sha, treeHash, run, now });
  writeMarker(marker);
  return marker;
}

const readableRuns = (runs) => Array.isArray(runs) && runs.every((r) => fullSha(r?.head_sha)
  && Number.isFinite(Date.parse(r.created_at)) && Number.isSafeInteger(r.id) && r.id > 0);

export async function waitForRemoteVerify({ fetchRuns, sha, waitMs = 0, pollMs = 5000, now, sleep }) {
  let run = null;
  try {
    if (!fullSha(sha) || !Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw new Error('Invalid remote verification bounds');
    }
    const deadline = now() + Math.min(waitMs, MAX_REMOTE_WAIT_MS);
    for (;;) {
      const runs = await fetchRuns();
      if (!readableRuns(runs)) {
        throw new Error('Unreadable workflow run evidence');
      }
      run = selectRemoteVerifyRun(runs, sha);
      const { state } = remoteVerdict(run);
      if (state === 'green' || state === 'red' || state === 'error') return { ok: state === 'green', state, run };
      const remaining = deadline - now();
      if (remaining <= 0) return { ok: false, state: 'timeout', run };
      await sleep(Math.min(pollMs, remaining));
    }
  } catch {
    return { ok: false, state: 'error', run };
  }
}
