/** Head-bound red-team evidence published by the WE GitHub App. */
import { redTeamEnqueueHold } from './drain-queue-safety.mjs';
import { readSealedStatus } from './red-team-sealed-status.mjs';
import { redTeamForHead } from './red-team-gate.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { readFileSync } from 'node:fs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { LEGACY_ROLE, ROLE_ENV } from './github-app-identity.mjs';
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

/** Does merge-gate read the red-team check run as evidence? Every mode but the `drain-scan` rollback. The one
 * shared answer for every writer that must publish before acting (publish-first, the review barrier). */
export function redTeamCheckRunIsEvidence({ env = process.env, log = () => {} } = {}) {
  return readRedTeamGateSource({ env, log: line => { try { log(line); } catch { /* logging is best effort */ } } }).value.source !== 'drain-scan';
}

const ioOptions = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const validHead = head => typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head);
const validApp = id => /^[1-9]\d*$/.test(String(id ?? '')) && Number.isSafeInteger(Number(id));
const prIdentity = (repo, pr) => /^[\w.-]+\/[\w.-]+$/.test(repo ?? '')
  && /^[1-9]\d*$/.test(String(pr ?? '')) && Number.isSafeInteger(Number(pr)) ? `${repo}#${pr}` : null;
const failure = reason => ({ ok: false, reason });
const message = error => String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

/** The one fail-closed reason for a missing, invalid or unreadable WE App id (every reader and the writer). */
export const WE_APP_ID_UNSET = 'WE_APP_ID unset or invalid; configure the WE App repository variable';

/**
 * The identity every red-team check-run and publication-hold WRITE uses (#6535 operator send-back, 2026-11-12):
 * today's App, the one whose id is the repository variable WE_APP_ID and which readers already trust. A role App
 * (the reviewer, merger or worker) holds only checks:read and statuses:read, and its runs would not be the trusted
 * author anyway. The child env pins `WE_GITHUB_APP_ROLE=legacy`; the gh shim then uses today's App ONLY, never a
 * role App, and fails closed (no personal fallback for a daemon) when its token is unavailable. Whatever role the
 * calling process plays (`WE_GITHUB_APP_ROLE=reviewer` in the review daemon) is overridden for this call only.
 */
export const RED_TEAM_WRITER_ROLE = LEGACY_ROLE;
// An inherited token (the caller's role App, applied as GH_TOKEN with its hash) would be used by the shim's
// fallback or by a bare gh: it is dropped, so only the shim's today's-App token can authenticate the write.
const INHERITED_AUTH = ['GH_TOKEN', 'GITHUB_TOKEN', 'WE_GH_AUTH_TOKEN_HASH', 'WE_GH_AUTH_SOURCE', 'WE_GH_AUTH_INSTALLATION'];
export const redTeamWriterEnv = (env = process.env) => {
  const out = { ...env, [ROLE_ENV]: RED_TEAM_WRITER_ROLE };
  for (const key of INHERITED_AUTH) delete out[key];
  return out;
};

/**
 * The WE App id readers trust and the writer authors as (#6535; operator ruling R907 → setting R905). It is a SETTING,
 * `redTeamGate.appId` in scripts/settings/red-team.json (5037855), resolved standard → platform → tool →
 * `WE_APP_ID` env (CI sets it from `vars.WE_APP_ID`, the same value). The repository variable is documentation only and
 * is never read at runtime: every installed App gets HTTP 403 on Actions variables. A missing, unreadable
 * or invalid value at every layer returns `ok:false` with {@link WE_APP_ID_UNSET} and no appId, so a caller passing
 * `appId` on keeps the existing fail-closed reason. Logs the effective value and its source.
 * @returns {{ok:true, appId:string, source:string} | {ok:false, reason:string, detail?:string}}
 */
