/**
 * The fix daemon's verify-verdict pass — we:backlog/5137-harness-owns-the-verify-wait-not-the-model.md slices 2+3.
 *
 * A fixer used to hold its turn open on `verify-lane.mjs check --wait=540000`, re-running it on every 9-minute
 * timeout (measured: 54 timeouts / ~486 min on 2026-10-05, 15 / ~135 min 12:00–15:30 ET on 2026-10-06). Now it
 * commits, runs `verify-lane.mjs request`, records the wait (`await-verify.mjs mark --ref=… --kind=…`) and ends
 * its turn. This pass, run once per fix-daemon tick, reads every recorded wait and applies a fixed policy:
 *
 *   - verdict still running            → wait (no model turn spent)
 *   - green for EXACTLY the recorded sha, the lane still at that sha, clean, and the verified tree hash equal
 *     to the lane's tree now           → the harness pushes THAT sha (never force) to the recorded `lane/*` ref,
 *                                        then resumes the SAME session to finish its hand-back
 *   - no verdict (absent, infrastructure failure, unproven tree, overdue) → re-request, up to `maxRetries`,
 *                                        then resume with the blocked-on-infra exit
 *   - red only on timeouts the gate already re-ran alone → resume with a saved-fix hold in WE, a re-dispatch hold elsewhere
 *                                        (the existing quiet-host reverify pass then owns the saved fix)
 *   - red on attempt `maxReds`         → resume with the gate-red exit (the escalation ladder counts it)
 *   - any other red                    → resume the SAME session with the failing tests attached
 *   - the lane moved / went dirty      → resume: the record no longer describes the lane
 *
 * The gate is never weakened: nothing is pushed unless {@link classifyAwaitVerdict} answers `push`, and the push
 * names the verdict's own sha. Pure core + injectable IO, like we:scripts/conveyor/load-flake-reverify.mjs.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listStoredAwaitVerify, writeStoredAwaitVerify, clearStoredAwaitVerify, clearAwaitVerifyRecord,
  resolveAwaitVerifyTtlMs, AWAIT_VERIFY_REF_RE, AWAIT_VERIFY_KINDS, AWAIT_VERIFY_NO_PUSH_KINDS,
} from './await-verify.mjs';
import { readVerifyMarker, verifyGateDecision } from '../lib/lane-verify.mjs';
import { computeWorkingTreeHash } from '../lib/verify-lane-gate.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { laneGitConfigArgs, laneGitHardeningEnv, laneFilterDrivers, LANE_CONFIG_LIST_ARGS } from '../lib/lane-git-hardening.mjs';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { readFixDispatchClaim } from './fix-claim-store.mjs';
import { listWrappedWorkerAgents, requestWrappedResume } from '../operations/worker-wrapper-launch.mjs';
import { AGENT_GONE_STATES } from './lease-reaper.mjs';
import { loadFixPushPolicy, formatFixPushPolicyLine } from '../lib/fix-push-policy.mjs';
import { listSalvage, writeSalvage, clearSalvage, planSalvage, resolveSalvageTuning, salvageKey, stashCommit, salvageStoreDir } from './verified-push-salvage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Policy limits. `maxReds` counts the record's own `attempt` (the fixer bumps it on each re-mark). */
export const AWAIT_VERIFY_LIMITS = Object.freeze({ maxReds: 3, maxRetries: 2, maxResumeFailures: 3 });
/** Repo keys with a quiet-host reverify worker (mirrors stand-down.mjs#LOAD_FLAKE_REVERIFY_REPOS). */
export const AWAIT_LOAD_FLAKE_REPO_KEYS = Object.freeze(['we']);
const repoKeyOrNull = (slug) => { try { return repoKeyForSlug(slug) ?? null; } catch { return null; } };

const SHA_RE = /^[a-f\d]{40}$/i;
const lower = (s) => String(s ?? '').toLowerCase();

/** A delivery or prepare wait: no PR yet, nothing for the harness to push (the session's own `open-pr` does). */
export const isNoPushRecord = (record) => AWAIT_VERIFY_NO_PUSH_KINDS.includes(record?.kind);

/** Is this a record the pass owns (written by `mark --ref`)? */
export function isHarnessRecord(record) {
  return !!record && record.v === 1
    && ((Number.isInteger(record.pr) && record.pr > 0) || (isNoPushRecord(record) && Number.isInteger(record.item) && record.item > 0))
    && SHA_RE.test(String(record.sha ?? '')) && typeof record.lane === 'string' && record.lane.startsWith('/')
    && AWAIT_VERIFY_REF_RE.test(String(record.ref ?? '')) && !String(record.ref).includes('..')
    && AWAIT_VERIFY_KINDS.includes(record.kind) && Number.isFinite(Date.parse(record.requestedAt));
}

/**
 * A red the gate itself classified as load-only: every failing file was re-run alone, every retried file failed
 * only on Vitest timeouts, and no failing test sits outside the retried set. Pure.
 */
export function isLoadFlakeRed(marker) {
  const retried = Array.isArray(marker?.retriedFailures) ? marker.retriedFailures : [];
  if (!retried.length || !retried.every((f) => f?.kind === 'timeout' && typeof f.file === 'string')) return false;
  const files = new Set(retried.map((f) => f.file));
  const tests = Array.isArray(marker?.failureDetails?.tests) ? marker.failureDetails.tests : [];
  return tests.every((t) => files.has(t?.file));
}

/**
 * The one decision for one record. Pure.
 * @param {{record:object, marker:object|null, lane:{head:string|null, dirty:boolean, treeHash:string|null}|null,
 *   nowMs:number, ttlMs:number, limits?:object}} input
 * @returns {{action:'skip'|'wait'|'push'|'rerequest'|'resume', reason:string, resume?:string}}
 */
export function classifyAwaitVerdict({ record, marker, lane, nowMs, ttlMs, limits = AWAIT_VERIFY_LIMITS }) {
  if (!isHarnessRecord(record)) return { action: 'skip', reason: 'not-harness-record' };
  if (record.pendingResume?.kind) return { action: 'resume', reason: 'pending-resume', resume: record.pendingResume.kind };
  if (!lane || !lane.head) return { action: 'resume', reason: 'lane-unreadable', resume: 'void' };
  if (lower(lane.head) !== lower(record.sha)) return { action: 'resume', reason: 'lane-moved', resume: 'void' };
  // A fix pushes its committed sha, so a dirty lane voids the wait. A delivery/prepare wait pushes nothing: its tree hash
  // (which covers uncommitted work) is proven against the marker below instead.
  if (lane.dirty && !isNoPushRecord(record)) return { action: 'resume', reason: 'lane-dirty', resume: 'void' };
  const rerequest = (reason) => ((record.retries ?? 0) >= limits.maxRetries
    ? { action: 'resume', reason: `${reason}; retries exhausted`, resume: 'infra' }
    : { action: 'rerequest', reason });
  // Exact-sha only: no `laneRelevantChangeSince`, so a verdict recorded for any other sha never counts here.
  const v = verifyGateDecision({ record: marker, headSha: lower(record.sha), nowMs, requireVerified: true });
  if (v.status === 'green') {
    if (lower(marker?.sha) !== lower(record.sha)) return rerequest('green-for-other-sha');
    if (!marker?.treeHash || !lane.treeHash || marker.treeHash !== lane.treeHash) return rerequest('tree-unproven');
    return isNoPushRecord(record) ? { action: 'resume', reason: 'green', resume: 'green' } : { action: 'push', reason: 'green' };
  }
  if (v.status === 'running') {
    const age = nowMs - Date.parse(record.requestedAt);
    return age > ttlMs ? rerequest('verify-overdue') : { action: 'wait', reason: 'running' };
  }
  if (v.status === 'red') {
    if (!isNoPushRecord(record) && AWAIT_LOAD_FLAKE_REPO_KEYS.includes(repoKeyOrNull(record.repo)) && isLoadFlakeRed(marker)) return { action: 'resume', reason: 'red-load-flake', resume: 'load-flake' };
    if (!isNoPushRecord(record) && !AWAIT_LOAD_FLAKE_REPO_KEYS.includes(repoKeyOrNull(record.repo)) && isLoadFlakeRed(marker)) return { action: 'resume', reason: 'red-load-flake', resume: 'load-flake-redispatch' };
    if ((record.attempt ?? 1) >= limits.maxReds) return { action: 'resume', reason: `red on attempt ${record.attempt}`, resume: 'escalate' };
    return { action: 'resume', reason: 'red', resume: 'red' };
  }
  return rerequest(v.status || 'no-verdict'); // absent / corrupt / infrastructure-failure
}

