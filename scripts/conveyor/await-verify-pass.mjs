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
 *   - red only on timeouts the gate already re-ran alone (load-flake), WE only → resume with the load-flake exit
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
  resolveAwaitVerifyTtlMs, AWAIT_VERIFY_REF_RE, AWAIT_VERIFY_KINDS,
} from './await-verify.mjs';
import { readVerifyMarker, verifyGateDecision } from '../lib/lane-verify.mjs';
import { computeWorkingTreeHash } from '../lib/verify-lane-gate.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { laneGitConfigArgs, laneGitHardeningEnv, laneFilterDrivers, LANE_CONFIG_LIST_ARGS } from '../lib/lane-git-hardening.mjs';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { readFixDispatchClaim } from './fix-claim-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Policy limits. `maxReds` counts the record's own `attempt` (the fixer bumps it on each re-mark). */
export const AWAIT_VERIFY_LIMITS = Object.freeze({ maxReds: 3, maxRetries: 2, maxResumeFailures: 3 });
/** Repo keys with a quiet-host reverify worker (mirrors stand-down.mjs#LOAD_FLAKE_REVERIFY_REPOS). */
export const AWAIT_LOAD_FLAKE_REPO_KEYS = Object.freeze(['we']);
const repoKeyOrNull = (slug) => { try { return repoKeyForSlug(slug) ?? null; } catch { return null; } };

const SHA_RE = /^[a-f\d]{40}$/i;
const lower = (s) => String(s ?? '').toLowerCase();

/** Is this a record the pass owns (written by `mark --ref`)? */
export function isHarnessRecord(record) {
  return !!record && record.v === 1 && Number.isInteger(record.pr) && record.pr > 0
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
  if (lane.dirty) return { action: 'resume', reason: 'lane-dirty', resume: 'void' };
  const rerequest = (reason) => ((record.retries ?? 0) >= limits.maxRetries
    ? { action: 'resume', reason: `${reason}; retries exhausted`, resume: 'infra' }
    : { action: 'rerequest', reason });
  // Exact-sha only: no `laneRelevantChangeSince`, so a verdict recorded for any other sha never counts here.
  const v = verifyGateDecision({ record: marker, headSha: lower(record.sha), nowMs, requireVerified: true });
  if (v.status === 'green') {
    if (lower(marker?.sha) !== lower(record.sha)) return rerequest('green-for-other-sha');
    if (!marker?.treeHash || !lane.treeHash || marker.treeHash !== lane.treeHash) return rerequest('tree-unproven');
    return { action: 'push', reason: 'green' };
  }
  if (v.status === 'running') {
    const age = nowMs - Date.parse(record.requestedAt);
    return age > ttlMs ? rerequest('verify-overdue') : { action: 'wait', reason: 'running' };
  }
  if (v.status === 'red') {
    if (AWAIT_LOAD_FLAKE_REPO_KEYS.includes(repoKeyOrNull(record.repo)) && isLoadFlakeRed(marker)) return { action: 'resume', reason: 'red-load-flake', resume: 'load-flake' };
    if ((record.attempt ?? 1) >= limits.maxReds) return { action: 'resume', reason: `red on attempt ${record.attempt}`, resume: 'escalate' };
    return { action: 'resume', reason: 'red', resume: 'red' };
  }
  return rerequest(v.status || 'no-verdict'); // absent / corrupt / infrastructure-failure
}

const isCiHeal = (record) => record.kind === 'ci-heal';
const brief = (record) => (isCiHeal(record) ? 'CI-heal brief' : 'fix brief');
const failureLines = (marker) => {
  const tests = Array.isArray(marker?.failureDetails?.tests) ? marker.failureDetails.tests.slice(0, 15) : [];
  const lines = tests.map((t) => `- ${t.file} > ${t.name}`);
  const summary = String(marker?.failureDetails?.summary ?? '').slice(0, 2500);
  return `${lines.join('\n') || '- (no per-test detail recorded)'}${summary ? `\n\nSummary:\n${summary}` : ''}`;
};

/**
 * The message the resumed session receives. Pure. Every variant names the sha, the attempt, and the exact next
 * step in the session's own brief, and repeats the one invariant: the session never pushes `{{LANE_REF}}` itself.
 */
