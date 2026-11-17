/** Shared raw Actions job-log transport. Callers retain their own throttle and output bounds. */
import { execFileSyncThrottled } from './gh-throttle.mjs';

/** Build argv for synchronous or asynchronous gh wrappers without changing log bytes. */
export function ciJobLogApiArgs(path) {
  return ['api', '--allow-escape-sequences', path];
}

/** Keep failed-step intervals, including untimestamped continuations, without changing retained bytes.
 * Any unusable failed-step interval falls back to the whole log with filtered:false.
 * Finding producers must require filtered:true; context readers may use either result.
 */
export function failedStepsLog(job, rawLog) {
  const log = String(rawLog);
  const intervals = (Array.isArray(job?.steps) ? job.steps : [])
    .filter(step => step?.conclusion === 'failure')
    .map(step => [Date.parse(step.started_at), Date.parse(step.completed_at)]);
  if (!intervals.length || intervals.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end) || start > end)) return { text: log, filtered: false };
  let keep = false;
  const text = log.split(/(?<=\n)/).filter(line => {
    const match = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))(?=\s|$)/.exec(line);
    if (match) {
      const at = Date.parse(match[1]);
      keep = intervals.some(([start, end]) => at >= start && at <= end);
    }
    return keep;
  }).join('');
  return { text, filtered: true };
}

/** Read a job log using an injected sync or async exec; failures remain explicit evidence. */
export function readCiJobLog({ repo, jobId, path = `repos/${repo}/actions/jobs/${jobId}/logs`, exec = execFileSyncThrottled,
  job, failedOnly = false,
  opts = { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] } } = {}) {
  const success = value => ({ ok: true, ...(failedOnly ? failedStepsLog(job, value) : { text: String(value), filtered: false }) });
  const failure = error => ({ ok: false, reason: 'log-unreadable', detail: String(error?.message ?? error) });
  try {
    const value = exec('gh', ciJobLogApiArgs(path), opts);
    return value && typeof value.then === 'function' ? value.then(success, failure) : success(value);
  } catch (error) {
    return failure(error);
  }
}