const isCiHeal = (record) => record.kind === 'ci-heal';
const brief = (record) => (isCiHeal(record) ? 'CI-heal brief' : record.kind === 'delivery' ? 'delivery brief' : record.kind === 'prepare' ? 'prepare brief' : 'fix brief');
const failureLines = (marker) => {
  const tests = Array.isArray(marker?.failureDetails?.tests) ? marker.failureDetails.tests.slice(0, 15) : [];
  const lines = tests.map((t) => `- ${t.file} > ${t.name}`);
  const summary = String(marker?.failureDetails?.summary ?? '').slice(0, 2500);
  return `${lines.join('\n') || '- (no per-test detail recorded)'}${summary ? `\n\nSummary:\n${summary}` : ''}`;
};

/** The resume message for a delivery or prepare wait (no PR, no push): every branch names the brief's own next step. Pure. */
function buildNoPushResumePrompt({ kind, record, marker, detail, head, next }) {
  const where = brief(record);
  const resumeAt = record.kind === 'prepare'
    ? "step 5 (the adversarial review of your prepare pass), or `open-pr` if you already ran it"
    : "the step right after the gate you handed off (step 6, `/converge`, after the step-5 gate; `open-pr` after the final-HEAD gate)";
  switch (kind) {
    case 'green':
      return `${head}\n\nVerify is GREEN for exactly this sha. The harness pushed NOTHING: your own \`open-pr\` publishes the ref. Continue your ${where} at ${resumeAt}. If you changed any file since marking, \`request\` and mark again first.`;
    case 'red':
      return `${head}\n\nVerify is RED for this sha. Failing tests:\n${failureLines(marker)}\n\nRepair the failure in this lane (same scope rules), then \`verify-lane.mjs request\`, ${next.charAt(0).toLowerCase()}${next.slice(1)}`;
    case 'escalate':
      return `${head}\n\nVerify is RED again (attempt ${record.attempt}; limit ${AWAIT_VERIFY_LIMITS.maxReds}). Do not attempt another repair. Take your ${where}'s gate-red hard stop under *Escalations* with the failing check below.\n\n${failureLines(marker)}`;
    case 'infra':
      return `${head}\n\nThe verify gate produced no verdict after ${record.retries ?? 0} harness re-requests (${detail || 'no verdict'}). Do not re-request. Take your ${where}'s blocked-on-infra exit with that evidence.`;
    default:
      return `${head}\n\nYour lane ${record.lane} no longer matches the recorded wait (${detail || 'HEAD moved'}). \`request\` again for the current HEAD, mark again, and end your turn.`;
  }
}

/**
 * The message the resumed session receives. Pure. Every variant names the sha, the attempt, and the exact next
 * step in the session's own brief, and repeats the one invariant: the session never pushes `{{LANE_REF}}` itself.
 */
export function buildAwaitVerifyResumePrompt({ kind, record, marker = null, detail = '' }) {
  const subject = isNoPushRecord(record) ? `item #${record.item} (${record.repo})` : `PR #${record.pr} (${record.repo})`;
  const head = `[harness verify verdict — #5137] ${subject}, sha ${record.sha}, attempt ${record.attempt ?? 1}.`;
  const next = `Re-mark with --attempt=${(record.attempt ?? 1) + 1} after committing and re-requesting, then end your turn again.`;
  // fix.pushBeforeGate: this red sha is ALREADY on the PR branch. The claim is still yours and must stay held until a green.
  const earlyRed = record.earlyPush?.ok && lower(record.earlyPush.sha) === lower(record.sha)
    ? `\n\nThis sha is already on ${record.ref} (pushed before the gate, push-before-gate). You still hold the fix claim: keep it. Repair with a NEW commit on top (never amend, rebase or force), and the harness pushes that one too. Never hand back, re-arm review or fix-end on a red head except through the gate-red / load-flake exits.`
    : '';
  if (isNoPushRecord(record) && ['green', 'red', 'escalate', 'infra', 'void'].includes(kind)) return buildNoPushResumePrompt({ kind, record, marker, detail, head, next });
  switch (kind) {
    case 'green': {
      const pushed = `Verify is GREEN for exactly this sha and the harness has PUSHED it to ${record.ref}${detail ? ` (${detail})` : ''}. Do not push ${record.ref} again.`;
      // The two briefs end differently: a CI-heal's only PR write is the restart-surviving tally comment (no evidence comment, no hand-back).
      return isCiHeal(record)
        ? `${head}\n\n${pushed} Continue your ${brief(record)} at step 7: post the durable CI-heal comment (\`ci-heal-mark.mjs\` — the attempt tally that survives restarts), then its completion report (\`--outcome=no-change|healed\`) and fix-end. Touch no label.`
        : `${head}\n\n${pushed} Continue your ${brief(record)} from the step after the push: post the before/after evidence comment (cite this green verdict), then the hand-back and the closing completion report + fix-end.`;
    }
    case 'push-rejected':
      return isCiHeal(record)
        ? `${head}\n\nVerify is GREEN, but the harness could NOT push ${record.sha} to ${record.ref}: ${detail}. The remote moved: follow your ${brief(record)}'s non-fast-forward path — reconcile with the current PR head, commit, run \`verify-lane.mjs request\`, then ${next.charAt(0).toLowerCase()}${next.slice(1)} Never force-push, and do not exit yet.`
        : `${head}\n\nVerify is GREEN, but the harness could NOT push ${record.sha} to ${record.ref}: ${detail}. Follow your ${brief(record)}'s "push rejected because the branch moved" path (save to the alt branch, record the pause, fix-end). Never force-push.`;
    case 'push-transient':
      return `${head}\n\nVerify is GREEN, but GitHub kept failing the harness push of ${record.sha} to ${record.ref} even after retries: ${detail}. This is a temporary GitHub outage, not a moved branch, and the harness has kept the verified commit and keeps retrying the push itself. Do not push ${record.ref} yourself and do not use the alt branch. Take your ${brief(record)}'s blocked-on-infra exit with \`--cause=transient\` on the completion report (so the retry cool-off is short), then fix-end.`;
    case 'push-refused':
      return `${head}\n\nVerify is GREEN, but the harness did NOT push ${record.sha} to ${record.ref}: ${detail}. This is not a moved branch, so rebasing or re-marking cannot help and you must not retry or push ${record.ref} yourself. Take your ${brief(record)}'s blocked-on-infra exit with that reason as the evidence, then fix-end.`;
    case 'red':
      return `${head}\n\nVerify is RED for this sha. Failing tests:\n${failureLines(marker)}\n\nRepair the failure in your lane (same scope rules), commit, run \`verify-lane.mjs request\`, then ${next.charAt(0).toLowerCase()}${next.slice(1)} If the red is only timeouts that pass alone under host load, take the brief's load-flake exit instead.${earlyRed}`;
    case 'load-flake-redispatch':
      return `${head}\n\nVerify is RED only on timeouts the gate already re-ran alone (load-flake):\n${failureLines(marker)}\n\nTake your ${brief(record)}'s load-flake exit. No reverify worker can push a saved fix in this repo. Record the re-dispatch hold (\`--head\` is the PR's own head, never your repair sha — a mismatched head ends the hold at once): \`node "${ROOT}/scripts/conveyor/stand-down.mjs" ${record.pr} --repo=${record.repo} --who=${record.who} --reason=load-flake --head="$(git rev-parse origin/${record.ref})" --detail="verify red only on host-load timeouts the gate re-ran alone"\`, then \`node "${ROOT}/scripts/operations/completion-cli.mjs" report --repo=${record.repo} --pr=${record.pr} --session=${record.who} --kind=${record.kind} --status=done --outcome=blocked-on-load-flake\` and \`node "${ROOT}/scripts/conveyor/fix-procedure.mjs" fix-end ${record.pr} --repo=${record.repo} --who=${record.who}\`. The quiet-host pass ends the hold so the fix loop re-dispatches a fixer against the same review findings.`;
    case 'load-flake':
      return `${head}\n\nVerify is RED only on timeouts the gate already re-ran alone (load-flake):\n${failureLines(marker)}\n\nTake your ${brief(record)}'s load-flake exit with --alt-sha=${record.sha} (push this sha to the alt branch named there, never to ${record.ref}), then report blocked-on-load-flake and fix-end. The quiet-host reverify pass retries it.`;
    case 'escalate':
      return `${head}\n\nVerify is RED again (attempt ${record.attempt}; limit ${AWAIT_VERIFY_LIMITS.maxReds}). Do not attempt another repair. Take your ${brief(record)}'s gate-red exit (stand-down --reason=gate-red with the failing check below, completion report, fix-end).\n\n${failureLines(marker)}${earlyRed ? `\n\nThis red sha is already on ${record.ref} (push-before-gate): the gate-red stand-down keeps the PR held; do not re-arm review.` : ''}`;
    case 'infra':
      return `${head}\n\nThe verify gate produced no verdict after ${record.retries ?? 0} harness re-requests (${detail || 'no verdict'}). Do not re-request. Take your ${brief(record)}'s blocked-on-infra exit with that evidence, then fix-end.`;
    case 'void':
      return `${head}\n\nYour lane ${record.lane} no longer matches the recorded wait (${detail || 'HEAD moved or the tree is dirty'}), so the harness will not push it. Make sure the repair is committed in that lane, run \`verify-lane.mjs request\`, mark again, and end your turn.`;
    default:
      return `${head}\n\nThe harness could not act on your recorded verify wait (${kind}: ${detail}). Re-check the lane, request verify, mark again, and end your turn.`;
  }
}

