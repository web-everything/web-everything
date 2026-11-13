/** Head-bound red-team evidence published by the WE GitHub App. */
import { runGhSync } from './gh-throttle.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from './atomic-json-file.mjs';
import { createHash } from 'node:crypto';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { LEGACY_ROLE, ROLE_ENV } from './github-app-identity.mjs';
import { resolveCascade, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { isPublishableRedTeamResult, readRedTeamDisposition, redTeamResultId, redTeamResultRecordTimes } from './red-team-gate.mjs';
import { redTeamEnqueueHold } from './drain-queue-safety.mjs';
import { REVIEW_HOLD_LABELS } from './review-escalation.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { createGhProvider } from './review-label-provider.mjs';

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

/** Host-local serialization shared by every red-team writer, across lane checkouts.
 * Synchronous callbacks only: withFileLock releases the lock when the callback returns. */
export function withRedTeamCheckLock({ repo, pr, headSha, env = process.env,
  lockTimeoutMs = 3_000, lock = withFileLock } = {}, fn) {
  try {
    if (!prIdentity(repo, pr) || !validHead(headSha)) throw Error('invalid red-team lock identity');
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) throw Error('invalid red-team lock timeout');
    const dir = env.WE_RED_TEAM_CHECK_LOCK_DIR ?? join(homedir(), '.cache', 'web-everything', 'red-team-check-locks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // GitHub identities are case-insensitive; equivalent spellings must share a lock.
    const key = `${repo.toLowerCase()}#${Number(pr)}@${headSha.toLowerCase()}`;
    const name = createHash('sha256').update(key).digest('hex');
    return lock(join(dir, `${name}.lock`), fn, { timeoutMs: lockTimeoutMs });
  } catch (error) {
    return failure(`red-team check lock failed: ${message(error)}; retry publication or ask an operator to inspect the host lock`);
  }
}

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

/**
 * The daemon's carried-check writer (#6606), built like {@link createPolicyClearPublisher}: the App id comes from the
 * shared resolver (never a bare `env.WE_APP_ID`, which the daemon never sets), and the one `gh` both writes use puts
 * the caller's env FIRST, so a writer's own `options.env` ({@link redTeamWriterEnv}, the WE App identity) wins.
 * `run(args, options)` is the caller's gh runner. Every production caller builds its carried-check IO from here.
 * @returns {{ gh: Function, publish: (args:object) => object, clearHold: (args:object) => object }}
 */
export function createLiveCheckPublisher({ env = process.env, run = runGhSync, publish = publishRedTeamCheckFromLive,
  clearHold = clearLivePublicationHold, resolveAppId = () => resolveWeAppId({ env }) } = {}) {
  const gh = (ghArgs, options = {}) => run(ghArgs, { env, ...options });
  return {
    gh,
    publish: args => {
      const app = resolveAppId();
      if (app.ok !== true) return { ...failure(app.reason), ...(app.detail ? { detail: app.detail } : {}) };
      return publish({ ...args, appId: app.appId, env, gh });
    },
    clearHold: args => clearHold({ ...args, env, gh }),
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
/** Title prefix of every run {@link publishRedTeamCheckFromLive} posts: its success AND the failure it posts over that
 * success when verification after publication fails. Both are this writer's own publication records, never a round's
 * evidence: re-validation decides from the newest OTHER run, so neither its unverified success (which may sit over a
 * round run it did not see) nor its own supersede can decide a retry. Only runs from the configured app are read, so
 * no other author can forge it. */
export const LIVE_CHECK_TITLE_PREFIX = 'Live-check: ';
export const isLiveCheckRun = run => typeof run?.output?.title === 'string'
  && run.output.title.startsWith(LIVE_CHECK_TITLE_PREFIX);

export function redTeamCheckRunPayload({ repo, pr, headSha, status, hold, sendBack = false, policyClear = false,
  liveCheck = false } = {}) {
  const finished = status === 'finished';
  const clear = finished && hold === null && sendBack === false;
  // The live helper posts only finished runs; an in-progress run never carries its prefix.
  const prefix = policyClear ? POLICY_CLEAR_TITLE_PREFIX : liveCheck && finished ? LIVE_CHECK_TITLE_PREFIX : '';
  return { name: 'red-team', head_sha: headSha, external_id: prIdentity(repo, pr), status: finished ? 'completed' : 'in_progress',
    ...(finished ? { conclusion: clear ? 'success' : 'failure' } : {}),
    output: { title: `${prefix}${clear ? 'Red team clear' : finished ? 'Red team held' : 'Red team in progress'}`,
      summary: `${prIdentity(repo, pr) ?? 'Unknown PR'}: ${String(hold ?? (sendBack ? 'Red team requires send-back' : clear ? 'Red team cleared this head' : 'Awaiting red-team completion'))}`.slice(0, 60_000) } };
}

/** Publication is best effort; callers must persist local status before calling. Posts as the WE App
 * ({@link redTeamWriterEnv}); a caller's `gh` must let `options.env` win over its own env. */
export function postRedTeamCheckRun(options = {}) {
  return withRedTeamCheckLock(options, () => postRedTeamCheckRunUnlocked(options));
}

function postRedTeamCheckRunUnlocked({ repo, pr, headSha, payload, gh = runGhSync, env = process.env } = {}) {
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
 * - hold first (#6606, operator send-back on 0f1cf7bb, item 1): it posts this PR's publication hold before the
 *   success and clears it only after a read validated that success, all under the writers' host lock. No hold, no
 *   success. A failed validation leaves the hold set, so the merge gate holds through the window below.
 * Residuals (disclosed on #6535; the per-identity publish lock and the hold above now close the merge-visible part):
 * - window: between the success POST and a landed superseding run, the success is the newest run over a round run it
 *   did not see. The hold keeps the gate closed meanwhile. The bound depends on the case:
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
export function publishRedTeamPolicyClearCheck(options = {}) {
  return withRedTeamCheckLock(options, () => publishRedTeamPolicyClearCheckUnlocked(options));
}

function publishRedTeamPolicyClearCheckUnlocked({ repo, pr, headSha, appId, gh = runGhSync, env = process.env,
  clearHold = clearLivePublicationHold } = {}) {
  // The clear runs only after a read that validated the success as the newest run with no round run requiring
  // otherwise. It is a compare-and-clear of this writer's OWN hold only: a round writer's or the live helper's hold
  // above it is left to its owner (cleared:false, the head stays held).
  const settle = result => {
    let cleared;
    try { cleared = clearHold({ repo, pr, headSha, gh, env, ownsHold: isPolicyClearHoldDescription }); }
    catch (error) { cleared = failure(message(error)); }
    return cleared?.ok === true ? result
      : failure(`policy-clear validated but its publication hold not cleared: ${cleared?.reason ?? 'unknown error'}; retry`);
  };
  const before = readPolicyClearView({ repo, pr, headSha, appId, gh });
  if (before.ok !== true) return failure(`policy-clear check not posted: ${before.reason}`);
  // Already clear: this read validated the success, so a hold an earlier attempt left (its clear failed, or it died
  // between its post and its clear) is cleared now; otherwise a retry would never open the head.
  if (before.current === before.desired) return before.desired === 'success'
    ? settle({ ok: true, reason: 'red-team check already clear on head' })
    : failure(`policy-clear check not posted: a red-team round owns this head (${before.desired})`);
  if (before.desired !== 'success') return supersede({ repo, pr, headSha, gh, env, state: before.desired });
  // Hold first (operator send-back on 0f1cf7bb, item 1): the merge gate reads this PR's publication hold with the
  // check, so the success posted next is not merge-visible until the validated clear below. No hold, no success; a
  // failed validation (a yield, an unverified re-read, a failed re-read) leaves the hold set for a later confirmed
  // clear, or for the round writer whose confirmed clear supersedes it.
  if (!liveHoldAlreadySet({ repo, pr, headSha, gh, ownsHold: isPolicyClearHoldDescription })) {
    const hold = postRedTeamPublicationHold({ repo, pr, headSha, held: true, reason: POLICY_CLEAR_HOLD_PENDING, gh, env });
    if (hold.ok !== true) return failure(`policy-clear check not posted: publication hold not set (${hold.reason})`);
  }
  const posted = postRedTeamCheckRunUnlocked({ repo, pr, headSha, gh, env,
    payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: null, sendBack: false, policyClear: true }) });
  if (posted.ok !== true) return posted;
  const after = readPolicyClearView({ repo, pr, headSha, appId, gh });
  if (after.ok !== true) return supersede({ repo, pr, headSha, gh, env, state: 'in_progress',
    detail: `re-read after publication failed (${after.reason})` });
  if (after.desired === 'success' && after.current === 'success') return settle(posted);
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
  const yielded = postRedTeamCheckRunUnlocked({ repo, pr, headSha, gh, env, payload: redTeamCheckRunPayload({ repo, pr, headSha,
    status: state === 'failure' ? 'finished' : 'in_progress', hold: `${POLICY_CLEAR_YIELDED}${detail ? `: ${detail}` : ''}`,
    sendBack: state === 'failure', policyClear: true }) });
  return { ...failure(POLICY_CLEAR_YIELDED),
    detail: [detail, yielded.ok === true ? `superseding ${state} posted` : `superseding ${state} not posted (${yielded.reason})`].filter(Boolean).join('; ') };
}

/** One bounded read of this PR's runs on the head: the newest run's state and the state the newest round run requires.
 * Whole-head refusals (unreadable, truncated, another PR only, unordered ids, bad identity) are kept from the gate's
 * own evaluator. */
function readPolicyClearView({ repo, pr, headSha, appId, gh }) {
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
  const round = runs.find(run => !isPolicyClearRun(run));
  return { ok: true, current: runs[0] ? runState(runs[0]) : 'none', desired: round ? runState(round) : 'success' };
}

/** Re-derive a carried/ruling settlement from live gate evidence; never override a live round.
 * Under the one host lock: post this PR's publication hold, post the success, recheck after publication, and only then
 * clear the hold (the merge-visible success). Evidence that changed or became unreadable supersedes our success and
 * leaves the hold set; a hold that cannot be posted posts no success. */
export function publishRedTeamCheckFromLive(options = {}) {
  return withRedTeamCheckLock(options, () => publishRedTeamCheckFromLiveUnlocked(options));
}

function publishRedTeamCheckFromLiveUnlocked({ repo, pr, headSha, appId, gh = runGhSync,
  env = process.env, readLive, readComments, readStandingRuling = standingRulingScope,
  holdFn = redTeamEnqueueHold, beforeHold, onConfirmed, clearHold = clearLivePublicationHold } = {}) {
  let published = false, holdSet = false, holdPosted = false, holdIntent = '';
  try {
    if (!validApp(appId) || !validHead(headSha) || !prIdentity(repo, pr))
      return failure('invalid red-team check identity or WE_APP_ID; operator must inspect configuration');
    const provider = createGhProvider({ exec: (args, options) => gh(args, { ...ioOptions, ...options }) });
    const inspect = () => {
      const live = readLive ? readLive({ repo, pr }) : provider.readPrState(repo, pr);
      if (live?.headRefOid !== headSha) throw Error('red-team live head moved or unreadable');
      if (!Array.isArray(live.labels) || live.labels.some(label => typeof (typeof label === 'string' ? label : label?.name) !== 'string'))
        throw Error('red-team live labels unreadable');
      const labels = live.labels.map(label => typeof label === 'string' ? label : label.name);
      const blocked = ['red-team:blocked', 'red-team:pending', ...REVIEW_HOLD_LABELS].find(label => labels.includes(label));
      if (blocked) throw Error(`red-team publication held by ${blocked}`);
      const comments = readComments ? readComments({ repo, pr }) : provider.readComments(repo, pr);
      if (!Array.isArray(comments)) throw Error('red-team comments unreadable');
      const standingRuling = readStandingRuling({ repo, pr: { number: Number(pr), headRefOid: headSha, comments } });
      const disposition = readRedTeamDisposition({ repo, pr, head: headSha, comments, standingRuling, env });
      if (!disposition.result) throw Error('no trusted red-team result on live head');
      if (!Array.isArray(disposition.result.shapedLines) || disposition.result.shapedLines.length)
        throw Error('red-team result has malformed or unparsed finding evidence; operator must inspect the full result');
      // A completed review, or the canonical policy-clear result a carry re-keys onto this head (#6606). The carry
      // decision in review-job reads the same predicate, so it never carries what this refuses.
      if (!isPublishableRedTeamResult(disposition.result))
        throw Error('red-team result lacks completed review content; operator must inspect the full result');
      const hold = holdFn({ repo, pr, head: headSha, comments, standingRuling, env, recorded: true });
      if (hold !== null) throw Error(`red-team publication held: ${hold ?? 'unreadable hold'}`);
      const history = readRedTeamCheckRuns({ repo, pr, headSha, appId, gh });
      if (!history.ok) throw Error(history.reason);
      const fact = evaluateRedTeamCheckFact({ repo, pr, headSha, appId, checkRuns: history.checkRuns });
      if (!fact.ok && fact.reason !== 'no red-team check run on head'
        && !fact.reason.startsWith('red-team check run failed (')) throw Error(fact.reason);
      const runs = history.checkRuns.filter(run => run?.name === 'red-team' && run.head_sha?.toLowerCase() === headSha.toLowerCase()
        && Number(run.app?.id) === Number(appId) && run.external_id === prIdentity(repo, pr));
      if (runs.some(run => !Number.isSafeInteger(run.id) || run.id <= 0))
        throw Error('red-team check ordering unreadable; operator must inspect full check history');
      runs.sort((a, b) => b.id - a.id);
      // This helper's own runs (its success and the failure it posts over an unverified success) are publication
      // records, not a round's evidence. Re-validation decides from the newest OTHER run: a transient failure never
      // blocks its own retry, and an unverified success of its own never hides a round's failure or open run.
      const latest = runs.find(run => !isLiveCheckRun(run));
      if (latest && latest.status !== 'completed') throw Error('red-team check run in progress or incomplete');
      if (latest && latest.conclusion !== 'success') {
        // Parsed dispositions omit comment metadata. Bind the clock evidence to the same trusted
        // head/result, never a later unrelated comment. Ambiguous legacy timestamps cannot clear failure.
        // Read the records exactly as the disposition reader does, so a carried result is dated by its carry.
        const dates = redTeamResultRecordTimes(comments, pr, headSha, redTeamResultId(disposition.result));
        // A result produced during a round cannot resolve that round's later failure.
        const failedAt = Date.parse(latest.completed_at);
        if (!dates.length || dates.some(date => !Number.isFinite(date)) || !Number.isFinite(failedAt)
          || Math.max(...dates) <= failedAt)
          throw Error('trusted live result not demonstrably newer than failed check; operator must inspect result and run timestamps');
      }
      return runs;
    };
    const ids = runs => runs.map(run => run.id);
    const newest = inspect();
    // A retry whose earlier attempt already published this helper's success (its settlement failed, so the outbox
    // marker stayed) re-validated it just now, under the writers' lock, with nothing newer on the head: that success
    // is the confirmed one. Posting another per retry would exhaust the 100-run check history the gate reads (#6606
    // red team on c639d9ba1: the recovery pass retries once per cooldown, without a cap).
    if (newest[0] && isLiveCheckRun(newest[0]) && newest[0].status === 'completed' && newest[0].conclusion === 'success')
      return release();
    // Hold first (operator send-back on 0f1cf7bb, item 1). The merge gate reads the check AND this PR's publication
    // hold, so with the hold set the success posted next is not merge-visible. Only the clear in release(), after the
    // post-publication validation below, makes it visible; a failed validation leaves the hold set. The intent is
    // recorded first, so a later confirmed attempt clears a hold this process dies holding. No hold, no success.
    try { beforeHold?.(); } catch (error) { holdIntent = `; hold intent not recorded (${message(error)})`; }
    holdSet = true;
    if (!liveHoldAlreadySet({ repo, pr, headSha, gh })) {
      const hold = postRedTeamPublicationHold({ repo, pr, headSha, held: true, reason: LIVE_HOLD_PENDING, gh, env });
      if (hold.ok !== true) return { ...failure(`live red-team check not posted: ${hold.reason}${holdIntent}`), remoteHold: true };
      holdPosted = true;
    }
    const before = ids(newest);
    let postedId;
    const posted = postRedTeamCheckRunUnlocked({ repo, pr, headSha, env,
      gh: (args, options) => {
        // A timeout can lose the response after GitHub accepted the success. Treat every attempted
        // write as potentially published so errors still supersede it (or set the publication hold).
        published = true;
        const response = gh(args, options);
        // The response id distinguishes our check from a racing writer's check.
        postedId = JSON.parse(response)?.id;
        if (!Number.isSafeInteger(postedId) || postedId <= 0) throw Error('published check id unreadable');
        return response;
      }, payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: null, liveCheck: true }) });
    if (!posted.ok) throw Error(posted.reason);
    const after = ids(inspect());
    // Our newer id can hide an intervening round even when ours is the latest visible success.
    // Require the entire previous order, with only our run prepended (runs are newest first).
    if (after[0] !== postedId || after.length !== before.length + 1
      || before.some((id, index) => after[index + 1] !== id))
      throw Error('another red-team check raced publication');
  } catch (error) {
    const reason = `live red-team check not clear: ${message(error)}`;
    if (published) {
      const supersede = postRedTeamCheckRunUnlocked({ repo, pr, headSha, gh, env,
        payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: reason, liveCheck: true }) });
      if (!supersede.ok) {
        const failures = `${reason}; ${supersede.reason}`;
        // The pre-publication hold normally already binds here. The recovery pass retries without a cap, so while check
        // writes keep failing each attempt would add one more hold status; past the status page cap the clearer could
        // then never settle. When this PR's context already reads as this helper's own hold, that hold still binds:
        // post nothing. Any other state, or a failed read, posts (fail closed).
        const held = liveHoldAlreadySet({ repo, pr, headSha, gh });
        const hold = held ? { ok: true } : postRedTeamPublicationHold({ repo, pr, headSha, held: true, reason: failures, gh, env });
        const holdNote = holdPosted || (!held && hold.ok) ? 'red-team publication hold posted'
          : held ? 'red-team publication hold already set' : hold.reason;
        return { ...failure(`${failures}; ${holdNote}${holdIntent}`), remoteHold: true };
      }
    }
    // The hold this attempt set (or found set) stays: the success, if posted, is superseded and never made visible.
    return holdSet ? { ...failure(`${reason}${holdIntent}`), remoteHold: true } : failure(reason);
  }
  return release();

  // Validated: clear the helper's own publication hold, still under the writers' lock. This clear is what makes the
  // success merge-visible, so it runs only after the post-publication validation (or the re-validation of a reused
  // success). A round writer's hold is left to its owner (the success stays held until it clears). A failed clear keeps
  // the success invisible (fail closed) and returns ok:false with remoteHold, so the caller's retry marker stays; the
  // retry re-validates the reused success and clears again.
  function release() {
    let cleared;
    try { cleared = clearHold({ repo, pr, headSha, gh, env }); }
    catch (error) { cleared = failure(`red-team publication hold unreadable: ${message(error)}`); }
    if (cleared?.ok !== true)
      return { ...failure(`live red-team check validated but its publication hold not cleared: ${message(cleared?.reason ?? 'unknown error')}${holdIntent}`), remoteHold: true };
    return confirmed();
  }

  // Confirmed. `onConfirmed` runs here, still under the writers' lock (#6606 red team on a67e77345): no later attempt
  // can post a hold between the confirmation and the caller's clear. (A reused success can be older than a hold an
  // earlier attempt set; that hold is the helper's own, so the clear still removes it.) Its outcome never turns the
  // confirmed success into a failure check.
  function confirmed() {
    if (!onConfirmed) return { ok: true };
    let settled;
    try { settled = onConfirmed(); } catch (error) { settled = failure(`carried-check settlement failed: ${message(error)}`); }
    return { ok: true, settled };
  }
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

/** Deliberately NOT under the check lock: this is the last-resort hold for when check writes (or the lock) fail.
 * A CLEAR (`held:false`) makes a success merge-visible, so every caller posts it under the writers' lock (#6606). */
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
export function evaluateRedTeamPublicationHold({ pr, combined, statuses, historyComplete, isTrusted = isTrustedMarkerAuthor } = {}) {
  const context = redTeamPublicationContext(pr);
  if (!context) return failure('red-team publication hold PR number missing or invalid');
  const latest = combined?.statuses;
  if (!Array.isArray(latest) || !Number.isSafeInteger(combined.total_count) || combined.total_count !== latest.length)
    return failure('red-team publication hold unreadable or incomplete; operator must inspect commit statuses');
  if (!latest.some(status => status?.context === context)) return { ok: true, reason: 'no red-team publication hold on head' };
  // `historyComplete` comes from the paged reader; without it `statuses` is one 100-item page, complete only when short.
  const paged = typeof historyComplete === 'boolean';
  if (!Array.isArray(statuses) || (!paged && statuses.length > 100) || statuses.some(status => !Number.isSafeInteger(status?.id)))
    return failure('red-team publication hold history unreadable; operator must inspect commit statuses');
  const complete = paged ? historyComplete : statuses.length < 100;
  const ordered = statuses.filter(status => status.context === context).sort((a, b) => b.id - a.id);
  // The summary says this PR's context exists, so the history must show it; an empty or contradictory history
  // (e.g. a failure in the summary but none in the list) is unreadable evidence, never a clear.
  for (const status of ordered) {
    if (status.state !== 'success')
      return failure(`red-team round not confirmed published (GitHub-visible hold, ${message(status.state)}); retry check publication before enqueue`);
    if (isTrusted({ user: { login: String(status.creator?.login ?? '') } })) return { ok: true, reason: 'red-team publication hold cleared on head' };
  }
  if (!complete) return failure(`red-team publication hold history incomplete at the ${paged ? `${STATUS_PAGE_CAP}-page` : '100-status'} bound; operator must inspect commit statuses`);
  if (!ordered.length) return failure('red-team publication hold history lacks the summarized hold; operator must inspect commit statuses');
  return { ok: true, reason: 'no trusted red-team publication hold on head' };
}

/** Page bound for the two commit-status reads (100 items a page). Past it a read is incomplete: the gate holds with an
 * operator-visible reason and the clearer keeps its retry marker. */
export const STATUS_PAGE_CAP = 10;
const statusPage = (repo, headSha, path, page) =>
  `repos/${repo}/commits/${headSha}/${path}?per_page=100${page > 1 ? `&page=${page}` : ''}`;

/** The combined status (one latest status per context), paged until `total_count` contexts are read. Contexts past the
 * cap leave `statuses` shorter than `total_count`, which every consumer reads as incomplete (fail closed). */
function readCombinedStatus({ repo, headSha, gh }) {
  const first = JSON.parse(gh(['api', statusPage(repo, headSha, 'status', 1)], ioOptions));
  if (!Array.isArray(first?.statuses) || !Number.isSafeInteger(first.total_count)) return first;
  const statuses = [...first.statuses];
  for (let page = 2; page <= STATUS_PAGE_CAP && statuses.length < first.total_count; page++) {
    const next = JSON.parse(gh(['api', statusPage(repo, headSha, 'status', page)], ioOptions))?.statuses;
    if (!Array.isArray(next)) throw Error('combined status page unreadable');
    if (!next.length) break;
    statuses.push(...next);
  }
  if (statuses.length === first.statuses.length) return first;
  // Across pages GitHub may repeat a context and skip another (a reorder between reads). Count unique contexts, so a
  // repeat leaves the list short of `total_count` and reads as incomplete rather than hiding a skipped context.
  const unique = [...new Map(statuses.map(status => [String(status?.context), status])).values()];
  return { ...first, statuses: unique };
}

/** The newest-first status history, paged until `decisive` matches a status on `context` (every newer status is then
 * already read) or the list ends. Unrelated contexts can fill any number of pages ahead of this PR's context.
 * `complete` is false only when the cap stopped the read first. */
function readStatusHistory({ repo, headSha, gh, context, decisive }) {
  const statuses = [];
  for (let page = 1; page <= STATUS_PAGE_CAP; page++) {
    const batch = JSON.parse(gh(['api', statusPage(repo, headSha, 'statuses', page)], ioOptions));
    if (!Array.isArray(batch) || batch.length > 100 || batch.some(status => !Number.isSafeInteger(status?.id)))
      throw Error('statuses unreadable');
    statuses.push(...batch);
    if (batch.length < 100 || batch.some(status => status.context === context && decisive(status))) return { statuses, complete: true };
  }
  return { statuses, complete: false };
}

/** Description prefix of the publication hold {@link publishRedTeamCheckFromLive} sets. */
const LIVE_HOLD_DESCRIPTION_PREFIX = 'held: live red-team check not clear:';
/** The reason of the hold the live helper posts BEFORE its success (send-back item 1); it carries the helper's prefix,
 * so only the helper's own clear removes it. */
const LIVE_HOLD_PENDING = 'live red-team check not clear: awaiting post-publication validation';
/** The policy-clear writer's pending hold. It carries the live helper's prefix, so the live helper's fully validated
 * success opens it too; the policy-clear writer itself clears only this exact hold (isPolicyClearHoldDescription). */
const POLICY_CLEAR_HOLD_PENDING = 'live red-team check not clear: policy-clear awaiting post-publication validation';

/** True only when the combined status reads this PR's context as a non-success whose description is the live helper's
 * hold. Then a further helper hold adds nothing (the gate already holds, and the clearer removes it once a success is
 * confirmed). A round writer's hold is not enough: if it cleared its own, the head must still be held. Any read failure
 * is false, so the caller posts. */
function liveHoldAlreadySet({ repo, pr, headSha, gh, ownsHold = isLiveHoldDescription }) {
  try {
    const context = redTeamPublicationContext(pr);
    const latest = readCombinedStatus({ repo, headSha, gh })?.statuses;
    const status = Array.isArray(latest) ? latest.find(entry => entry?.context === context) : null;
    return Boolean(status) && status.state !== 'success' && ownsHold(status.description);
  } catch { return false; }
}
const isLiveHoldDescription = description => typeof description === 'string' && description.startsWith(LIVE_HOLD_DESCRIPTION_PREFIX);
/** Only the policy-clear writer's OWN pending hold. Its validation is weaker than the live helper's (check-run order
 * only: no labels, trusted result or enqueue hold), so it never clears, or rides on, a live helper's hold: that one
 * may cover a live success that failed its own checks (a crash, or a supersede that did not land). */
const isPolicyClearHoldDescription = description => description === `held: ${POLICY_CLEAR_HOLD_PENDING}`;

/** #6606: clear the GitHub-visible publication hold the live helper set, once a later attempt is confirmed. It clears
 * only when every hold on this PR's context above the newest trusted success is that helper's own (its description,
 * from a trusted author). Any other hold there (a round writer's) is its owner's to clear, so nothing is posted
 * (`cleared:false`, still ok). An unreadable history or a failed clear is not ok: the caller keeps its retry marker. */
export function clearLivePublicationHold({ repo, pr, headSha, gh = runGhSync, env = process.env, isTrusted = isTrustedMarkerAuthor,
  ownsHold = isLiveHoldDescription } = {}) {
  const context = redTeamPublicationContext(pr);
  if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !context)
    return failure('invalid red-team publication hold identity (repo, PR number and head required)');
  const trusted = status => isTrusted({ user: { login: String(status?.creator?.login ?? '') } });
  // A trusted success clears EVERY hold beneath it (the gate walks newest first and stops there), so the clear is
  // posted only when every hold above the newest trusted success is the live helper's own. Any other hold in that
  // range (a round writer's unconfirmed publication) is its owner's to clear: leave all of them.
  let holds = [];
  try {
    // The combined summary (one latest status per context) settles absence first, the same way the gate reader does:
    // unrelated contexts can fill the 100-status history page, and absence must never read as an incomplete history
    // (that kept the retry marker forever and re-published checks until the check-run bound refused the head).
    const combined = readCombinedStatus({ repo, headSha, gh });
    const latest = combined?.statuses;
    if (!Array.isArray(latest) || !Number.isSafeInteger(combined.total_count) || combined.total_count !== latest.length)
      throw Error('combined status unreadable or incomplete');
    if (!latest.some(status => status?.context === context)) return { ok: true, cleared: false, reason: 'no publication hold on head' };
    // Paged: the context's entries can sit behind any number of newer unrelated statuses.
    const { statuses, complete } = readStatusHistory({ repo, headSha, gh, context,
      decisive: status => status.state === 'success' && trusted(status) });
    const ordered = statuses.filter(status => status.context === context).sort((a, b) => b.id - a.id);
    const settled = ordered.findIndex(status => status.state === 'success' && trusted(status));
    if (settled < 0 && !complete) throw Error(`statuses incomplete at the ${STATUS_PAGE_CAP}-page bound`);
    // The summary names this context, so a full history without it is contradictory evidence, never "nothing to clear".
    if (!ordered.length) throw Error('history lacks the summarized publication context');
    holds = (settled < 0 ? ordered : ordered.slice(0, settled)).filter(status => status.state !== 'success');
  } catch (error) { return failure(`red-team publication hold unreadable: ${message(error)}`); }
  if (!holds.length) return { ok: true, cleared: false, reason: 'no publication hold on head' };
  if (holds.some(status => !ownsHold(status.description) || !trusted(status)))
    return { ok: true, cleared: false, reason: 'a publication hold that is not the live helper\'s is set; left to its owner' };
  const posted = postRedTeamPublicationHold({ repo, pr, headSha, held: false, gh, env });
  return posted.ok ? { ok: true, cleared: true } : posted;
}

