/** Shared raw Actions job-log transport. Callers retain their own throttle and output bounds. */
import { execFileSyncThrottled } from './gh-throttle.mjs';

/** Build argv for synchronous or asynchronous gh wrappers without changing log bytes. */
export function ciJobLogApiArgs(path) {
  return ['api', '--allow-escape-sequences', path];
}

/** Default bounds for a whole-job log read; a caller's opts override single keys, never drop the rest. */
export const CI_JOB_LOG_EXEC_OPTS = Object.freeze({ encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Read the whole job log (including passing steps); failures remain explicit evidence.
 * `exec(command, args, opts)` must forward `opts` to the child process: whole-job logs routinely exceed
 * Node's 1 MiB default maxBuffer, which would otherwise fail as ENOBUFS.
 */
export function readCiJobLog({ repo, jobId, path = `repos/${repo}/actions/jobs/${jobId}/logs`, exec = execFileSyncThrottled,
  opts = {} } = {}) {
  const success = value => ({ ok: true, text: String(value), filtered: false });
  const failure = error => ({ ok: false, reason: 'log-unreadable', detail: String(error?.message ?? error) });
  try {
    const value = exec('gh', ciJobLogApiArgs(path), { ...CI_JOB_LOG_EXEC_OPTS, ...opts });
    return value && typeof value.then === 'function' ? value.then(success, failure) : success(value);
  } catch (error) {
    return failure(error);
  }
}