/**
 * Find the session row a record speaks for. A record that names a session id binds to THAT session only — a
 * replacement fixer reusing the same `who` name must never receive the old session's verdict. Only a record with
 * no session id falls back to the newest row with its `who` name. Pure.
 */
export function findAwaitSession(record, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (record.sessionId) return list.find((r) => r?.sessionId === record.sessionId) ?? null;
  return list.filter((r) => r?.name === record.who).sort((a, b) => (b?.startedAt ?? 0) - (a?.startedAt ?? 0))[0] ?? null;
}

/**
 * {@link findAwaitSession} over a listing that may be INCOMPLETE (its non-enumerable `incomplete` names each population
 * that could not be read, as `{reason, session}`). A session missing from an incomplete listing is unknown, not gone, so this THROWS and the
 * pass's per-record catch keeps the record for the next tick (PR #4462 review: reading it as gone dropped the record
 * and skipped a verified push). A name-only binding (no session id) is also unsafe on an incomplete listing: the
 * unread population may hold a newer same-named session. Pure.
 */
export function lookupAwaitSession(record, listed) {
  const session = findAwaitSession(record, listed);
  // Only gaps that could hide THIS record's session count: a whole-population failure (`session: null`), or the unreadable
  // record of a session by this record's name. One unrelated torn file must not pin every other await record forever.
  const gaps = (Array.isArray(listed?.incomplete) ? listed.incomplete : []).filter((g) => g?.session == null || g.session === record.who);
  if (gaps.length && (!session || !record.sessionId)) {
    throw new Error(`session listing incomplete (${gaps.map((g) => g?.reason ?? String(g)).join('; ')}); cannot tell whether ${record.who ?? 'the session'} is gone`);
  }
  return session;
}

/**
 * Why the daemon must NOT push for this record, or null. The fixer typed `repo`/`pr`/`ref`, so they bind to nothing until
 * proven: `repo` must be a constellation repo, and the fix claim for (repo, pr) must be bound to THIS session's id and name
 * this very branch. A claim whose TTL lapsed during a long verify still counts while no one else has re-claimed the PR (a
 * re-claim replaces the entry, so it then names another session); a missing session id or claim never does. Pure.
 */
export function claimBindingRefusal({ repo, pr, ref, sessionId, readClaim }) {
  const repoKey = repoKeyOrNull(repo);
  if (!repoKey) return `refusing to push ${ref}: ${repo} is not a constellation repo`;
  if (!sessionId) return `refusing to push ${ref}: the record names no session id to match against the PR #${pr} fix claim`;
  let claim = null;
  try { claim = readClaim(repoKey, pr); } catch { claim = null; }
  if (!claim) return `refusing to push ${ref}: no fix claim exists for ${repo} PR #${pr}`;
  if (claim.meta?.sessionId !== sessionId) return `refusing to push ${ref}: the fix claim on ${repo} PR #${pr} is not held by this session`;
  if (claim.meta?.branch !== ref) return `refusing to push ${ref}: the fix claim on ${repo} PR #${pr} is for branch ${claim.meta?.branch ?? '(none)'}`;
  return null;
}

const BUSY = new Set(['working', 'running', 'busy', 'starting']);
/**
 * Is the session mid-turn? A live background session whose turn ENDED lists as `state:'working', status:'idle'`
 * (found live 2026-10-07 on fix-4151: the pass pushed its green, then deferred the resume forever as "busy").
 * `status` is the turn signal when present; `state` only for rows without one. Pure.
 */
export function isSessionBusy(session) {
  const status = String(session?.status ?? '').toLowerCase();
  if (status) return status !== 'idle';
  return BUSY.has(String(session?.state ?? '').toLowerCase());
}
/**
 * fix.pushBeforeGate — is the harness owed an EARLY push of this record's sha (before any verify verdict)? Only a `fix`
 * wait, only while no verdict exists yet (`wait`, or `rerequest` with the lane still at the recorded sha and clean — the
 * classifier answers `resume` for a moved or dirty lane before either), and only until that sha's early push is done or
 * its transient retries are spent. A known red is never pushed early: a red verdict classifies `resume`. Pure.
 */
export function isEarlyPushOwed({ record, decision, policy, limits = AWAIT_VERIFY_LIMITS }) {
  if (policy?.pushBeforeGate !== true) return false;
  if (!isHarnessRecord(record) || record.kind !== 'fix' || record.pendingResume) return false;
  if (decision?.action !== 'wait' && decision?.action !== 'rerequest') return false;
  const ep = record.earlyPush;
  if (!ep || lower(ep.sha) !== lower(record.sha)) return true;
  return !ep.done && (ep.attempts ?? 0) <= limits.maxRetries;
}

/**
 * Push the recorded sha now, through the SAME port (and so the same claim/ref/PR bindings, never --force) as the
 * green push. The fix claim is untouched: it stays held until the green verdict's hand-back, so review, ci-heal,
 * draft promotion and the drain keep refusing the PR meanwhile. Returns the log row, or null when nothing was tried.
 */
function runEarlyPush({ io, record, nowMs, policy, persist }) {
  const base = { action: 'early-push', reason: `push-before-gate (${policy?.source ?? 'standard'})` };
  let session;
  try { session = lookupAwaitSession(record, io.listSessions()); } catch (e) { return { ...base, result: `deferred: ${String(e?.message ?? e).split('\n')[0]}` }; }
  if (!session) return null; // the main flow below handles a gone session; nothing is pushed for it
  const prior = record.earlyPush && lower(record.earlyPush.sha) === lower(record.sha) ? record.earlyPush : null;
  const attempts = (prior?.attempts ?? 0) + 1;
  if (!persist({ ...record, earlyPush: { sha: record.sha, attempts, done: false } })) return { ...base, result: 'persist-failed; not sent' };
  const pushed = io.push({ lane: record.lane, sha: record.sha, ref: record.ref, repo: record.repo, pr: record.pr, who: record.who, sessionId: record.sessionId }) ?? {};
  const at = new Date(nowMs).toISOString();
  // A non-transient refusal is not retried early: the green push re-tries it and routes the outcome as it does today.
  const done = !!pushed.ok || !pushed.transient;
  persist({ ...record, earlyPush: { sha: record.sha, attempts, done, ok: !!pushed.ok, at: pushed.ok ? at : null, ...(pushed.ok ? {} : { reason: String(pushed.reason ?? 'push failed').slice(0, 300) }) } });
  return pushed.ok
    ? { ...base, result: `sent ${String(record.sha).slice(0, 8)} to ${record.ref} at ${at}, before the verify verdict; fix claim still held` }
    : { ...base, result: `not sent (${pushed.reason ?? 'push failed'})${done ? '' : '; retry next tick'}` };
}

