/** Head-bound red-team evidence published by the WE GitHub App. */
import { redTeamEnqueueHold } from './drain-queue-safety.mjs';
import { readStoredRedTeamStatus, sealedFromStatus } from './red-team-sealed-status.mjs';
import { redTeamForHead, readRedTeamDisposition, redTeamResultId } from './red-team-gate.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock } from './atomic-json-file.mjs';
import { REVIEW_HOLD_LABELS } from './review-escalation.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
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

/** Host-local serialization shared by every red-team writer, across lane checkouts.
 * Synchronous callbacks only: withFileLock releases the lock when the callback returns. */
export function withRedTeamCheckLock({ repo, pr, headSha, appId, env = process.env,
  lockTimeoutMs = 3_000, lock = withFileLock } = {}, fn) {
  try {
    if (!prIdentity(repo, pr) || !validHead(headSha)) throw Error('invalid red-team lock identity');
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) throw Error('invalid red-team lock timeout');
    const dir = env.WE_RED_TEAM_CHECK_LOCK_DIR ?? join(homedir(), '.cache', 'web-everything', 'red-team-check-locks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // GitHub identities are case-insensitive; equivalent spellings must share a lock.
    const writerApp = validApp(appId) ? String(appId) : resolveWeAppId({ env }).appId;
    if (!validApp(writerApp)) throw Error(WE_APP_ID_UNSET);
    const key = `${repo.toLowerCase()}#${Number(pr)}@${headSha.toLowerCase()}/app/${writerApp}`;
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

/** Resolve the shared app setting and preserve the writer's authentication environment. */
export function createLiveCheckPublisher({ env = process.env, run = runGhSync,
  publish = publishRedTeamCheckFromLive, resolveAppId = () => resolveWeAppId({ env }) } = {}) {
  const gh = (args, options = {}) => run(args, { env, ...options });
  return { gh, publish: args => {
    const app = resolveAppId();
    if (!app.ok) return app;
    return publish({ ...args, appId: app.appId, env, gh });
  } };
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
  if (!runs[0]) return failure('no red-team check run on head');
  // PR #6601 block ruling: a publication success never outranks a round. Policy-clear and live-check successes
  // require the newest ROUND run to be absent or a completed success, so a publication success that is newest over
  // an unfinished or failed round run is unverified (a failed supersede post, a crash before the re-read, or a round
  // run both its reads missed). The newest round run then decides; the head stays held until that round finishes.
  // A publication run can only make the gate stricter: its in_progress or failure yields are read as they are.
  const latest = runs[0].status === 'completed' && runs[0].conclusion === 'success' && isPublicationRun(runs[0])
    ? runs.find(run => !isPublicationRun(run)) ?? runs[0] : runs[0];
  if (latest.status !== 'completed') return failure('red-team check run in progress or incomplete');
  if (latest.conclusion !== 'success') return failure(`red-team check run failed (${latest.conclusion ?? 'unknown'})`);
  return { ok: true, reason: 'red-team check run succeeded on head' };
}

/** Title prefix of every run the policy-clear writer posts, so it can tell its own runs from a round's. Only runs
 * from the configured app are ever read, so no other author can forge it. */
export const POLICY_CLEAR_TITLE_PREFIX = 'Policy-clear: ';
const isPolicyClearRun = run => typeof run?.output?.title === 'string' && run.output.title.startsWith(POLICY_CLEAR_TITLE_PREFIX);

/** Title prefix of every run {@link publishRedTeamCheckFromLive} posts: its success AND the failure it posts over that
 * success when verification after publication fails. Both are this writer's own publication records, never a round's
 * evidence: re-validation decides from the newest OTHER run, so neither its unverified success (which may sit over a
 * round run it did not see) nor its own supersede can decide a retry. Only runs from the configured app are read, so
 * no other author can forge it. */
export const LIVE_CHECK_TITLE_PREFIX = 'Live-check: ';
export const isLiveCheckRun = run => typeof run?.output?.title === 'string'
  && run.output.title.startsWith(LIVE_CHECK_TITLE_PREFIX);
const isPublicationRun = run => isPolicyClearRun(run) || isLiveCheckRun(run);

export function redTeamCheckRunPayload({ repo, pr, headSha, status, hold, sendBack = false, policyClear = false, liveCheck = false } = {}) {
  const finished = status === 'finished';
  const clear = finished && hold === null && sendBack === false;
  return { name: 'red-team', head_sha: headSha, external_id: prIdentity(repo, pr), status: finished ? 'completed' : 'in_progress',
    ...(finished ? { conclusion: clear ? 'success' : 'failure' } : {}),
    output: { title: `${policyClear ? POLICY_CLEAR_TITLE_PREFIX : liveCheck && finished ? LIVE_CHECK_TITLE_PREFIX : ''}${clear ? 'Red team clear' : finished ? 'Red team held' : 'Red team in progress'}`,
      summary: `${prIdentity(repo, pr) ?? 'Unknown PR'}: ${String(hold ?? (sendBack ? 'Red team requires send-back' : clear ? 'Red team cleared this head' : 'Awaiting red-team completion'))}`.slice(0, 60_000) } };
}

/** Keep the deciding successful round intact: live publication records are ignored
 * when revalidating round evidence. At capacity, reuse a publication record first,
 * otherwise the oldest obsolete run. A newer result resolving a failed round still
 * needs to supersede the newest run so the gate can observe that resolution. */
function liveCheckReplacement(runs) {
  const round = runs.find(run => !isLiveCheckRun(run));
  if (round?.status === 'completed' && round.conclusion === 'success' && runs.length > 1)
    return runs.find(isLiveCheckRun) ?? runs.at(-1);
  return runs[0];
}

/** Publication is best effort; callers must persist local status before calling. Posts as the WE App
 * ({@link redTeamWriterEnv}); a caller's `gh` must let `options.env` win over its own env. */
function postRedTeamCheckRunUnlocked({ repo, pr, headSha, payload, replaceRun, appId, gh = runGhSync, env = process.env } = {}) {
  try {
    if (!validHead(headSha) || payload?.head_sha !== headSha || !prIdentity(repo, pr)
      || payload.external_id !== prIdentity(repo, pr)) throw Error('invalid red-team check identity or external_id');
    const write = target => {
      const { head_sha, ...update } = payload;
      return gh(['api', target ? `repos/${repo}/check-runs/${target.id}` : `repos/${repo}/check-runs`,
        '--method', target ? 'PATCH' : 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify(target ? update : payload), env: redTeamWriterEnv(env) });
    };
    if (replaceRun) write(replaceRun);
    else {
      try { write(); }
      catch (error) {
        // Only a definite suite-limit rejection permits replacement; ambiguous write failures
        // retain the caller's retry path. Reuse the newest identity run so id ordering stays sound.
        const detail = `${error} ${error?.stderr ?? ''}`;
        if (!/422/.test(detail) || !/100.*check|check.*100|check.*limit/i.test(detail)) throw error;
        const app = validApp(appId) ? { ok: true, appId } : resolveWeAppId({ env });
        if (!app.ok) throw Error(app.reason);
        const history = readRedTeamCheckRuns({ repo, pr, headSha, appId: app.appId, gh });
        if (!history.ok) throw Error(history.reason);
        const runs = history.checkRuns.filter(run => run.name === 'red-team' && run.external_id === prIdentity(repo, pr)
          && run.head_sha?.toLowerCase() === headSha.toLowerCase() && Number(run.app?.id) === Number(app.appId))
          .sort((a, b) => b.id - a.id);
        const newest = isLiveCheckRun(payload) ? liveCheckReplacement(runs) : runs[0];
        if (!newest) throw Error('suite limit reached without a replaceable identity run; operator must inspect full check history');
        write(newest);
      }
    }
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
 * Every run writer shares the host lock, so publication and its re-read cannot interleave
 * with another local writer. The gate's round precedence also retains its fail-closed behavior.
 */
export const POLICY_CLEAR_YIELDED = 'policy-clear yielded to a concurrent round';
function publishRedTeamPolicyClearCheckUnlocked({ repo, pr, headSha, appId, gh = runGhSync, env = process.env,
  resultComments, readResultHold = redTeamEnqueueHold,
  readComments = ({ repo, pr, exec }) => readCompletePrComments(Number(pr), { repo, exec }) } = {}) {
  const readRecoveryHold = comments => {
    const status = readStoredRedTeamStatus({ repo, pr, head: headSha, env });
    if (status === null || status.unreadable)
      return 'stored result status missing or unreadable for this head; inspect stored evidence and retry publication';
    if (status.status !== 'finished')
      return 'stored result status is not finished for this head; wait for the pass to finish and retry publication';
    const sealed = sealedFromStatus(status, headSha);
    const recorded = sealed !== null && !sealed.unreadable && !sealed.unsealed;
    if (!recorded) return 'sealed result evidence missing, unreadable or unsealed for this head; inspect stored evidence and retry publication';
    return readResultHold({ repo, pr, head: headSha, comments,
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
      const hold = readRecoveryHold(resultComments);
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
  // The memo reads throttle.env, not the child env. Bypass both for live recovery evidence.
  const freshEnv = { ...env, WE_GH_READ_MEMO_DIR: '' };
  const freshGh = (args, options = {}) => gh(args, { ...options, env: { ...(options.env ?? env), WE_GH_READ_MEMO_DIR: '' },
    throttle: { ...options.throttle, env: freshEnv } });
  if (resultComments !== undefined) {
    try {
      const live = JSON.parse(freshGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'], ioOptions));
      if (live?.headRefOid !== headSha) return failure('result check not posted: head changed or unreadable before publication');
      const fact = readRedTeamCheckFact({ repo, pr, headSha, appId, gh: freshGh });
      if (fact.reason !== 'no red-team check run on head') return fact;
      const comments = readComments({ repo, pr, exec: (_file, args, options) => freshGh(args, options) });
      if (!Array.isArray(comments) || !redTeamForHead(comments, pr, headSha))
        return failure('result check not posted: fresh comments unreadable or trusted result missing on head; inspect full thread and retry publication');
      const hold = readRecoveryHold(comments);
      if (hold !== null) return failure(`result check not posted: ${hold ?? 'result disposition unreadable; inspect sealed evidence'}`);
    } catch (error) { return failure(`result check not posted: ${message(error)}; inspect live evidence and retry publication`); }
  }
  const posted = postRedTeamCheckRunUnlocked({ repo, pr, headSha, appId, gh, env,
    payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: null, sendBack: false, policyClear: true }) });
  if (posted.ok !== true) return posted;
  const after = readPolicyClearView({ repo, pr, headSha, appId,
    gh: resultComments !== undefined ? freshGh : gh, resultRecovery: resultComments !== undefined });
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
function readPolicyClearView({ repo, pr, headSha, appId, gh, resultRecovery = false }) {
  if (!validApp(appId)) return failure(WE_APP_ID_UNSET);
  if (!validHead(headSha) || !prIdentity(repo, pr)) return failure('invalid red-team check identity (repo and PR number required)');
  const history = readRedTeamCheckRuns({ repo, pr, headSha, appId, gh });
  if (!history.ok) return history;
  const data = { check_runs: history.checkRuns };
  const fact = evaluateRedTeamCheckFact({ repo, pr, headSha, appId, checkRuns: data.check_runs });
  if (fact.ok !== true && !/^(no red-team check run on head|red-team check run in progress or incomplete|red-team check run failed \(.*\))$/.test(fact.reason))
    return fact;
  const identity = prIdentity(repo, pr);
  const runs = data.check_runs.filter(run => run?.name === 'red-team' && run.external_id === identity
    && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === headSha.toLowerCase() && Number(run.app?.id) === Number(appId))
    .sort((a, b) => Number(b.id) - Number(a.id));
  // Recovery observed no runs before posting: any held run, including another policy-clear
  // writer's yield, appeared concurrently and must remain authoritative.
  const round = runs.find(run => resultRecovery ? runState(run) !== 'success' : !isPublicationRun(run));
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
export function readRedTeamCheckFact(options = {}) {
  const history = readRedTeamCheckRuns(options);
  return history.ok ? evaluateRedTeamCheckFact({ ...options, checkRuns: history.checkRuns }) : history;
}

export function postRedTeamCheckRun(options = {}) {
  const { replaceRun, ...publicOptions } = options;
  return withRedTeamCheckLock(publicOptions, () => postRedTeamCheckRunUnlocked(publicOptions));
}
export function publishRedTeamPolicyClearCheck(options = {}) {
  return withRedTeamCheckLock(options, () => publishRedTeamPolicyClearCheckUnlocked(options));
}

/** App-filtered paging keeps other apps and commit statuses out of carry settlement.
 * At most ten pages per read. Inconsistent counts, duplicate ids and exhausted bounds refuse
 * publication: an operator must inspect full history and retry, never infer absence from a prefix. */
export const RED_TEAM_CHECK_PAGE_CAP = 10;
function readRedTeamCheckRuns({ repo, pr, headSha, appId, gh = runGhSync }) {
  if (!validApp(appId)) return failure(WE_APP_ID_UNSET);
  if (!validHead(headSha) || !prIdentity(repo, pr)) return failure('invalid red-team check identity (repo and PR number required)');
  const incomplete = () => failure('red-team check runs unreadable or incomplete at bounded history read; operator must inspect full check history and retry publication');
  try {
    const runs = [], seen = new Set();
    let total;
    for (let page = 1; page <= RED_TEAM_CHECK_PAGE_CAP; page++) {
      const path = `repos/${repo}/commits/${headSha}/check-runs?check_name=red-team&filter=all&per_page=100&app_id=${appId}${page > 1 ? `&page=${page}` : ''}`;
      const data = JSON.parse(gh(['api', path], ioOptions));
      if (!Array.isArray(data?.check_runs) || data.check_runs.length > 100
        || !Number.isSafeInteger(data.total_count) || data.total_count < 0) return incomplete();
      if (total === undefined) total = data.total_count;
      if (total !== data.total_count) return incomplete();
      if (page === 1 && data.check_runs.length === total) return { ok: true, checkRuns: data.check_runs };
      for (const run of data.check_runs) {
        if (!Number.isSafeInteger(run?.id) || run.id <= 0 || seen.has(run.id)) return incomplete();
        seen.add(run.id); runs.push(run);
      }
      if (runs.length === total) return { ok: true, checkRuns: runs };
      if (runs.length > total || data.check_runs.length < 100) return incomplete();
    }
    return incomplete();
  } catch (error) { return failure(`red-team check runs unreadable: ${message(error)}; operator must inspect full check history`); }
}
/** Re-derive a carried/ruling settlement from live gate evidence; never override a live round.
 * Serialize with all run writers, verify live evidence before and after publication, and supersede on failure. */
export function publishRedTeamCheckFromLive(options = {}) {
  return withRedTeamCheckLock(options, () => publishRedTeamCheckFromLiveUnlocked(options));
}

function publishRedTeamCheckFromLiveUnlocked({ repo, pr, headSha, appId, gh = runGhSync,
  env = process.env, readLive, readComments, readStandingRuling = standingRulingScope,
  holdFn = redTeamEnqueueHold, onConfirmed } = {}) {
  let published = false, publishedRun, failureRun;
  try {
    if (!validApp(appId) || !validHead(headSha) || !prIdentity(repo, pr))
      return failure('invalid red-team check identity or WE_APP_ID; operator must inspect configuration');
    const suppliedGh = gh;
    gh = (args, options = {}) => suppliedGh(args, { ...options,
      env: { ...(options.env ?? env), WE_GH_READ_MEMO_DIR: '' },
      throttle: { ...options.throttle, env: { ...env, WE_GH_READ_MEMO_DIR: '' } } });
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
      if (!hasCompletedResult(comments, pr, headSha, disposition.result, env))
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
        const dates = resultRecords(comments, pr, headSha, disposition.result, env).map(comment => Date.parse(comment.created_at ?? comment.createdAt));
        // A result produced during a round cannot resolve that round's later failure.
        const failedAt = Date.parse(latest.completed_at);
        if (!dates.length || dates.some(date => !Number.isFinite(date)) || !Number.isFinite(failedAt)
          || Math.max(...dates) <= failedAt)
          throw Error('trusted live result not demonstrably newer than failed check; operator must inspect result and run timestamps');
      }
      return runs;
    };
    const snapshot = run => JSON.stringify([run.id, run.status, run.conclusion, run.output, run.completed_at]);
    const newest = inspect();
    // A retry whose earlier attempt already published this helper's success (its settlement failed, so the outbox
    // marker stayed) re-validated it just now, under the writers' lock, with nothing newer on the head: that success
    // is the confirmed one. Posting another per retry would exhaust the 100-run check history the gate reads (#6606
    // red team on c639d9ba1: the recovery pass retries once per cooldown, without a cap).
    if (newest[0] && isLiveCheckRun(newest[0]) && newest[0].status === 'completed' && newest[0].conclusion === 'success')
      return confirmed();
    const before = newest.map(snapshot);
    // Reuse a slot without removing the deciding successful round. Updating an older
    // id does not move it to the front of GitHub's creation-ordered history.
    const replaceRun = newest.length >= 100 ? liveCheckReplacement(newest) : undefined;
    publishedRun = replaceRun;
    failureRun = replaceRun ? newest[0] : undefined;
    let postedId;
    const posted = postRedTeamCheckRunUnlocked({ repo, pr, headSha, appId, env, replaceRun,
      gh: (args, options) => {
        // A timeout can lose the response after GitHub accepted the success. Treat every attempted
        // write as potentially published so errors still attempt failure supersession.
        const writing = args.includes('POST') || args.includes('PATCH');
        if (writing) published = true;
        const response = gh(args, options);
        if (!writing) return response;
        // The response id distinguishes our check from a racing writer's check.
        postedId = JSON.parse(response)?.id;
        if (!Number.isSafeInteger(postedId) || postedId <= 0) throw Error('published check id unreadable');
        publishedRun = { id: postedId };
        // The POST rejection fallback can also replace an existing run. A validation
        // failure must supersede the newest run, since an older failure cannot hold it.
        failureRun = newest.some(run => run.id === postedId) ? newest[0] : undefined;
        return response;
      }, payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: null, liveCheck: true }) });
    if (!posted.ok) throw Error(posted.reason);
    const after = inspect();
    const replacedIndex = newest.findIndex(run => run.id === postedId);
    const publishedIndex = replacedIndex < 0 ? 0 : replacedIndex;
    const publishedCheck = after[publishedIndex];
    if (publishedCheck?.id !== postedId || (replaceRun && postedId !== replaceRun.id)
      || !isLiveCheckRun(publishedCheck) || publishedCheck.status !== 'completed' || publishedCheck.conclusion !== 'success'
      || after.length !== before.length + (replacedIndex < 0 ? 1 : 0)
      || before.some((record, index) => index !== replacedIndex
        && snapshot(after[index + (replacedIndex < 0 ? 1 : 0)]) !== record))
      throw Error('another red-team check raced publication');
  } catch (error) {
    const reason = `live red-team check not clear: ${message(error)}`;
    if (published) {
      const supersede = postRedTeamCheckRunUnlocked({ repo, pr, headSha, gh, env, replaceRun: failureRun ?? publishedRun,
        payload: redTeamCheckRunPayload({ repo, pr, headSha, status: 'finished', hold: reason, liveCheck: true }) });
      if (!supersede.ok) return failure(`${reason}; ${supersede.reason}; operator must retry publication`);
    }
    return failure(reason);
  }
  return confirmed();

  // Settlement stays under the writers' lock. A failed settlement keeps the caller's retry;
  // retries revalidate and reuse a confirmed success without consuming another suite slot.
  function confirmed() {
    if (!onConfirmed) return { ok: true };
    let settled;
    try { settled = onConfirmed(); } catch (error) { settled = failure(`carried-check settlement failed: ${message(error)}`); }
    return { ok: true, settled };
  }
}


// Keep the extra publisher acceptance checks local: the gate parser contract is unchanged in slice 1.
function resultRecords(comments, pr, head, result, env) {
  return comments.filter(comment => {
    if (!isTrustedMarkerAuthor(comment)) return false;
    const parsed = readRedTeamDisposition({ comments: [comment], pr, head, env }).result;
    return parsed && redTeamResultId(parsed) === redTeamResultId(result);
  });
}
function hasCompletedResult(comments, pr, head, result, env) {
  const records = resultRecords(comments, pr, head, result, env);
  return records.length > 0 && records.every(comment => {
    const body = String(comment.body ?? '');
    const verdict = /^Advisory only:.* · recorded verdict `(accept|changes|needs-human)`\.$/m.exec(body)?.[1];
    const completed = verdict && (result.findings.length || (verdict === 'accept'
      && /^The red team tried to break this change and reported nothing\.$/m.test(body)));
    const marker = `<!-- we:red-team-advisory pr=${Number(pr)} rev=${head} -->`;
    const lines = body.slice(body.indexOf(marker)).split('\n').filter(line => line.trim());
    const policyClear = body.includes(marker) && lines.length === 2 && lines[0] === marker
      && /^Red team not required on this head: [^\p{Cc}\p{Zl}\p{Zp}]*[^\s\p{Cc}][^\p{Cc}\p{Zl}\p{Zp}]*$/u.test(lines[1]);
    return completed || policyClear;
  });
}
