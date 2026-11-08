/** Head-bound red-team evidence published by the WE GitHub App. */
import { runGhSync } from './gh-throttle.mjs';

const ioOptions = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const validHead = head => typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head);
const validApp = id => /^[1-9]\d*$/.test(String(id ?? '')) && Number.isSafeInteger(Number(id));
const failure = reason => ({ ok: false, reason });
const message = error => String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

export function evaluateRedTeamCheckFact({ headSha, checkRuns, appId } = {}) {
  if (!validApp(appId)) return failure('WE_APP_ID unset or invalid; configure the WE App repository variable');
  if (!validHead(headSha)) return failure('red-team head missing or invalid');
  if (!Array.isArray(checkRuns)) return failure('red-team check runs unreadable');
  const runs = checkRuns.filter(run => run?.name === 'red-team'
    && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === headSha.toLowerCase() && Number(run.app?.id) === Number(appId));
  if (runs.some(run => !Number.isSafeInteger(run.id) || run.id <= 0))
    return failure('red-team check run ordering unreadable; inspect check history');
  // GitHub run ids order creations, including reruns whose timestamps tie or are absent.
  runs.sort((a, b) => Number(b.id) - Number(a.id));
  const latest = runs[0];
  if (!latest) return failure('no red-team check run on head');
  if (latest.status !== 'completed') return failure('red-team check run in progress or incomplete');
  if (latest.conclusion !== 'success') return failure(`red-team check run failed (${latest.conclusion ?? 'unknown'})`);
  return { ok: true, reason: 'red-team check run succeeded on head' };
}

export function redTeamCheckRunPayload({ headSha, status, hold, sendBack = false } = {}) {
  const finished = status === 'finished';
  const clear = finished && hold === null && sendBack === false;
  return { name: 'red-team', head_sha: headSha, status: finished ? 'completed' : 'in_progress',
    ...(finished ? { conclusion: clear ? 'success' : 'failure' } : {}),
    output: { title: clear ? 'Red team clear' : finished ? 'Red team held' : 'Red team in progress',
      summary: String(hold ?? (sendBack ? 'Red team requires send-back' : clear ? 'Red team cleared this head' : 'Awaiting red-team completion')).slice(0, 60_000) } };
}

/** Publication is best effort; callers must persist local status before calling. */
export function postRedTeamCheckRun({ repo, headSha, payload, gh = runGhSync } = {}) {
  try {
    if (!validHead(headSha) || payload?.head_sha !== headSha || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Error('invalid red-team check identity');
    gh(['api', `repos/${repo}/check-runs`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify(payload) });
    return { ok: true };
  } catch (error) { return failure(`red-team check publication failed: ${message(error)}`); }
}

/** One bounded read; incomplete evidence needs operator inspection rather than a guessed pass. */
export function readRedTeamCheckFact({ repo, headSha, appId, gh = runGhSync } = {}) {
  if (!validApp(appId)) return failure('WE_APP_ID unset or invalid; configure the WE App repository variable');
  if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return failure('invalid red-team check identity');
  try {
    const data = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs?check_name=red-team&filter=all&per_page=100`], ioOptions));
    if (!Array.isArray(data?.check_runs) || data.check_runs.length > 100 || !Number.isSafeInteger(data.total_count) || data.total_count !== data.check_runs.length)
      return failure('red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history');
    return evaluateRedTeamCheckFact({ headSha, appId, checkRuns: data.check_runs });
  } catch (error) { return failure(`red-team check runs unreadable: ${message(error)}`); }
}