/** Records already acted on to completion whose store entry could not be deleted (see `clearOrNote`). */
const UNCLEARABLE_DONE = new Set();
/** The last fix-push-policy line this process logged (see runAwaitVerifyPass). */
const LOGGED_POLICY_LINE = { value: null };

/**
 * Apply the policy to every stored record once. Every effect is an injected port, so the whole pass replays
 * offline (see the test's fix-4115 replay).
 * @returns {Promise<{rows:object[]}>}
 */
export async function runAwaitVerifyPass({
  io, nowMs = Date.now(), ttlMs = resolveAwaitVerifyTtlMs(), limits = AWAIT_VERIFY_LIMITS, allowResume = true,
  resumedUnclearable = UNCLEARABLE_DONE, pushPolicy = null, loggedPolicyLine = LOGGED_POLICY_LINE,
} = {}) {
  const rows = [];
  /** Clear a finished record. One that cannot be removed would stay actionable (another push / resume next tick), so it is
   *  remembered for this daemon's lifetime and never acted on again. Returns whether the record is really gone. */
  const clearOrNote = (key, record) => {
    const cleared = io.clearRecord(key, record)?.cleared !== false;
    if (!cleared) resumedUnclearable.add(`${key}|${record.requestedAt}`);
    return cleared;
  };
  // fix.pushBeforeGate (we:scripts/lib/fix-push-policy.mjs): an injected policy wins; else the IO's own; else OFF (today's flow).
  const policy = pushPolicy ?? (typeof io.pushPolicy === 'function' ? io.pushPolicy() : null);
  for (const { key, record: stored } of io.listRecords()) {
    let record = stored;
    const row = { key, pr: record?.pr ?? null, repo: record?.repo ?? null, sha: record?.sha ?? null };
    try {
      const lane = isHarnessRecord(record) && !record.pendingResume ? io.laneState(record.lane, { hashDirty: isNoPushRecord(record) }) : null;
      const marker = lane ? io.readMarker(record.lane) : null;
      const d = classifyAwaitVerdict({ record, marker, lane: record.pendingResume ? { head: record.sha } : lane, nowMs, ttlMs, limits });
      Object.assign(row, { action: d.action, reason: d.reason });
      // Every counter that bounds an effect is persisted BEFORE the effect, and a failed write skips the effect: a store that
      // went unwritable would otherwise reload the old counters every tick and repeat the request / push / resume forever.
      const persist = (next) => {
        if (io.writeRecord(next)?.ok === true) { record = next; return true; }
        row.result = `${row.result ? `${row.result}; ` : ''}persist-failed`;
        return false;
      };
      if (isEarlyPushOwed({ record, decision: d, policy, limits })) {
        const early = runEarlyPush({ io, record, nowMs, policy, persist: (next) => (io.writeRecord(next)?.ok === true ? ((record = next), true) : false) });
        // `record` now carries `earlyPush`; the rest of this record's handling (re-request, resume) keeps it.
        if (early) rows.push({ key, pr: record.pr, repo: record.repo, sha: record.sha, ...early });
      }
      if (d.action === 'skip' || d.action === 'wait') { rows.push(row); continue; }
      if (d.action === 'rerequest') {
        if (!persist({ ...record, retries: (record.retries ?? 0) + 1, requestedAt: new Date(nowMs).toISOString(), lastRetry: d.reason })) { rows.push(row); continue; }
        const r = io.rerequest(record.lane);
        row.result = r?.status ?? (r?.ok ? 'requested' : 'request-failed');
        rows.push(row); continue;
      }
      if (resumedUnclearable.has(`${key}|${record.requestedAt}`)) { row.result = 'resumed; record-clear-failed'; rows.push(row); continue; }
      let pending = record.pendingResume ?? null;
      if (d.action === 'push') {
        // A record whose session is not live is never pushed for: the session id is the one thing the claim binding compares.
        if (!lookupAwaitSession(record, io.listSessions())) {
          clearOrNote(key, record);
          row.result = 'session-gone; not pushed';
          rows.push(row); continue;
        }
        const attempt = record.pushRetries ?? 0;
        if (!persist({ ...record, pushRetries: attempt + 1 })) { rows.push(row); continue; }
        const pushed = io.push({ lane: record.lane, sha: record.sha, ref: record.ref, repo: record.repo, pr: record.pr, who: record.who, sessionId: record.sessionId });
        if (!pushed?.ok && pushed?.transient && attempt < limits.maxRetries) {
          // A network/auth hiccup is not a moved branch: retry the same push next tick (the attempt is already counted).
          row.result = `push-retry (${pushed.reason})`;
          rows.push(row); continue;
        }
        // GitHub kept failing: the verified sha is not lost. It is copied into a daemon-owned store and the pass retries
        // the push on later ticks (see verified-push-salvage.mjs); the session is told this is a transient outage.
        const transientGone = !pushed?.ok && pushed?.transient;
        const salvaged = transientGone ? io.saveSalvage?.({ record, nowMs, reason: pushed.reason }) : null;
        pending = pushed?.ok
          ? { kind: 'green', detail: record.earlyPush?.ok && lower(record.earlyPush.sha) === lower(record.sha) ? `on ${record.ref} since ${record.earlyPush.at} (push-before-gate), verified at ${new Date(nowMs).toISOString()}` : `pushed at ${new Date(nowMs).toISOString()}` }
          : transientGone
            ? { kind: 'push-transient', detail: `${pushed.reason}${salvaged?.ok ? ' (the verified commit is saved; the harness keeps retrying the push)' : ''}` }
            : { kind: pushed?.moved ? 'push-rejected' : 'push-refused', detail: pushed?.reason ?? 'push failed' };
        row.result = pushed?.ok ? 'pushed' : (transientGone ? `push-transient${salvaged?.ok ? '; salvaged' : ''}` : (pushed?.moved ? 'push-rejected' : 'push-refused'));
      } else if (!pending) {
        pending = { kind: d.resume, detail: d.reason };
      }
      if (!record.pendingResume) {
        // Keep the marker's failure detail on the record: the next tick may need to re-send this message.
        // A pending resume that cannot be saved is not acted on: the next tick re-decides from the verdict.
        if (!persist({ ...record, pendingResume: { ...pending, ...(marker ? { marker: { failureDetails: marker.failureDetails ?? null } } : {}) } })) { rows.push(row); continue; }
      }
      if (!allowResume) { row.result = row.result ?? 'resume-paused'; rows.push(row); continue; }
      const session = lookupAwaitSession(record, io.listSessions());
      if (!session) {
        clearOrNote(key, record);
        row.result = `${row.result ? `${row.result}; ` : ''}session-gone`;
        rows.push(row); continue;
      }
      if (isSessionBusy(session)) { row.result = row.result ?? 'session-busy'; rows.push(row); continue; }
      const prompt = buildAwaitVerifyResumePrompt({
        kind: record.pendingResume.kind, record, marker: record.pendingResume.marker ?? marker, detail: record.pendingResume.detail,
      });
      const failures = (record.resumeFailures ?? 0) + 1;
      if (!persist({ ...record, resumeFailures: failures })) { rows.push(row); continue; }
      const resumed = io.resume({ session, prompt });
      if (resumed?.resumed) {
        const cleared = clearOrNote(key, record);
        row.result = `${row.result ? `${row.result}; ` : ''}resumed:${record.pendingResume.kind}${cleared ? '' : '; record-clear-failed'}`;
      } else if (failures >= limits.maxResumeFailures) {
        clearOrNote(key, record);
        row.result = `${row.result ? `${row.result}; ` : ''}resume-exhausted`;
      } else {
        row.result = `${row.result ? `${row.result}; ` : ''}resume-failed (${resumed?.reason ?? 'unconfirmed'})`;
      }
    } catch (error) {
      row.action = row.action ?? 'error';
      row.result = `error: ${String(error?.message ?? error).split('\n')[0]}`;
    }
    rows.push(row);
  }
  if (io.listSalvage) rows.push(...runSalvagePhase({ io, nowMs }));
  // Name the layer that set fix.pushBeforeGate: once per process, and again whenever the effective value changes.
  const policyLine = policy ? formatFixPushPolicyLine(policy) : null;
  // A row (not a result field) so the slot-aware wrapper in await-verify-loop.mjs, which rebuilds the result, keeps it.
  if (policyLine && policyLine !== loggedPolicyLine.value) { loggedPolicyLine.value = policyLine; rows.unshift({ key: null, action: 'policy', result: policyLine }); }
  return { rows };
}