export function buildAwaitVerifyResumePrompt({ kind, record, marker = null, detail = '' }) {
  const head = `[harness verify verdict — #5137] PR #${record.pr} (${record.repo}), sha ${record.sha}, attempt ${record.attempt ?? 1}.`;
  const next = `Re-mark with --attempt=${(record.attempt ?? 1) + 1} after committing and re-requesting, then end your turn again.`;
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
    case 'push-refused':
      return `${head}\n\nVerify is GREEN, but the harness did NOT push ${record.sha} to ${record.ref}: ${detail}. This is not a moved branch, so rebasing or re-marking cannot help and you must not retry or push ${record.ref} yourself. Take your ${brief(record)}'s blocked-on-infra exit with that reason as the evidence, then fix-end.`;
    case 'red':
      return `${head}\n\nVerify is RED for this sha. Failing tests:\n${failureLines(marker)}\n\nRepair the failure in your lane (same scope rules), commit, run \`verify-lane.mjs request\`, then ${next.charAt(0).toLowerCase()}${next.slice(1)} If the red is only timeouts that pass alone under host load, take the brief's load-flake exit instead.`;
    case 'load-flake':
      return `${head}\n\nVerify is RED only on timeouts the gate already re-ran alone (load-flake):\n${failureLines(marker)}\n\nTake your ${brief(record)}'s load-flake exit with --alt-sha=${record.sha} (push this sha to the alt branch named there, never to ${record.ref}), then report blocked-on-load-flake and fix-end. The quiet-host reverify pass retries it.`;
    case 'escalate':
      return `${head}\n\nVerify is RED again (attempt ${record.attempt}; limit ${AWAIT_VERIFY_LIMITS.maxReds}). Do not attempt another repair. Take your ${brief(record)}'s gate-red exit (stand-down --reason=gate-red with the failing check below, completion report, fix-end).\n\n${failureLines(marker)}`;
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
/** Records already acted on to completion whose store entry could not be deleted (see `clearOrNote`). */
const UNCLEARABLE_DONE = new Set();

/**
 * Apply the policy to every stored record once. Every effect is an injected port, so the whole pass replays
 * offline (see the test's fix-4115 replay).
 * @returns {Promise<{rows:object[]}>}
 */
export async function runAwaitVerifyPass({
  io, nowMs = Date.now(), ttlMs = resolveAwaitVerifyTtlMs(), limits = AWAIT_VERIFY_LIMITS, allowResume = true,
  resumedUnclearable = UNCLEARABLE_DONE,
} = {}) {
  const rows = [];
  /** Clear a finished record. One that cannot be removed would stay actionable (another push / resume next tick), so it is
   *  remembered for this daemon's lifetime and never acted on again. Returns whether the record is really gone. */
  const clearOrNote = (key, record) => {
    const cleared = io.clearRecord(key, record)?.cleared !== false;
    if (!cleared) resumedUnclearable.add(`${key}|${record.requestedAt}`);
    return cleared;
  };
  for (const { key, record: stored } of io.listRecords()) {
    let record = stored;
    const row = { key, pr: record?.pr ?? null, repo: record?.repo ?? null, sha: record?.sha ?? null };
    try {
      const lane = isHarnessRecord(record) && !record.pendingResume ? io.laneState(record.lane) : null;
      const marker = lane ? io.readMarker(record.lane) : null;
      const d = classifyAwaitVerdict({ record, marker, lane: record.pendingResume ? { head: record.sha } : lane, nowMs, ttlMs, limits });
      Object.assign(row, { action: d.action, reason: d.reason });
      if (d.action === 'skip' || d.action === 'wait') { rows.push(row); continue; }
      // Every counter that bounds an effect is persisted BEFORE the effect, and a failed write skips the effect: a store that
      // went unwritable would otherwise reload the old counters every tick and repeat the request / push / resume forever.
      const persist = (next) => {
        if (io.writeRecord(next)?.ok === true) { record = next; return true; }
        row.result = `${row.result ? `${row.result}; ` : ''}persist-failed`;
        return false;
      };
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
        if (!findAwaitSession(record, io.listSessions())) {
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
        pending = pushed?.ok
          ? { kind: 'green', detail: `pushed at ${new Date(nowMs).toISOString()}` }
          : { kind: pushed?.moved ? 'push-rejected' : 'push-refused', detail: pushed?.reason ?? 'push failed' };
        row.result = pushed?.ok ? 'pushed' : (pushed?.moved ? 'push-rejected' : 'push-refused');
      } else if (!pending) {
        pending = { kind: d.resume, detail: d.reason };
      }
      if (!record.pendingResume) {
        // Keep the marker's failure detail on the record: the next tick may need to re-send this message.
        // A pending resume that cannot be saved is not acted on: the next tick re-decides from the verdict.
        if (!persist({ ...record, pendingResume: { ...pending, ...(marker ? { marker: { failureDetails: marker.failureDetails ?? null } } : {}) } })) { rows.push(row); continue; }
      }
      if (!allowResume) { row.result = row.result ?? 'resume-paused'; rows.push(row); continue; }
      const session = findAwaitSession(record, io.listSessions());
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
  return { rows };
}

/** One log line per acted-on record (waits are summarized, not listed). */
export function formatAwaitVerifyLines(result) {
  const rows = result?.rows ?? [];
  const waiting = rows.filter((r) => r.action === 'wait').length;
  const lines = rows.filter((r) => r.action !== 'wait' && r.action !== 'skip')
    .map((r) => `await-verify: ${r.repo} PR #${r.pr} @ ${String(r.sha ?? '').slice(0, 8)} — ${r.action} (${r.reason})${r.result ? ` → ${r.result}` : ''}`);
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
 * Push `sha` to `refs/heads/<ref>` at `url` WITHOUT reading the lane's git config. The lane is agent-writable, so its
 * `remote.*`, `url.*.insteadOf`, `credential.helper` and filter-driver keys are untrusted input to the daemon. The
 * push therefore runs in a throwaway bare repo the daemon owns (its config is empty; the host's global config —
 * the user's credential helper — still applies), reading the lane's commits through
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` (git follows the lane's own alternates chain). Never `--force`: a moved branch is
 * rejected, not overwritten. Returns the remote's sha after the push; throws git's error on a rejection.
 */
export function pushShaFromScratch({ laneGitDir, url, sha, ref, exec = execFileSync, env = process.env, tmpRoot = tmpdir(), timeout = 180_000 }) {
  const scratch = mkdtempSync(join(tmpRoot, 'await-verify-push-'));
  try {
    const clean = { ...env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete clean[k];
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...clean, GIT_TERMINAL_PROMPT: '0', GIT_ALTERNATE_OBJECT_DIRECTORIES: join(laneGitDir, 'objects') }, timeout };
    exec('git', ['init', '--bare', '--quiet', scratch], opts);
    // `core.hooksPath=/dev/null`: the host's global hooks (guard-git-push) are not this call's gate — the ref/PR checks in
    // `defaultAwaitVerifyIo.push` are — and a hook path is the one way git would run a script from a repo directory.
    const run = (args) => String(exec('git', ['--git-dir', scratch, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], opts));
    run(['push', url, `${sha}:refs/heads/${ref}`]);
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
    listRecords: () => listStoredAwaitVerify(),
    writeRecord: (record) => writeStoredAwaitVerify(record),
    clearRecord: (key, record) => {
      const store = clearStoredAwaitVerify(key);
      if (record?.lane && !outsidePool(record.lane)) clearAwaitVerifyRecord(record.lane);
      return { cleared: store.cleared };
    },
    laneState: (lane) => {
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
        const treeHash = dirty ? null : computeWorkingTreeHash({ runGit, fileMode: (f) => lstatSync(join(lane, f)).mode });
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
        const { remote } = pushShaFromScratch({ laneGitDir, url: head.remoteUrl, sha, ref, exec, env, timeout: 180_000 });
        // An empty read-back (ls-remote failed after a push that succeeded) is not a rejection; only a DIFFERENT sha is.
        if (remote && lower(remote) !== lower(sha)) return { ok: false, moved: true, reason: `remote ${ref} is ${remote.slice(0, 8)} after push` };
      } catch (e) {
        // Classify on git's WHOLE stderr: a real rejection ends in several `hint:` lines that carry none of the keywords.
        const stderr = String(e?.stderr ?? e?.message ?? e);
        const reason = stderr.trim().split('\n').filter((l) => l.trim() && !/^hint:/i.test(l)).slice(-3).join(' ').slice(0, 300);
        const rejected = /rejected|non-fast-forward|fetch first|stale info|hook declined|protected/i.test(stderr);
        return { ok: false, reason, transient: !rejected, moved: rejected };
      }
      return { ok: true };
    },
    listSessions: () => io.defaultListAgents({ all: true, env }),
    resume: ({ session, prompt }) => {
      // A background session whose turn ended is still a live process, and `--bg --resume` on a live session
      // "starts a copy" instead of continuing it (found live 2026-10-07: two forked copies, no resume). Stop the
      // idle process first; `--resume` then wakes the SAME id. The pass never gets here for a busy session.
      if (String(session.state ?? '').toLowerCase() !== 'stopped') {
        // `claude stop` takes the SHORT job id; a full session uuid answers "No job matching" (read as already
        // gone) and leaves the process running, so the resume forked again (found live 2026-10-07, fix-4151).
        const handle = session.id || String(session.sessionId).slice(0, 8);
        try { stopSession({ handle }); } catch (e) { return { resumed: false, reason: `stop-before-resume: ${String(e?.message ?? e).split('\n')[0]}` }; }
        for (let i = 0; i < 20 && pidAlive(session.pid); i += 1) sleep(500);
        if (pidAlive(session.pid)) return { resumed: false, reason: 'stop-before-resume: process still alive' };
        sleep(1_000);
      }
      const argv = io.buildAgentArgv({ payload: { prompt }, resumeSessionId: session.sessionId });
      let stdout = '';
      try { stdout = String(io.defaultSpawnAgent(argv, { cwd: session.cwd }) ?? ''); } catch (e) { return { resumed: false, reason: String(e?.message ?? e).split('\n')[0] }; }
      const printedId = io.parseBackgroundedId(stdout);
      let outcome = { resumed: false };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        outcome = io.resumeSucceeded({ printedId, requestedSessionId: session.sessionId, agentsAfter: io.defaultListAgents({ all: true, env }) });
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
