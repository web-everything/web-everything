/**
 * @file await-checks — block until one named check on a PR's CURRENT head completes.
 * The sanctioned worker-side CI wait (raw `gh pr checks --watch` stays refused by guard-bash, #x36vidg).
 * One harness-tracked process, one poll per >=60 s through the shared gh throttle, hard timeout.
 * Verdicts: pass | fail | head-moved | timeout | check-not-yet-created-timeout. One line on stdout.
 * A required check not created yet (e.g. the aggregate `test` while shards run) is pending, never not-found:
 * the wait runs to the deadline, then reports check-not-yet-created-timeout naming the checks that WERE seen.
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';
import { latestCheckNamed, requiredCheckReadNeeded, requiredCheckRunsEndpoint, mergeRequiredCheckRuns } from '../lib/rollup-collapse.mjs';

const MIN_POLL_MS = 60000;
const MAX_TIMEOUT_MIN = 120;
const USAGE = 'usage: run.mjs await-checks --pr=N --repo=owner/name --check=NAME [--timeoutMin=60]';
export const EXIT = { pass: 0, fail: 1, 'head-moved': 3, 'check-not-found': 4, timeout: 75, 'check-not-yet-created-timeout': 5 };

export function parseArgs(argv) {
  const o = { timeoutMin: 60 };
  for (const a of argv) {
    const m = /^--(pr|repo|check|timeoutMin)=(.+)$/.exec(a);
    if (!m) throw new Error(`unknown or malformed flag ${a}`);
    o[m[1]] = m[2];
  }
  if (!/^\d+$/.test(String(o.pr ?? '')) || Number(o.pr) < 1) throw new Error('--pr needs a positive integer');
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? '')) throw new Error('--repo needs owner/name');
  if (!o.check || /[\x00-\x1f\x7f]/.test(o.check)) throw new Error('--check needs a name');
  const t = Number(o.timeoutMin);
  if (!Number.isFinite(t) || t <= 0) throw new Error('--timeoutMin needs a positive number');
  return { pr: Number(o.pr), repo: o.repo, check: o.check, timeoutMin: Math.min(t, MAX_TIMEOUT_MIN) };
}

function defaultExec(file, args, { timeout = 60000, deadline, now, sleep, childExec = execFileSync } = {}) {
  const remaining = () => {
    const ms = Math.floor(deadline - now());
    if (ms <= 0) throw new Error('await-checks deadline exhausted');
    return ms;
  };
  const boundedOptions = (o) => ({
    ...o, maxBuffer: 4 * 1024 * 1024, timeout: Math.min(timeout, remaining()), killSignal: 'SIGKILL',
  });
  const boundedExec = (bin, a, o) => childExec(bin, a, boundedOptions(o));
  return execFileSyncThrottled(file, args, {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'],
    throttle: {
      maxAttempts: 1,
      execFileSync: childExec,
      // Credential discovery is a separate local subprocess in the throttle.
      // It must consume the same budget even when lookup failure falls back.
      personalTokenExec: boundedExec,
      // Admission and transient retries share the caller's monotonic deadline.
      sleep: (ms) => { sleep(Math.min(ms, remaining())); remaining(); },
      // Admission errors can fail open in the shared throttle, so check again at
      // the subprocess boundary, including retries and diagnostic budget reads.
      execOptions: boundedOptions,
    },
  });
}

/** Resolve superseded runs before interpreting the current check's state. */
function findCheck(rollup, name) {
  const c = latestCheckNamed(rollup, name);
  if (!c) return null;
  let state;
  if (c.__typename === 'StatusContext' || c.state !== undefined) {
    const s = String(c.state || '').toUpperCase();
    state = s === 'SUCCESS' ? 'pass' : (s === 'PENDING' || s === 'EXPECTED' || !s) ? 'running' : 'fail';
  } else if (String(c.status || '').toUpperCase() !== 'COMPLETED') state = 'running';
  else state = String(c.conclusion || '').toUpperCase() === 'SUCCESS' ? 'pass' : 'fail';
  return { state, url: c.detailsUrl || c.html_url || c.targetUrl || c.target_url || '' };
}

/** A capped or ambiguously ordered rollup can hide a newer legacy status. Read its full history
 * when REST has no CheckRun (the authoritative tier in the shared resolver). */