/** Re-try every saved green-verified sha whose push GitHub failed. Every outcome is a row (and so a log line). */
export function runSalvagePhase({ io, nowMs, tuning = resolveSalvageTuning() }) {
  const rows = [];
  for (const { key, record } of io.listSalvage()) {
    const row = { key, pr: record.pr, repo: record.repo, sha: record.sha, action: 'salvage' };
    try {
      const plan = planSalvage(record, { nowMs, tuning });
      row.reason = plan.reason;
      if (plan.action === 'drop') { io.clearSalvage(key); row.result = `dropped: ${plan.reason}; ${record.sha.slice(0, 8)} was never pushed to ${record.ref}`; rows.push(row); continue; }
      if (plan.action === 'wait') { row.action = 'skip'; rows.push(row); continue; }
      const attempts = (record.attempts ?? 0) + 1;
      const next = { ...record, attempts, nextAttemptAt: new Date(nowMs + tuning.retryMs * attempts).toISOString() };
      if (io.writeSalvage(next)?.ok !== true) { row.result = 'persist-failed'; rows.push(row); continue; }
      const r = io.salvagePush(next);
      if (r?.ok) { io.clearSalvage(key); row.result = `pushed (attempt ${attempts})`; }
      else if (r?.terminal) { io.clearSalvage(key); row.result = `dropped: ${r.reason}`; }
      else row.result = `retry later (attempt ${attempts}): ${r?.reason ?? 'push failed'}`;
    } catch (error) {
      row.result = `error: ${String(error?.message ?? error).split('\n')[0]}`;
    }
    rows.push(row);
  }
  return rows;
}

/** One log line per acted-on record (waits are summarized, not listed). */
export function formatAwaitVerifyLines(result) {
  const rows = result?.rows ?? [];
  const waiting = rows.filter((r) => r.action === 'wait').length;
  const lines = rows.filter((r) => r.action !== 'wait' && r.action !== 'skip')
    .map((r) => r.action === 'policy' ? `await-verify: ${r.result}` : `await-verify: ${r.repo} PR #${r.pr} @ ${String(r.sha ?? '').slice(0, 8)} — ${r.action} (${r.reason})${r.result ? ` → ${r.result}` : ''}`);
  if (waiting) lines.push(`await-verify: ${waiting} session(s) awaiting a verdict`);
  return lines;
}

// ── IO shell ───────────────────────────────────────────────────────────────────────────────────────────────
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `https://github.com/<owner>/<repo>/pull/<n>` → `https://github.com/<owner>/<repo>.git`; null for anything else. */
export function repoUrlFromPrUrl(prUrl) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(String(prUrl ?? ''));
  return m ? `https://github.com/${m[1]}.git` : null;
}

/**
 * How the harness push retries a transient GitHub failure (a 500 mid-push lost a verified fix on 2026-10-07).
 * `WE_AWAIT_VERIFY_PUSH_ATTEMPTS` (default 4, 1..10), `WE_AWAIT_VERIFY_PUSH_BACKOFF_MS` (base, default 2000),
 * `WE_AWAIT_VERIFY_PUSH_BACKOFF_CAP_MS` (default 30000). The wait doubles per attempt up to the cap. Pure.
 */
export function resolvePushRetryTuning(env = process.env) {
  const num = (key, dflt, min, max) => {
    const raw = env?.[key];
    const n = Number(raw);
    return raw === undefined || raw === '' || !Number.isFinite(n) || n < min ? dflt : Math.min(max, Math.floor(n));
  };
  return {
    attempts: num('WE_AWAIT_VERIFY_PUSH_ATTEMPTS', 4, 1, 10),
    baseMs: num('WE_AWAIT_VERIFY_PUSH_BACKOFF_MS', 2_000, 0, 600_000),
    capMs: num('WE_AWAIT_VERIFY_PUSH_BACKOFF_CAP_MS', 30_000, 0, 600_000),
  };
}

const PUSH_MOVED_RE = /non-fast-forward|fetch first|stale info/i;
const PUSH_TRANSIENT_RE = /Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|HTTP (?:code )?5\d\d|returned error: 5\d\d|error: 5\d\d\b|time[sd]? ?out|Connection (?:reset|refused|closed)|Could not resolve host|unable to access|RPC failed|hung up unexpectedly|early EOF|SSL_ERROR|GnuTLS|Empty reply|cannot lock ref|temporarily unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

/**
 * Classify git's whole stderr for a failed push. A real "moved" rejection wins; then a transient infrastructure
 * failure (a `[remote rejected] ... (Internal Server Error)` line contains the word "rejected" but is NOT a moved
 * branch, which is how the verified fix for PR #4244 was reported as moved and thrown away); anything else that
 * says rejected/declined/protected stays a rejection; an empty stderr from a killed child is a timeout. Pure.
 * @returns {'moved'|'transient'|'rejected'|'unknown'}
 */
export function classifyPushFailure(stderr, { killed = false } = {}) {
  const text = String(stderr ?? '');
  if (PUSH_MOVED_RE.test(text)) return 'moved';
  if (PUSH_TRANSIENT_RE.test(text) || (killed && !text.trim())) return 'transient';
  if (/rejected|hook declined|protected/i.test(text)) return 'rejected';
  return 'unknown';
}

/**
 * Push `sha` to `refs/heads/<ref>` at `url` WITHOUT reading the lane's git config. The lane is agent-writable, so its
 * `remote.*`, `url.*.insteadOf`, `credential.helper` and filter-driver keys are untrusted input to the daemon. The
 * push therefore runs in a throwaway bare repo the daemon owns (its config is empty; the host's global config —
 * the user's credential helper — still applies), reading the lane's commits through
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` (git follows the lane's own alternates chain). Never `--force`: a moved branch is
 * rejected, not overwritten. Returns the remote's sha after the push; on failure throws git's error carrying
 * `pushKind` ('transient' once the bounded backoff is spent, 'moved' | 'rejected' | 'unknown') and, for a moved
 * branch, `remoteHead` and `diverged`.
 *
 * Transient failures (5xx, timeouts, resets) are retried with bounded exponential backoff ({@link resolvePushRetryTuning}).
 * A "moved" rejection is re-checked against the remote: when the remote head is an ancestor of `sha` (or equals it)
 * the push is repeated / already satisfied; only a remote head that is NOT an ancestor is reported as moved by someone else.
 */
