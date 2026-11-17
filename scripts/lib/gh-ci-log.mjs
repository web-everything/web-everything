/** Shared raw Actions job-log transport. Callers retain their own throttle and output bounds. */
import { execFileSyncThrottled } from './gh-throttle.mjs';

/** Build argv for synchronous or asynchronous gh wrappers without changing log bytes. */
export function ciJobLogApiArgs(path) {
  return ['api', '--allow-escape-sequences', path];
}

/** Read a job log using an injected sync or async exec; failures remain explicit evidence. */
export function readCiJobLog({ repo, jobId, path = `repos/${repo}/actions/jobs/${jobId}/logs`, exec = execFileSyncThrottled,
  opts = { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] } } = {}) {
  const success = value => ({ ok: true, text: String(value) });
  const failure = error => ({ ok: false, reason: 'log-unreadable', detail: String(error?.message ?? error) });
  try {
    const value = exec('gh', ciJobLogApiArgs(path), opts);
    return value && typeof value.then === 'function' ? value.then(success, failure) : success(value);
  } catch (error) {
    return failure(error);
  }
}