function completeCheckRollup(pr, opts, read) {
  const rollup = mergeRequiredCheckRuns(pr, opts.check,
    read(['api', requiredCheckRunsEndpoint(opts.repo, pr.headRefOid, opts.check), '--paginate', '--slurp']));
  if (latestCheckNamed(rollup, opts.check)?.__typename === 'CheckRun') return rollup;
  const pages = JSON.parse(read(['api', `repos/${opts.repo}/commits/${pr.headRefOid}/statuses?per_page=100`, '--paginate', '--slurp']));
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) {
    throw new Error('invalid commit-status response');
  }
  const statuses = pages.flat();
  if (statuses.some(c => !Number.isSafeInteger(c?.id) || c.id <= 0 || typeof c.context !== 'string' || typeof c.state !== 'string')) {
    throw new Error('invalid commit-status evidence');
  }
  return statuses.map(c => ({ ...c, __typename: 'StatusContext' }));
}

export function awaitChecks(opts, {
  exec = defaultExec,
  childExec = execFileSync,
  now = () => performance.now(),
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const pollMs = Math.max(opts.pollMs ?? MIN_POLL_MS, MIN_POLL_MS);
  const deadline = now() + opts.timeoutMin * 60000;
  let head = null;
  let seen = false;
  let lastUrl = '';
  let seenNames = [];
  const read = (args) => {
    if (now() >= deadline) throw new Error('await-checks deadline exhausted');
    const raw = exec('gh', args, {
      timeout: Math.max(1, Math.min(60000, Math.floor(deadline - now()))), deadline, now, sleep, childExec,
    });
    if (now() > deadline) throw new Error('await-checks deadline exhausted');
    return raw;
  };
  while (now() < deadline) {
    try {
      const raw = read(['pr', 'view', String(opts.pr), '--repo', opts.repo, '--json', 'headRefOid,url,statusCheckRollup']);
      const pr = JSON.parse(raw);
      const sha = typeof pr?.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(pr.headRefOid) ? pr.headRefOid : null;
      if (sha) {
        if (head && sha !== head) return { verdict: 'head-moved', head: sha, url: pr.url || lastUrl };
        head = sha;
        if (!Array.isArray(pr.statusCheckRollup)) throw new Error('invalid check rollup');
        seenNames = [...new Set(pr.statusCheckRollup.map(c => c?.name || c?.context).filter(n => typeof n === 'string'))];
        if (latestCheckNamed(pr.statusCheckRollup, opts.check)) seen = true;
        // Completion/start times do not establish creation order: overlapping
        // runs can finish out of order, and queued runs may have no start time.
        // Resolve duplicate ID-less results through REST's monotonic run IDs.
        const matches = pr.statusCheckRollup.filter(c => (c?.name || c?.context) === opts.check);
        const ambiguousOrder = matches.length > 1 && !matches.every(c => Number.isSafeInteger(c.id) && c.id > 0);
        const needsCompleteRead = ambiguousOrder || requiredCheckReadNeeded(pr, opts.check);
        const rollup = needsCompleteRead ? completeCheckRollup(pr, opts, read) : pr.statusCheckRollup;
        const c = findCheck(rollup, opts.check);
        if (c) {
          seen = true;
          lastUrl = c.url || pr.url || lastUrl;
          if (c.state !== 'running') {
            if (needsCompleteRead) {
              const current = JSON.parse(read(['pr', 'view', String(opts.pr), '--repo', opts.repo, '--json', 'headRefOid,url']));
              if (typeof current?.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(current.headRefOid)) throw new Error('invalid head recheck');
              if (current.headRefOid !== head) return { verdict: 'head-moved', head: current.headRefOid, url: current.url || lastUrl };
            }
            return { verdict: c.state, head, url: lastUrl };
          }
        }
      }
    } catch {
      // a failed or malformed read can never establish completion
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    // A final partial sleep uses the budget without starting a poll inside the 60 s floor.
    sleep(Math.min(pollMs, remainingMs));
  }
  if (seen || !head) return { verdict: 'timeout', head: head || 'unknown', url: lastUrl };
  return { verdict: 'check-not-yet-created-timeout', head, url: lastUrl, seenNames };
}

export function main(argv, { out = (t) => writeLineSync(1, t), ...io } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { out(`error: ${e.message}\n${USAGE}`); return 2; }
  const r = awaitChecks(opts, io);
  const names = r.seenNames?.length ? ` seen=${r.seenNames.join(',').replace(/[^\x20-\x7e]/g, '?')}` : '';
  out(`${r.verdict} ${r.head} ${r.url}${names}`.trimEnd());
  return EXIT[r.verdict];
}