export function readRedTeamPublicationHoldFact({ repo, pr, headSha, gh = runGhSync, isTrusted } = {}) {
  const context = redTeamPublicationContext(pr);
  if (!validHead(headSha) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !context)
    return failure('invalid red-team publication hold identity (repo, PR number and head required)');
  try {
    const combined = readCombinedStatus({ repo, headSha, gh });
    const present = Array.isArray(combined?.statuses) && combined.statuses.some(status => status?.context === context);
    const trusted = isTrusted ?? isTrustedMarkerAuthor;
    // Decisive for the gate: the newest hold, or the newest trusted success (the evaluator stops at either).
    const history = present ? readStatusHistory({ repo, headSha, gh, context,
      decisive: status => status.state !== 'success' || trusted({ user: { login: String(status.creator?.login ?? '') } }) }) : undefined;
    return evaluateRedTeamPublicationHold({ pr, combined, statuses: history?.statuses, historyComplete: history?.complete,
      ...(isTrusted ? { isTrusted } : {}) });
  } catch (error) { return failure(`red-team publication hold unreadable: ${message(error)}`); }
}

/** One bounded read; incomplete evidence needs operator inspection rather than a guessed pass. */
function readRedTeamCheckRuns({ repo, pr, headSha, appId, gh = runGhSync } = {}) {
  if (!validApp(appId)) return failure(WE_APP_ID_UNSET);
  if (!validHead(headSha) || !prIdentity(repo, pr)) return failure('invalid red-team check identity (repo and PR number required)');
  try {
    const data = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs?check_name=red-team&filter=all&per_page=100`], ioOptions));
    if (!Array.isArray(data?.check_runs) || data.check_runs.length > 100 || !Number.isSafeInteger(data.total_count) || data.total_count !== data.check_runs.length)
      return failure('red-team check runs unreadable or incomplete at 100-run bound; operator must inspect full check history');
    return { ok: true, checkRuns: data.check_runs };
  } catch (error) { return failure(`red-team check runs unreadable: ${message(error)}`); }
}

export function readRedTeamCheckFact(options = {}) {
  try {
    const history = readRedTeamCheckRuns(options);
    return history.ok ? evaluateRedTeamCheckFact({ ...options, checkRuns: history.checkRuns }) : history;
  } catch (error) { return failure(`red-team check runs unreadable: ${message(error)}`); }
}