export function resolveWeAppId({ env = process.env, path = new URL('../settings/red-team.json', import.meta.url),
  tool, platform, log = () => {} } = {}) {
  let file = {};
  try { file = tool ?? JSON.parse(readFileSync(path, 'utf8')); } catch { /* an unreadable file sets nothing (fails closed below) */ }
  const pick = value => value?.appId === undefined ? {} : { appId: value.appId };
  const raw = env?.WE_APP_ID;
  let resolved;
  try {
    resolved = resolveCascade({ standard: {}, platform: pick(platform ?? platformPreference('redTeamGate', { env })),
      tool: pick(file?.redTeamGate), envValues: { appId: raw === '' ? undefined : raw }, valid: { appId: validApp } });
  } catch (error) { return { ...failure(WE_APP_ID_UNSET), detail: `setting unreadable: ${message(error)}` }; }
  try { log(formatCascadeSourcesLine('redTeamGate.appId', resolved)); } catch { /* logging is best effort */ }
  const appId = resolved?.value?.appId;
  if (!validApp(appId)) return { ...failure(WE_APP_ID_UNSET), detail: 'redTeamGate.appId setting missing or invalid' };
  return { ok: true, appId: String(appId), source: resolved.sources?.appId ?? 'unknown' };
}

/** The daemon's policy-clear writer: resolve the trusted App id, then publish as that App (never the caller's role). */
export function createPolicyClearPublisher({ env = process.env, run = runGhSync, publish = publishRedTeamPolicyClearCheck,
  resolveAppId = () => resolveWeAppId({ env }) } = {}) {
  const gh = (ghArgs, options = {}) => run(ghArgs, { env, ...options });
  return args => {
    const app = resolveAppId();
    if (app.ok !== true) return { ...failure(app.reason), ...(app.detail ? { detail: app.detail } : {}) };
    return publish({ ...args, appId: app.appId, env, gh });
  };
}

export function evaluateRedTeamCheckFact({ repo, pr, headSha, checkRuns, appId } = {}) {
  if (!validApp(appId)) return failure(WE_APP_ID_UNSET);
  if (!validHead(headSha)) return failure('red-team head missing or invalid');
  if (!Array.isArray(checkRuns)) return failure('red-team check runs unreadable');
  const identity = prIdentity(repo, pr);
  if (!identity) return failure('red-team PR identity missing or invalid (repo and PR number required)');
  const candidates = checkRuns.filter(run => run?.name === 'red-team'
    && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === headSha.toLowerCase() && Number(run.app?.id) === Number(appId));
  const runs = candidates.filter(run => run.external_id === identity);
  if (candidates.length && !runs.length)
    return failure(`no red-team check run on head for ${identity}: external_id missing or mismatching`);
  // Unordered ids (invalid, or two runs sharing one id) leave the newest run undecidable: refuse the whole head.
  if (runs.some(run => !Number.isSafeInteger(run.id) || run.id <= 0) || new Set(runs.map(run => run.id)).size !== runs.length)
    return failure('red-team check run ordering unreadable; inspect check history');
  // GitHub run ids order creations, including reruns whose timestamps tie or are absent.
  runs.sort((a, b) => Number(b.id) - Number(a.id));
  const latest = runs[0];
  if (!latest) return failure('no red-team check run on head');
  if (latest.status !== 'completed') return failure('red-team check run in progress or incomplete');
  if (latest.conclusion !== 'success') return failure(`red-team check run failed (${latest.conclusion ?? 'unknown'})`);
  return { ok: true, reason: 'red-team check run succeeded on head' };
}

/** Title prefix of every run the policy-clear writer posts, so it can tell its own runs from a round's. Only runs
 * from the configured app are ever read, so no other author can forge it. */
export const POLICY_CLEAR_TITLE_PREFIX = 'Policy-clear: ';

export function redTeamCheckRunPayload({ repo, pr, headSha, status, hold, sendBack = false, policyClear = false } = {}) {
  const finished = status === 'finished';
  const clear = finished && hold === null && sendBack === false;
  return { name: 'red-team', head_sha: headSha, external_id: prIdentity(repo, pr), status: finished ? 'completed' : 'in_progress',
    ...(finished ? { conclusion: clear ? 'success' : 'failure' } : {}),
    output: { title: `${policyClear ? POLICY_CLEAR_TITLE_PREFIX : ''}${clear ? 'Red team clear' : finished ? 'Red team held' : 'Red team in progress'}`,
      summary: `${prIdentity(repo, pr) ?? 'Unknown PR'}: ${String(hold ?? (sendBack ? 'Red team requires send-back' : clear ? 'Red team cleared this head' : 'Awaiting red-team completion'))}`.slice(0, 60_000) } };
}

