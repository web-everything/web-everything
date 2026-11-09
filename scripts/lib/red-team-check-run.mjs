/** Head-bound red-team evidence published by the WE GitHub App. */
import { runGhSync } from './gh-throttle.mjs';
import { readFileSync } from 'node:fs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
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

/**
 * A recovery policy-clear settlement (a stored not-owed review, or a policy-clear carried across a rebase) settles
 * the head without a round, so no round writer publishes its check. It publishes the same head-bound success here
 * BEFORE its result comment: a comment without a check would strand the head, because recovery skips a head that
 * already shows a result. It first reads the head and posts only when this PR has NO red-team check run there: an
 * existing success needs nothing, and any other run (in progress, failed, unreadable) belongs to a real round and
 * is never overridden. Any refusal or failed post returns `ok:false`; the caller posts no comment and retries.
 */
export function publishRedTeamPolicyClearCheck({ repo, pr, headSha, appId, gh = runGhSync } = {}) {
  const fact = readRedTeamCheckFact({ repo, pr, headSha, appId, gh });
  if (fact.ok === true) return { ok: true, reason: 'red-team check already clear on head' };
  if (fact.reason !== 'no red-team check run on head') return failure(`policy-clear check not posted: ${fact.reason}`);
  return postRedTeamCheckRun({ repo, pr, headSha, gh,
    payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: null, sendBack: false }) });
}

/** The GitHub-visible publication hold (#6535): a head-bound commit status, written through the statuses API, a
 * second channel beside the check-runs API. The drain posts it when a red-team transition AND its failure supersede
 * both fail to publish, and posts `success` on the same context once publication is confirmed. Any CI host reads it,
 * so an older red-team success never passes there while the hold is set. A head-bound status cannot wedge a later
 * head. If every GitHub write fails, nothing remote can be written: only the drain-local hold binds then.
 * A status binds a sha, and two PRs can share one head sha; so the context also names the PR (as the check run's
 * external_id does), and one PR's confirmed clear can never clear another PR's hold on the same head. */
export const RED_TEAM_PUBLICATION_CONTEXT = 'red-team/publication';
/** The per-PR context, or null for an invalid PR number (callers then fail closed). */
export const redTeamPublicationContext = pr => /^[1-9]\d*$/.test(String(pr ?? '')) && Number.isSafeInteger(Number(pr))
  ? `${RED_TEAM_PUBLICATION_CONTEXT} #${Number(pr)}` : null;

export function postRedTeamPublicationHold({ repo, pr, headSha, held, reason = '', gh = runGhSync } = {}) {
  try {
    const context = redTeamPublicationContext(pr);
    if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !context) throw Error('invalid red-team publication hold identity (repo, PR number and head required)');
    const description = String(held ? `held: ${reason || 'red-team round not confirmed published'}` : 'red-team publication confirmed')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140);
    gh(['api', `repos/${repo}/statuses/${headSha}`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify({ state: held ? 'failure' : 'success', context, description }) });
    return { ok: true };
  } catch (error) {
    // A definite rejection (HTTP 4xx) created or changed no status. Read it from the FULL error text, before the
    // reason is truncated, so a long message never hides the code.
    const text = `${error?.stderr ?? ''} ${error?.message ?? error}`;
    return { ...failure(`red-team publication hold not posted: ${message(error)}`), definite: /HTTP 4\d\d/.test(text) };
  }
}

/** Trust boundary: anyone with statuses:write can post on this context. A hold (any non-success state) counts
 * from ANY author (a forged hold only blocks, fail closed). Only a trusted author's (automation or operator, the
 * shared marker-authorship rule) `success` clears it; an untrusted success is skipped. The newest decisive status
 * wins, ordered by id. Absent = no hold. An unreadable read, or a full page with no decision, holds.
 * `combined` is the per-context latest summary; `statuses` the full newest-first list, read only when the context
 * exists. */
export function evaluateRedTeamPublicationHold({ pr, combined, statuses, isTrusted = isTrustedMarkerAuthor } = {}) {
  const context = redTeamPublicationContext(pr);
  if (!context) return failure('red-team publication hold PR number missing or invalid');
  const latest = combined?.statuses;
  if (!Array.isArray(latest) || !Number.isSafeInteger(combined.total_count) || combined.total_count !== latest.length)
    return failure('red-team publication hold unreadable or incomplete; operator must inspect commit statuses');
  if (!latest.some(status => status?.context === context)) return { ok: true, reason: 'no red-team publication hold on head' };
  if (!Array.isArray(statuses) || statuses.length > 100 || statuses.some(status => !Number.isSafeInteger(status?.id)))
    return failure('red-team publication hold history unreadable; operator must inspect commit statuses');
  const ordered = statuses.filter(status => status.context === context).sort((a, b) => b.id - a.id);
  for (const status of ordered) {
    if (status.state !== 'success')
      return failure(`red-team round not confirmed published (GitHub-visible hold, ${message(status.state)}); retry check publication before enqueue`);
    if (isTrusted({ user: { login: String(status.creator?.login ?? '') } })) return { ok: true, reason: 'red-team publication hold cleared on head' };
  }
  if (statuses.length === 100) return failure('red-team publication hold history incomplete at 100-status bound; operator must inspect commit statuses');
  return { ok: true, reason: 'no trusted red-team publication hold on head' };
}

export function readRedTeamPublicationHoldFact({ repo, pr, headSha, gh = runGhSync, isTrusted } = {}) {
  const context = redTeamPublicationContext(pr);
  if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !context)
    return failure('invalid red-team publication hold identity (repo, PR number and head required)');
  try {
    const combined = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/status?per_page=100`], ioOptions));
    const present = Array.isArray(combined?.statuses) && combined.statuses.some(status => status?.context === context);
    const statuses = present ? JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/statuses?per_page=100`], ioOptions)) : undefined;
    return evaluateRedTeamPublicationHold({ pr, combined, statuses, ...(isTrusted ? { isTrusted } : {}) });
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