export function pushShaFromScratch({ laneGitDir, url, sha, ref, exec = execFileSync, env = process.env, tmpRoot = tmpdir(), timeout = 180_000, sleep = sleepSync, tuning = resolvePushRetryTuning(env) }) {
  const scratch = mkdtempSync(join(tmpRoot, 'await-verify-push-'));
  try {
    const clean = { ...env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete clean[k];
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...clean, GIT_TERMINAL_PROMPT: '0', GIT_ALTERNATE_OBJECT_DIRECTORIES: join(laneGitDir, 'objects') }, timeout };
    exec('git', ['init', '--bare', '--quiet', scratch], opts);
    // `core.hooksPath=/dev/null`: the host's global hooks (guard-git-push) are not this call's gate — the ref/PR checks in
    // `defaultAwaitVerifyIo.push` are — and a hook path is the one way git would run a script from a repo directory.
    const run = (args) => String(exec('git', ['--git-dir', scratch, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], opts));
    const tagged = (error, pushKind, extra = {}) => Object.assign(error instanceof Error ? error : new Error(String(error)), { pushKind, ...extra });
    /** Where the remote head stands relative to `sha`: 'equal' | 'ancestor' (push again) | 'contains' (already there) | 'diverged' | 'unknown'. */
    const reconcile = () => {
      let head;
      try {
        run(['fetch', '--no-tags', '--quiet', url, `refs/heads/${ref}`]);
        head = run(['rev-parse', 'FETCH_HEAD']).trim();
      } catch { return { state: 'unknown' }; }
      if (head.toLowerCase() === sha.toLowerCase()) return { state: 'equal', head };
      const isAncestor = (a, b) => { try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
      if (isAncestor(head, sha)) return { state: 'ancestor', head };
      if (isAncestor(sha, head)) return { state: 'contains', head };
      return { state: 'diverged', head };
    };
    let reconciled = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        run(['push', url, `${sha}:refs/heads/${ref}`]);
        break;
      } catch (e) {
        const kind = classifyPushFailure(String(e?.stderr ?? e?.message ?? e), { killed: !!(e?.killed || e?.code === 'ETIMEDOUT') });
        const last = attempt >= tuning.attempts;
        if (kind === 'transient') {
          if (last) throw tagged(e, 'transient', { attempts: attempt });
          sleep(Math.min(tuning.capMs, tuning.baseMs * 2 ** (attempt - 1)));
          continue;
        }
        if (kind === 'moved' || kind === 'unknown') {
          // A response lost after the remote applied the push, or a branch that only advanced to our own ancestor line.
          const r = reconcile();
          if (r.state === 'equal' || r.state === 'contains') return { remote: r.head, alreadyThere: true };
          if (r.state === 'ancestor' && !reconciled && !last) { reconciled = true; continue; }
          if (r.state === 'diverged') throw tagged(e, 'moved', { diverged: true, remoteHead: r.head });
          if (r.state === 'unknown' && kind === 'unknown' && !last) { sleep(Math.min(tuning.capMs, tuning.baseMs * 2 ** (attempt - 1))); continue; }
          throw tagged(e, kind === 'moved' ? 'moved' : 'unknown', { remoteHead: r.head ?? null });
        }
        throw tagged(e, kind);
      }
    }
    let remote = '';
    try { remote = run(['ls-remote', url, `refs/heads/${ref}`]).split(/\s/)[0]; } catch { /* the push itself succeeded; a failed read-back is not a rejection */ }
    return { remote };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Real ports; every seam is injectable so the push/resume guarantees below are testable without git or claude.
 *
 * The lane is agent-writable, so its own `.git/config` is untrusted input to the daemon: every git call turns off
 * `core.fsmonitor`, lane hooks (`core.hooksPath=/dev/null` — a hook runs lane-relative scripts, so ANY hooks path
 * would still execute lane code) and `core.attributesFile`, and pins `core.sshCommand`; the one `git diff` (the tree
 * hash) adds `--no-ext-diff` — NOT `-c diff.external=`, which makes every `git diff` die with "cannot run ''".
 * The `guard-git-push` hook does not run (hooks are off, by design): its job is done by checks the daemon makes
 * itself, in {@link defaultAwaitVerifyIo}'s `push` — the ref must match `lane/*` (`AWAIT_VERIFY_REF_RE`, so `main` is
 * unreachable) and equal the head ref of the OPEN PR. Neither the push nor the worktree reads (`laneState`) use the
 * lane's config at all — a daemon-owned scratch git dir with the lane's index/objects stands in for it, so a lane
 * `filter.*` / textconv / diff driver is undefined and never runs. The push in particular:
 * {@link pushShaFromScratch} pushes to the URL GitHub reports for the PR's repo from a daemon-owned scratch repo, so
 * the PR check, the fix claim and the push target are bound to one slug (a lane `remote.origin.url`, `insteadOf`,
 * credential helper or filter driver is never consulted).
 */
