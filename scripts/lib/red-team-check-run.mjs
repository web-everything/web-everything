/** Head-bound red-team evidence published by the WE GitHub App. */
import { runGhSync } from './gh-throttle.mjs';
import { readFileSync } from 'node:fs';
import { resolveCascade, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';

/** Cutover defaults to both authorities; invalid overrides retain the lower layer. */
export function readRedTeamGateSource({ env = process.env,
  path = new URL('../settings/red-team.json', import.meta.url), tool, platform, log = () => {} } = {}) {
  let file = {};
  try { file = tool ?? JSON.parse(readFileSync(path, 'utf8')); } catch { /* defaults */ }
  const pick = value => value?.source === undefined ? {} : { source: value.source };
  const raw = env.WE_RED_TEAM_GATE_SOURCE;
  const resolved = resolveCascade({ standard: { source: 'both' },
    platform: pick(platform ?? platformPreference('redTeamGate', { env })), tool: pick(file.redTeamGate),
    envValues: { source: raw === '' ? undefined : raw },
    valid: value => ['both', 'check-run', 'drain-scan'].includes(value) });
  log(formatCascadeSourcesLine('redTeamGate', resolved));
  return resolved;
}

const ioOptions = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const validHead = head => typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head);
const validApp = id => /^[1-9]\d*$/.test(String(id ?? '')) && Number.isSafeInteger(Number(id));
const prIdentity = (repo, pr) => /^[\w.-]+\/[\w.-]+$/.test(repo ?? '')
  && /^[1-9]\d*$/.test(String(pr ?? '')) && Number.isSafeInteger(Number(pr)) ? `${repo}#${pr}` : null;
const failure = reason => ({ ok: false, reason });
const message = error => String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

export function evaluateRedTeamCheckFact({ repo, pr, headSha, checkRuns, appId } = {}) {
  if (!validApp(appId)) return failure('WE_APP_ID unset or invalid; configure the WE App repository variable');
  if (!validHead(headSha)) return failure('red-team head missing or invalid');
  if (!Array.isArray(checkRuns)) return failure('red-team check runs unreadable');
  const identity = prIdentity(repo, pr);
  if (!identity) return failure('red-team PR identity missing or invalid (repo and PR number required)');
  const candidates = checkRuns.filter(run => run?.name === 'red-team'
    && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === headSha.toLowerCase() && Number(run.app?.id) === Number(appId));
  const runs = candidates.filter(run => run.external_id === identity);
  if (candidates.length && !runs.length)
    return failure(`no red-team check run on head for ${identity}: external_id missing or mismatching`);
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

export function redTeamCheckRunPayload({ repo, pr, headSha, status, hold, sendBack = false } = {}) {
  const finished = status === 'finished';
  const clear = finished && hold === null && sendBack === false;
  return { name: 'red-team', head_sha: headSha, external_id: prIdentity(repo, pr), status: finished ? 'completed' : 'in_progress',
    ...(finished ? { conclusion: clear ? 'success' : 'failure' } : {}),
    output: { title: clear ? 'Red team clear' : finished ? 'Red team held' : 'Red team in progress',
      summary: `${prIdentity(repo, pr) ?? 'Unknown PR'}: ${String(hold ?? (sendBack ? 'Red team requires send-back' : clear ? 'Red team cleared this head' : 'Awaiting red-team completion'))}`.slice(0, 60_000) } };
}

/** Publication is best effort; callers must persist local status before calling. */
export function postRedTeamCheckRun({ repo, pr, headSha, payload, gh = runGhSync } = {}) {
  try {
    if (!validHead(headSha) || payload?.head_sha !== headSha || !prIdentity(repo, pr)
      || payload.external_id !== prIdentity(repo, pr)) throw Error('invalid red-team check identity or external_id');
    gh(['api', `repos/${repo}/check-runs`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify(payload) });
    return { ok: true };
  } catch (error) { return failure(`red-team check publication failed: ${message(error)}`); }
}

/** The GitHub-visible publication hold (#6535): a head-bound commit status, written through the statuses API, a
 * second channel beside the check-runs API. The drain posts it when a red-team transition AND its failure supersede
 * both fail to publish, and posts `success` on the same context once publication is confirmed. Any CI host reads it,
 * so an older red-team success never passes there while the hold is set. A head-bound status cannot wedge a later
 * head. If every GitHub write fails, nothing remote can be written: only the drain-local hold binds then. */
export const RED_TEAM_PUBLICATION_CONTEXT = 'red-team/publication';

export function postRedTeamPublicationHold({ repo, headSha, held, reason = '', gh = runGhSync } = {}) {
  try {
    if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Error('invalid red-team publication hold identity');
    const description = String(held ? `held: ${reason || 'red-team round not confirmed published'}` : 'red-team publication confirmed')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140);
    gh(['api', `repos/${repo}/statuses/${headSha}`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify({ state: held ? 'failure' : 'success', context: RED_TEAM_PUBLICATION_CONTEXT, description }) });
    return { ok: true };
  } catch (error) { return failure(`red-team publication hold not posted: ${message(error)}`); }
}

/** The combined status carries the newest status per context. Absent = no hold; any other state, or an
 * incomplete or unreadable read, holds. */
export function evaluateRedTeamPublicationHold({ combined } = {}) {
  const statuses = combined?.statuses;
  if (!Array.isArray(statuses) || !Number.isSafeInteger(combined.total_count) || combined.total_count !== statuses.length)
    return failure('red-team publication hold unreadable or incomplete; operator must inspect commit statuses');
  const hold = statuses.find(status => status?.context === RED_TEAM_PUBLICATION_CONTEXT);
  if (!hold) return { ok: true, reason: 'no red-team publication hold on head' };
  if (hold.state === 'success') return { ok: true, reason: 'red-team publication hold cleared on head' };
  return failure(`red-team round not confirmed published (GitHub-visible hold, ${message(hold.state)}); retry check publication before enqueue`);
}

export function readRedTeamPublicationHoldFact({ repo, headSha, gh = runGhSync } = {}) {
  if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return failure('invalid red-team publication hold identity');
  try {
    return evaluateRedTeamPublicationHold({ combined: JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/status?per_page=100`], ioOptions)) });
  } catch (error) { return failure(`red-team publication hold unreadable: ${message(error)}`); }
}

/** One bounded read; incomplete evidence needs operator inspection rather than a guessed pass. */
export function readRedTeamCheckFact({ repo, pr, headSha, appId, gh = runGhSync } = {}) {
  if (!validApp(appId)) return failure('WE_APP_ID unset or invalid; configure the WE App repository variable');
  if (!validHead(headSha) || !prIdentity(repo, pr)) return failure('invalid red-team check identity (repo and PR number required)');
  try {
    const data = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs?check_name=red-team&filter=all&per_page=100`], ioOptions));
    if (!Array.isArray(data?.check_runs) || data.check_runs.length > 100 || !Number.isSafeInteger(data.total_count) || data.total_count !== data.check_runs.length)
      return failure('red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history');
    return evaluateRedTeamCheckFact({ repo, pr, headSha, appId, checkRuns: data.check_runs });
  } catch (error) { return failure(`red-team check runs unreadable: ${message(error)}`); }
}
