/**
 * @file await-checks — block until one named check on a PR's CURRENT head completes.
 * The sanctioned worker-side CI wait (raw `gh pr checks --watch` stays refused by guard-bash, #x36vidg).
 * One harness-tracked process, one poll per >=60 s through the shared gh throttle, hard timeout.
 * Verdicts: pass | fail | head-moved | timeout | check-not-found. One line on stdout.
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';

const MIN_POLL_MS = 60000;
const MAX_TIMEOUT_MIN = 120;
const USAGE = 'usage: run.mjs await-checks --pr=N --repo=owner/name --check=NAME [--timeoutMin=60]';
export const EXIT = { pass: 0, fail: 1, 'head-moved': 3, 'check-not-found': 4, timeout: 75 };

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

function defaultExec(file, args) {
  return execFileSyncThrottled(file, args, {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    throttle: { maxAttempts: 1, exec: (a, o) => execFileSync('gh', a, { ...o, maxBuffer: 4 * 1024 * 1024, timeout: 60000 }) },
  });
}

/** Pick the named check out of a statusCheckRollup. Returns {state:'running'|'pass'|'fail', url} or null. */
function findCheck(rollup, name) {
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (c?.name === name || c?.context === name) {
      const url = c.detailsUrl || c.targetUrl || '';
      if (c.__typename === 'StatusContext' || c.state !== undefined) {
        const s = String(c.state || '').toUpperCase();
        return { state: s === 'SUCCESS' ? 'pass' : (s === 'PENDING' || s === 'EXPECTED' || !s) ? 'running' : 'fail', url };
      }
      if (String(c.status || '').toUpperCase() !== 'COMPLETED') return { state: 'running', url };
      const k = String(c.conclusion || '').toUpperCase();
      return { state: k === 'SUCCESS' ? 'pass' : 'fail', url };
    }
  }
  return null;
}

export function awaitChecks(opts, {
  exec = defaultExec,
  now = () => performance.now(),
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const pollMs = Math.max(opts.pollMs ?? MIN_POLL_MS, MIN_POLL_MS);
  const deadline = now() + opts.timeoutMin * 60000;
  let head = null;
  let seen = false;
  let lastUrl = '';
  while (true) {
    try {
      const pr = JSON.parse(exec('gh', ['pr', 'view', String(opts.pr), '--repo', opts.repo, '--json', 'headRefOid,url,statusCheckRollup']));
      const sha = typeof pr?.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(pr.headRefOid) ? pr.headRefOid : null;
      if (sha) {
        if (head && sha !== head) return { verdict: 'head-moved', head: sha, url: pr.url || lastUrl };
        head = sha;
        const c = findCheck(pr.statusCheckRollup, opts.check);
        if (c) {
          seen = true;
          lastUrl = c.url || pr.url || lastUrl;
          if (c.state !== 'running') return { verdict: c.state, head, url: lastUrl };
        }
      }
    } catch {
      // a failed or malformed read can never establish completion
    }
    if (now() + pollMs > deadline) break;
    sleep(pollMs);
  }
  return { verdict: seen || !head ? 'timeout' : 'check-not-found', head: head || 'unknown', url: lastUrl };
}

export function main(argv, { out = (t) => writeLineSync(1, t), ...io } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { out(`error: ${e.message}\n${USAGE}`); return 2; }
  const r = awaitChecks(opts, io);
  out(`${r.verdict} ${r.head} ${r.url}`.trimEnd());
  return EXIT[r.verdict];
}