export async function defaultAwaitVerifyIo({
  weRoot = ROOT, exec = execFileSync, env = process.env, sleep = sleepSync,
  dispatchIo = null, stopSessionFn = null, pushRefusalFn = null, readClaimFn = null, poolRoot = null, realpath = realpathSync,
  pidAliveFn = pidAlive,
  listWrappedWorkers = listWrappedWorkerAgents, requestWrappedResumeFn = requestWrappedResume,
} = {}) {
  /** The lane pool the daemon acts in. A record's `lane` is agent-typed, so a path outside the pool is never touched. */
  const lanePoolRoot = poolRoot ?? defaultPoolRoot(weRoot, env);
  const outsidePool = (lane) => {
    try {
      const real = realpath(lane);
      const root = realpath(lanePoolRoot);
      return real === root || !real.startsWith(`${root}${sep}`) ? `${lane} is not inside the lane pool` : null;
    } catch { return `${lane} is not inside the lane pool`; }
  };
  const io = dispatchIo ?? await import('../operations/dispatch-lane-io.mjs');
  const stopSession = stopSessionFn ?? (await import('../operations/dispatch-abort.mjs')).stopSession;
  const fixProcedure = pushRefusalFn && readClaimFn ? null : await import('./fix-procedure.mjs');
  const pushRefusal = pushRefusalFn ?? fixProcedure.pushRefusal;
  /** The raw (live or not) fix-claim entry for (repo key, pr), or null. */
  const readClaim = readClaimFn ?? ((repoKey, pr) => readFixDispatchClaim({ repo: repoKey, pr, kind: fixProcedure.FIXING_KIND }));
  const hardening = laneGitConfigArgs();
  const git = (lane, args, opts = {}) => String(exec('git', ['-C', lane, ...hardening, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, ...opts }));
  /**
   * The head branch of the PR, whether it is OPEN, and the git URL of the repo the PR lives in — all read from GitHub
   * (never from the lane or the record). Null when unresolved.
   */
  const prHead = (repo, pr) => {
    try {
      const out = String(exec('gh', ['pr', 'view', String(pr), '--repo', String(repo), '--json', 'headRefName,state,url,isCrossRepository', '--jq', '.state + " " + .url + " " + (.isCrossRepository|tostring) + " " + .headRefName'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60_000 })).trim();
      const [state, url, cross, ...rest] = out.split(' ');
      return state && url && cross && rest.length ? { open: state === 'OPEN', ref: rest.join(' '), remoteUrl: repoUrlFromPrUrl(url), crossRepo: cross !== 'false' } : null;
    } catch { return null; }
  };
  return {
    // fix.pushBeforeGate through the policy cascade, re-read every pass so a settings flip applies without a restart.
    pushPolicy: () => loadFixPushPolicy({ env }),
    listRecords: () => listStoredAwaitVerify(),
    writeRecord: (record) => writeStoredAwaitVerify(record),
    clearRecord: (key, record) => {
      const store = clearStoredAwaitVerify(key);
      if (record?.lane && !outsidePool(record.lane)) clearAwaitVerifyRecord(record.lane);
      return { cleared: store.cleared };
    },
    laneState: (lane, { hashDirty = false } = {}) => {
      let scratch = null;
      try {
        if (outsidePool(lane)) return null;
        // Refs and the git dir are read through the lane's config (no worktree content is touched, so no filter/textconv runs).
        const head = git(lane, ['rev-parse', 'HEAD']).trim();
        const laneGitDir = git(lane, ['rev-parse', '--absolute-git-dir']).trim();
        // Everything that reads WORKTREE CONTENT (status/diff/untracked/hash) runs against a daemon-owned scratch git dir whose
        // config is empty, with the lane's index + objects: a lane-config `filter.*` / `diff.*.textconv` driver (selected by an
        // in-repo .gitattributes) is then undefined, so it can never execute in the daemon (#5137 review).
        scratch = mkdtempSync(join(tmpdir(), 'await-verify-state-'));
        exec('git', ['init', '--bare', '--quiet', scratch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
        const exclude = join(laneGitDir, 'info', 'exclude'); // gitignore syntax only; keeps untracked-file selection equal to verify-lane's
        if (existsSync(exclude)) { mkdirSync(join(scratch, 'info'), { recursive: true }); copyFileSync(exclude, join(scratch, 'info', 'exclude')); }
        const owned = (args) => String(exec('git', ['--git-dir', scratch, '--work-tree', lane, ...hardening, ...args],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: lane, env: { ...env, GIT_INDEX_FILE: join(laneGitDir, 'index'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(laneGitDir, 'objects') } })).trim();
        const dirty = owned(['diff', '--no-ext-diff', '--no-textconv', '--name-only', head, '--']).length > 0
          || owned(['ls-files', '--others', '--exclude-standard']).length > 0;
        // Same runner shape as verify-lane.mjs (`git(...).trim()`): an untrimmed `git diff` ends in "\n", so the hashes would never match.
        const runGit = (a) => {
          if (a[0] === 'merge-base') return git(lane, a).trim();
          if (a[0] === 'diff') return owned(['diff', '--no-ext-diff', '--no-textconv', ...a.slice(1)]);
          if (a[0] === 'hash-object') return owned(['hash-object', '--no-filters', ...a.slice(1)]);
          return owned(a);
        };
        const treeHash = dirty && !hashDirty ? null : computeWorkingTreeHash({ runGit, fileMode: (f) => lstatSync(join(lane, f)).mode });
        return { head, dirty, treeHash };
      } catch { return null; } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
    },
    readMarker: (lane) => {
      try { return outsidePool(lane) ? null : readVerifyMarker(git(lane, ['rev-parse', '--absolute-git-dir']).trim()); } catch { return null; }
    },
    rerequest: (lane) => {
      const outside = outsidePool(lane);
      if (outside) return { ok: false, status: 'lane-refused', reason: outside };
      // A clean filter runs on worktree content during the child's `git diff`, and the env cannot switch it off (an in-repo
      // `.gitattributes` or `.git/info/attributes` chooses where it applies): refuse a lane that defines one. Fail closed.
      try {
        const drivers = laneFilterDrivers(git(lane, LANE_CONFIG_LIST_ARGS));
        if (drivers.length) return { ok: false, status: 'lane-refused', reason: `the lane's git config defines filter driver(s) ${drivers.join(', ')}` };
      } catch { return { ok: false, status: 'lane-refused', reason: 'the lane\'s git config could not be read' }; }
      try {
        const out = String(exec(process.execPath, [join(weRoot, 'scripts', 'verify-lane.mjs'), 'request', '--json', `--repo=${lane}`],
          // The child runs git in the agent-writable lane itself, so its git config is pinned through the environment.
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: laneGitHardeningEnv(env), timeout: 120_000 }));
        return { ok: true, ...JSON.parse(out.trim().split('\n').pop() || '{}') };
      } catch (e) {
        try { return { ok: false, ...JSON.parse(String(e?.stdout ?? '').trim().split('\n').pop()) }; } catch { return { ok: false, status: 'request-failed' }; }
      }
    },
    push: ({ lane, sha, ref, repo, pr, who, sessionId }) => {
      // Never reached for `main` (or any non-`lane/*` ref), whatever hook is or is not installed: a guarantee of this port.
      if (!AWAIT_VERIFY_REF_RE.test(String(ref ?? '')) || String(ref).includes('..')) return { ok: false, reason: `refusing to push ${ref}: not a lane/* ref` };
      // `repo` and `pr` were typed by the fixer: the push goes only to a constellation repo, and only for a PR whose fix claim
      // THIS session holds, on this very branch. Without it a session could mark another repo/PR and have the daemon push
      // (with host credentials, outside the guard-git-push hook) onto a branch it was never dispatched for.
      const outside = outsidePool(lane);
      if (outside) return { ok: false, reason: `refusing to push ${ref}: ${outside}` };
      const binding = claimBindingRefusal({ repo, pr, ref, sessionId, readClaim });
      if (binding) return { ok: false, reason: binding };
      const refusal = pushRefusal({ repo, branch: ref, sessionId, who });
      if (refusal?.refused) return { ok: false, reason: refusal.message };
      // The record's ref was typed by the fixer: bind it to the PR it claims to be repairing before pushing.
      const head = prHead(repo, pr);
      if (!head) return { ok: false, transient: true, reason: `could not resolve the head ref of ${repo} PR #${pr}` };
      if (head.ref !== ref) return { ok: false, reason: `recorded ref ${ref} is not PR #${pr}'s head (${head.ref}); refusing to push` };
      if (!head.open) return { ok: false, reason: `PR #${pr} is not open; refusing to push ${ref}` };
      // A fork PR's head branch lives in the FORK; pushing `lane/x` to the base repo would create a stray branch and report it pushed.
      if (head.crossRepo) return { ok: false, reason: `PR #${pr} is from a fork; refusing to push ${ref} to the base repo` };
      if (!head.remoteUrl) return { ok: false, reason: `PR #${pr}'s URL is not a github.com pull URL; refusing to push ${ref}` };
      let laneGitDir;
      try { laneGitDir = git(lane, ['rev-parse', '--absolute-git-dir']).trim(); } catch { return { ok: false, transient: true, reason: `could not read the git dir of ${lane}` }; }
      try {
        // Never --force, so a moved branch is rejected, not overwritten; never the lane's own `origin` (see pushShaFromScratch).
        const { remote, alreadyThere } = pushShaFromScratch({ laneGitDir, url: head.remoteUrl, sha, ref, exec, env, timeout: 180_000, sleep });
        // An empty read-back (ls-remote failed after a push that succeeded) is not a rejection; only a DIFFERENT sha is.
        if (!alreadyThere && remote && lower(remote) !== lower(sha)) return { ok: false, moved: true, reason: `remote ${ref} is ${remote.slice(0, 8)} after push` };
      } catch (e) {
        const stderr = String(e?.stderr ?? e?.message ?? e);
        const detail = stderr.trim().split('\n').filter((l) => l.trim() && !/^hint:/i.test(l)).slice(-3).join(' ').slice(0, 300);
        const kind = e?.pushKind ?? classifyPushFailure(stderr);
        if (kind === 'transient') return { ok: false, transient: true, moved: false, reason: `GitHub was unavailable for ${e?.attempts ?? 1} push attempt(s): ${detail}` };
        if (e?.diverged) return { ok: false, moved: true, diverged: true, reason: `${ref} was moved by someone else: remote head ${String(e.remoteHead ?? '').slice(0, 8)} is not an ancestor of the verified ${sha.slice(0, 8)}. ${detail}` };
        const rejected = kind === 'moved' || kind === 'rejected';
        return { ok: false, reason: detail, transient: kind === 'unknown', moved: rejected };
      }
      return { ok: true };
    },
    // ── salvage of a green-verified sha GitHub kept refusing (see verified-push-salvage.mjs) ──
    listSalvage: () => listSalvage(),
    writeSalvage: (record) => writeSalvage(record),
    clearSalvage: (key) => clearSalvage(key),
    saveSalvage: ({ record, nowMs, reason }) => {
      if (isNoPushRecord(record) || outsidePool(record.lane)) return { ok: false };
      const key = salvageKey(record);
      let laneGitDir;
      try { laneGitDir = git(record.lane, ['rev-parse', '--absolute-git-dir']).trim(); } catch { return { ok: false }; }
      const stashed = stashCommit({ exec, laneGitDir, sha: record.sha, key, env });
      if (!stashed.ok) return { ok: false };
      const retryMs = resolveSalvageTuning(env).retryMs;
      return writeSalvage({ v: 1, repo: record.repo, pr: record.pr, ref: record.ref, sha: record.sha, who: record.who ?? null,
        savedAt: new Date(nowMs).toISOString(), nextAttemptAt: new Date(nowMs + retryMs).toISOString(), attempts: 0, lastReason: String(reason ?? '').slice(0, 300) });
    },
    salvagePush: (record) => {
      const key = salvageKey(record);
      // The same PR/ref bindings as a live push; there is no session left to hold the claim, so any OTHER live claim defers it.
      const refusal = pushRefusal({ repo: record.repo, branch: record.ref });
      if (refusal?.refused) return { ok: false, reason: `deferred: ${refusal.message}` };
      const head = prHead(record.repo, record.pr);
      if (!head) return { ok: false, reason: `could not resolve the head ref of ${record.repo} PR #${record.pr}` };
      if (head.ref !== record.ref) return { ok: false, terminal: true, reason: `${record.ref} is no longer PR #${record.pr}'s head (${head.ref})` };
      if (!head.open) return { ok: false, terminal: true, reason: `PR #${record.pr} is no longer open` };
      if (head.crossRepo || !head.remoteUrl) return { ok: false, terminal: true, reason: `PR #${record.pr} is not a same-repo github.com PR` };
      try {
        pushShaFromScratch({ laneGitDir: join(salvageStoreDir(env), `${key}.git`), url: head.remoteUrl, sha: record.sha, ref: record.ref, exec, env, timeout: 180_000, sleep });
        return { ok: true };
      } catch (e) {
        if (e?.diverged) return { ok: false, terminal: true, reason: `${record.ref} was moved by someone else (remote head ${String(e.remoteHead ?? '').slice(0, 8)} is not an ancestor of ${record.sha.slice(0, 8)}); the verified commit was not pushed` };
        if (e?.pushKind === 'transient' || e?.pushKind === 'unknown') return { ok: false, reason: `GitHub still failing: ${String(e?.stderr ?? e?.message ?? e).trim().split('\n').slice(-1)[0].slice(0, 200)}` };
        return { ok: false, terminal: true, reason: `GitHub refused the push: ${String(e?.stderr ?? e?.message ?? e).trim().split('\n').slice(-1)[0].slice(0, 200)}` };
      }
    },
    // Both populations are listed, and a failure of either is RECORDED on the result (`incomplete`), never swallowed: the
    // pass reads a session's absence as "gone", so it must be told when the listing could not show it (`lookupSession`).
    listSessions: () => {
      const rows = [];
      const incomplete = [];
      const why = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);
      // `session: null` = the whole population is unknown; a slug = only that session's record could not be read.
      // A listing that is not an ARRAY shows nothing about any session (a string would even spread into character "rows").
      const asRows = (value, what) => { if (!Array.isArray(value)) throw new Error(`${what} is not an array`); return value; };
      try { rows.push(...asRows(io.defaultListAgents({ all: true, env }), 'claude agents listing')); } catch (e) { incomplete.push({ reason: `claude agents listing failed: ${why(e)}`, session: null }); }
      try {
        const wrapped = asRows(listWrappedWorkers(), 'wrapped worker listing');
        rows.push(...wrapped);
        incomplete.push(...(wrapped.incomplete ?? []));
      } catch (e) { incomplete.push({ reason: `wrapped worker listing failed: ${why(e)}`, session: null }); }
      return Object.defineProperty(rows, 'incomplete', { value: incomplete });
    },
    resume: ({ session, prompt }) => {
      if (session?.kind === 'wrapped-worker') return requestWrappedResumeFn({ session, prompt });
      // Every read this port makes of the session list is UNCACHED: the 20s agents cache would otherwise show a
      // pre-stop / pre-spawn row and misjudge both the exit wait and the resume confirmation.
      const liveEnv = { ...env, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
      // A background session whose turn ended is still a live process, and `--bg --resume` on a live session
      // "starts a copy" instead of continuing it (found live 2026-10-07: two forked copies, no resume). Stop the
      // idle process first; `--resume` then wakes the SAME id. The pass never gets here for a busy session.
      // A gone session (the reaper's own AGENT_GONE_STATES: done/failed/stopped) has no process to stop or wait on.
      const isGone = (row) => AGENT_GONE_STATES.has(String(row?.state ?? '').toLowerCase());
      if (!isGone(session)) {
        // `claude stop` takes the SHORT job id; a full session uuid answers "No job matching" (read as already
        // gone) and leaves the process running, so the resume forked again (found live 2026-10-07, fix-4151).
        const handle = session.id || String(session.sessionId).slice(0, 8);
        // Only a background dispatch is ever stopped: an operator's own terminal session (`kind:'interactive'`) is
        // never ours to kill. STRICT, like the session reaper's guard: a row must positively say `kind:'background'`,
        // so a missing or empty kind fails closed, and the freshly-read row is held to the same rule below.
        const notBackground = (row) => ({ resumed: false, reason: `stop-before-resume: ${row?.kind || 'unknown-kind'} session is not a background dispatch` });
        if (session.kind !== 'background') return notBackground(session);
        // This session's row right now, read UNCACHED (the 20s agents cache would hand back the very row the pass
        // already judged): the row, null when it is not listed, or undefined when the list cannot be read.
        const liveRow = () => { try { return io.defaultListAgents({ all: true, env: liveEnv }).find((s) => s?.sessionId === session.sessionId) ?? null; } catch { return undefined; } };
        // The pass saw it idle a moment ago; a new turn since then must not be killed mid-flight. An unreadable list
        // cannot show that, so it refuses too (the next tick retries).
        const before = liveRow();
        if (before === undefined) return { resumed: false, reason: 'stop-before-resume: session list unreadable' };
        if (before && before.kind !== 'background') return notBackground(before);
        if (before && isSessionBusy(before)) return { resumed: false, reason: 'stop-before-resume: session started a new turn' };
        try { stopSession({ handle }); } catch (e) { return { resumed: false, reason: `stop-before-resume: ${String(e?.message ?? e).split('\n')[0]}` }; }
        // With a known pid, the process itself is the exit signal. Without one (a swallowed "No job matching"
        // looks the same), only a row that EXPLICITLY lists a gone state (done/failed/stopped) counts: an unreadable
        // list or a missing row is "unknown", never "exited".
        const knownPid = Number.isInteger(session.pid) && session.pid > 0;
        const exited = () => (knownPid ? !pidAliveFn(session.pid) : isGone(liveRow()));
        for (let i = 0; i < 20 && !exited(); i += 1) sleep(500);
        if (!exited()) return { resumed: false, reason: 'stop-before-resume: process still alive' };
        sleep(1_000);
      }
      const argv = io.buildAgentArgv({ payload: { prompt }, resumeSessionId: session.sessionId });
      let stdout = '';
      try { stdout = String(io.defaultSpawnAgent(argv, { cwd: session.cwd }) ?? ''); } catch (e) { return { resumed: false, reason: String(e?.message ?? e).split('\n')[0] }; }
      const printedId = io.parseBackgroundedId(stdout);
      let outcome = { resumed: false };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        outcome = io.resumeSucceeded({ printedId, requestedSessionId: session.sessionId, agentsAfter: io.defaultListAgents({ all: true, env: liveEnv }) });
        if (outcome.resumed || attempt === 3) break;
        sleep(2_000);
      }
      // Only a DIFFERENT printed id is a forked copy to stop; the requested session itself is never the cleanup target.
      const forked = Boolean(printedId) && printedId !== session.sessionId;
      if (!outcome.resumed && forked) { try { stopSession({ handle: printedId }); } catch { /* best-effort cleanup of the copy */ } }
      return { resumed: !!outcome.resumed, reason: outcome.resumed ? null : (forked ? 'forked-copy-stopped' : (printedId ? 'resume-unconfirmed' : 'no-backgrounded-id')) };
    },
  };
}

/** The daemon's entry: real IO, one pass. Never throws. */
export async function runAwaitVerifyPassDefault({ allowResume = true } = {}) {
  try {
    return await runAwaitVerifyPass({ io: await defaultAwaitVerifyIo(), allowResume });
  } catch (error) {
    return { rows: [{ action: 'error', result: `error: ${String(error?.message ?? error).split('\n')[0]}` }] };
  }
}