/** Publication is best effort; callers must persist local status before calling. Posts as the WE App
 * ({@link redTeamWriterEnv}); a caller's `gh` must let `options.env` win over its own env. */
export function postRedTeamCheckRun({ repo, pr, headSha, payload, gh = runGhSync, env = process.env } = {}) {
  try {
    if (!validHead(headSha) || payload?.head_sha !== headSha || !prIdentity(repo, pr)
      || payload.external_id !== prIdentity(repo, pr)) throw Error('invalid red-team check identity or external_id');
    gh(['api', `repos/${repo}/check-runs`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify(payload), env: redTeamWriterEnv(env) });
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
 *
 * Verify after write, ordered by id (#6535 round 10, operator send-back). The newest check-run id is the single
 * authority, and a round can start between any read and any write. Every run this writer posts carries
 * {@link POLICY_CLEAR_TITLE_PREFIX}, so each read splits this PR's runs into round runs and its own. The newest ROUND
 * run decides what the head must show: none or a completed success → `success`; in progress → `in_progress`; a
 * failure → `failure`. The writer then makes the newest run show exactly that:
 * - before posting: if the newest run already shows it, nothing is posted (`success`: ok; otherwise a round owns
 *   the head: ok:false). If one of its OWN runs is newest and shows something else (an unverified success over a
 *   round that started meanwhile, or an orphan yield with no round behind it), it corrects it. So a retry after a
 *   lost POST response, a crash between write and verify, or a failed yield never trusts an unverified success.
 * - after posting the success: it re-reads. If a round run appeared that is not a completed success, it posts a
 *   superseding run mirroring that round (in_progress, or failure), so the round stays authoritative, and returns
 *   `{ok:false, reason:'policy-clear yielded to a concurrent round'}`; the caller posts no comment and retries.
 *   A failed re-read does the same with an in_progress run (fail closed). A later retry over its own orphan yield,
 *   with no round run behind it, posts the success again, so a yield never strands a head.
 * No lock and no sleep. Residuals (disclosed on #6535; PR-A #6606's per-identity publish lock, shared by every
 * writer, closes each of them):
 * - FAIL-OPEN window: between the success POST and a landed superseding run, the success is the newest run over a
 *   round run it did not see. This writer does NOT promise "never a false success". The bound depends on the case:
 *   - the supersede POST fails, or the process dies between the POST and the re-read: no result comment is posted,
 *     so the on-skip row retries and the next pass corrects it (the pre-post correction above);
 *   - read lag (a round run created just before the success is missing from BOTH reads): the re-read verifies the
 *     success, the caller posts its result comment, and the on-skip row then skips the head as settled. Nothing
 *     re-reads it, so the false success stays newest until that round posts its next run. If the round dies first,
 *     it stays until an operator or a later round republishes.
 * - Fail-closed: a round's FINAL run landing between the re-read and the superseding post is masked by the mirror.
 *   A retry corrects it, but once that round has posted its result comment the on-skip row stops retrying, so the
 *   head can stay held until an operator republishes. Likewise, near the 100-run bound a post can push the head
 *   past it; every later read then refuses, so an orphan yield stays until an operator inspects the history.
 */
export const POLICY_CLEAR_YIELDED = 'policy-clear yielded to a concurrent round';
export function publishRedTeamPolicyClearCheck({ repo, pr, headSha, appId, gh = runGhSync, env = process.env,
  resultComments, readResultHold = redTeamEnqueueHold } = {}) {
  const readRecoveryHold = () => {
    const sealed = readSealedStatus({ repo, pr, head: headSha, env });
    const recorded = sealed !== null && !sealed.unreadable && !sealed.unsealed;
    if (!recorded) return 'sealed result evidence missing, unreadable or unsealed for this head; inspect stored evidence and retry publication';
    return readResultHold({ repo, pr, head: headSha, comments: resultComments,
      ok: true, scheduled: true, recorded, env });
  };
  // Recovery of an existing result never overwrites any run, including this writer's own orphan yield.
  // The drain's sealed-result disposition is authoritative; a comment alone cannot authorize success.
  if (resultComments !== undefined) {
    if (!Array.isArray(resultComments) || !redTeamForHead(resultComments, pr, headSha))
      return failure('result check not posted: trusted result missing on head');
    const fact = readRedTeamCheckFact({ repo, pr, headSha, appId, gh });
    if (fact.ok === true) return fact;
    if (fact.reason !== 'no red-team check run on head') return fact;
    try {
      const hold = readRecoveryHold();
      if (hold !== null) return failure(`result check not posted: ${hold ?? 'result disposition unreadable; inspect sealed evidence'}`);
    } catch (error) { return failure(`result check not posted: ${message(error)}`); }
  }
  const before = readPolicyClearView({ repo, pr, headSha, appId, gh });
  if (before.ok !== true) return failure(`policy-clear check not posted: ${before.reason}`);
  if (resultComments !== undefined && before.current !== 'none')
    return before.current === 'success' ? { ok: true, reason: 'red-team check already clear on head' }
      : failure('result check not posted: a red-team run appeared before publication');
  if (before.current === before.desired) return before.desired === 'success'
    ? { ok: true, reason: 'red-team check already clear on head' }
    : failure(`policy-clear check not posted: a red-team round owns this head (${before.desired})`);
  if (before.desired !== 'success') return supersede({ repo, pr, headSha, gh, env, state: before.desired });
  if (resultComments !== undefined) {
    try {
      const live = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'], ioOptions));
      if (live?.headRefOid !== headSha) return failure('result check not posted: head changed or unreadable before publication');
      const hold = readRecoveryHold();
      if (hold !== null) return failure(`result check not posted: ${hold ?? 'result disposition unreadable; inspect sealed evidence'}`);
    } catch (error) { return failure(`result check not posted: ${message(error)}`); }
    const fact = readRedTeamCheckFact({ repo, pr, headSha, appId, gh });
    if (fact.reason !== 'no red-team check run on head') return fact;
  }
  const posted = postRedTeamCheckRun({ repo, pr, headSha, gh, env,
    payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: null, sendBack: false, policyClear: true }) });
  if (posted.ok !== true) return posted;
  const after = readPolicyClearView({ repo, pr, headSha, appId, gh, resultRecovery: resultComments !== undefined });
  if (after.ok !== true) return supersede({ repo, pr, headSha, gh, env, state: 'in_progress',
    detail: `re-read after publication failed (${after.reason})` });
  if (after.desired === 'success' && after.current === 'success') return posted;
  // No round run requires anything else, but its success is not the newest run (a lagging read, or another
  // policy-clear writer's run on top): post nothing, never an in_progress a clean head does not need; the retry
  // re-reads and posts the success again only if it is still not newest.
  if (after.desired === 'success') return failure(`policy-clear unverified: newest run shows ${after.current}, not its success; retry`);
  if (after.current === after.desired) return { ...failure(POLICY_CLEAR_YIELDED), detail: 'a newer round run is authoritative' };
  return supersede({ repo, pr, headSha, gh, env, state: after.desired });
}

const runState = run => run.status !== 'completed' ? 'in_progress' : run.conclusion === 'success' ? 'success' : 'failure';
const isPolicyClearRun = run => typeof run?.output?.title === 'string' && run.output.title.startsWith(POLICY_CLEAR_TITLE_PREFIX);

/** Post a policy-clear run that mirrors the round's state, so the round (never this writer's success) is newest. */
function supersede({ repo, pr, headSha, gh, env, state, detail }) {
  const yielded = postRedTeamCheckRun({ repo, pr, headSha, gh, env, payload: redTeamCheckRunPayload({ repo, pr, headSha,
    status: state === 'failure' ? 'finished' : 'in_progress', hold: `${POLICY_CLEAR_YIELDED}${detail ? `: ${detail}` : ''}`,
    sendBack: state === 'failure', policyClear: true }) });
  return { ...failure(POLICY_CLEAR_YIELDED),
    detail: [detail, yielded.ok === true ? `superseding ${state} posted` : `superseding ${state} not posted (${yielded.reason})`].filter(Boolean).join('; ') };
}

/** One bounded read of this PR's runs on the head: the newest run's state and the state the newest round run requires.
 * Whole-head refusals (unreadable, truncated, another PR only, unordered ids, bad identity) are kept from the gate's
 * own evaluator. */
function readPolicyClearView({ repo, pr, headSha, appId, gh, resultRecovery = false }) {
  if (!validApp(appId)) return failure(WE_APP_ID_UNSET);
  if (!validHead(headSha) || !prIdentity(repo, pr)) return failure('invalid red-team check identity (repo and PR number required)');
  let data;
  try { data = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs?check_name=red-team&filter=all&per_page=100`], ioOptions)); }
  catch (error) { return failure(`red-team check runs unreadable: ${message(error)}`); }
  if (!Array.isArray(data?.check_runs) || data.check_runs.length > 100 || !Number.isSafeInteger(data.total_count) || data.total_count !== data.check_runs.length)
    return failure('red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history');
  const fact = evaluateRedTeamCheckFact({ repo, pr, headSha, appId, checkRuns: data.check_runs });
  if (fact.ok !== true && !/^(no red-team check run on head|red-team check run in progress or incomplete|red-team check run failed \(.*\))$/.test(fact.reason))
    return fact;
  const identity = prIdentity(repo, pr);
  const runs = data.check_runs.filter(run => run?.name === 'red-team' && run.external_id === identity
    && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === headSha.toLowerCase() && Number(run.app?.id) === Number(appId))
    .sort((a, b) => Number(b.id) - Number(a.id));
  // Recovery observed no runs before posting: any held run, including another policy-clear
  // writer's yield, appeared concurrently and must remain authoritative.
  const round = runs.find(run => resultRecovery ? runState(run) !== 'success' : !isPolicyClearRun(run));
  return { ok: true, current: runs[0] ? runState(runs[0]) : 'none', desired: round ? runState(round) : 'success' };
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

export function postRedTeamPublicationHold({ repo, pr, headSha, held, reason = '', gh = runGhSync, env = process.env } = {}) {
  try {
    const context = redTeamPublicationContext(pr);
    if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !context) throw Error('invalid red-team publication hold identity (repo, PR number and head required)');
    const description = String(held ? `held: ${reason || 'red-team round not confirmed published'}` : 'red-team publication confirmed')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140);
    gh(['api', `repos/${repo}/statuses/${headSha}`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify({ state: held ? 'failure' : 'success', context, description }), env: redTeamWriterEnv(env) });
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
  // The summary says this PR's context exists, so the history must show it; an empty or contradictory history
  // (e.g. a failure in the summary but none in the list) is unreadable evidence, never a clear.
  if (!ordered.length) return failure('red-team publication hold history lacks the summarized hold; operator must inspect commit statuses');
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
  if (!validApp(appId)) return failure(WE_APP_ID_UNSET);
  if (!validHead(headSha) || !prIdentity(repo, pr)) return failure('invalid red-team check identity (repo and PR number required)');
  try {
    const data = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs?check_name=red-team&filter=all&per_page=100`], ioOptions));
    if (!Array.isArray(data?.check_runs) || data.check_runs.length > 100 || !Number.isSafeInteger(data.total_count) || data.total_count !== data.check_runs.length)
      return failure('red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history');
    return evaluateRedTeamCheckFact({ repo, pr, headSha, appId, checkRuns: data.check_runs });
  } catch (error) { return failure(`red-team check runs unreadable: ${message(error)}`); }
}
