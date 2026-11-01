#!/usr/bin/env node
/**
 * @file scripts/operations/probation-heal-run.mjs
 * @description THE PROBATION HEAL RUN (agy-launcher-probation, operator 2026-09-27) — the detached per-dispatch
 *   process `dispatch-providers/probation-worker.mjs` starts for one opened, non-critical `ci-heal`. It follows the
 *   same arc as `we:skills-src/conveyor/fix-agent-ci-brief.md`, with the SCRIPT doing every script-decidable step
 *   and the probation worker (Codex / Antigravity-Claude / Antigravity-Gemini) doing only the repair itself:
 *
 *     0. completion `started`, and capture the PR head it is about to examine (EXAMINED_HEAD, #4269);
 *     1. acquire a lane reset to the PR's head ref (`lane-pool.mjs acquire --base=<ref>`);
 *     2. rebase onto `origin/main` — a conflict escalates, exactly as the brief does (no model is spent on it);
 *     3. run the diff-selected gate. `probation-launcher.mjs#workerNeeded` decides whether a model is needed at
 *        all: a clean rebase that turned the gate green is pushed with NO model run;
 *     4. otherwise run the worker SYNCHRONOUSLY through its launcher (`gemini-direct-task.mjs` / `codex-direct-task.mjs`,
 *        both foreground-blocking by design), then re-run the gate;
 *     5. bound the heal diff to the `ci-heal` envelope, and for a worker with a `checker` (Gemini, #3922) get an
 *        `APPROVE` from the checker before anything is pushed;
 *     6. commit (explicit paths, trailers naming the worker), push `--force-with-lease` against EXAMINED_HEAD,
 *        post the durable CI-heal comment (`ci-heal-mark.mjs`), write the completion record;
 *     7. when the worker ran, append one `probation-launch` row to the scorecard store (no outcome yet — the
 *        review decides that; a rebase-only heal is not a trial of the worker and writes no row).
 *
 * FULL REVIEW ON EVERY RESULT. A heal push moves the PR head, and an acceptance is stamped against the head it
 * reviewed (`review-set-label.mjs`'s `restamp` exists only for a head the DRAIN moved), so every pushed heal is
 * reviewed again before it can land. This script never touches a review label and never restamps.
 *
 * NEVER merges, never touches `main`, never releases the lane (same as the brief: the lease ages out).
 * IO lives in the `io` object so the whole arc is testable with fakes; the CLI block at the bottom wires the
 * real processes.
 */

import { parseAgyReportEvidence, pickAgyEvidence } from '../lib/antigravity-run-evidence.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendScorecard as appendScorecardRow } from '../conveyor/run-scorecard-store.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { hookSurfaceChanged, resetHookSurface, snapshotHookSurface, withHooksDisabled } from '../lib/git-hook-surface.mjs';
import {
  buildCheckerArgv, buildCheckerTask, buildCiHealTask, buildHealCommitMessage, buildWorkerArgv,
  healDiffPathsAllowed, healDiffWithinEnvelope, launchScorecardRow, newUntrackedPaths, parseCheckerVerdict, summarizeNumstat, workerNeeded,
} from '../lib/probation-launcher.mjs';

import { resolveOperationRoute, resolvePolicyModel, readRoutingPolicy } from '../lib/dispatch-routing-policy-io.mjs';
import { PROBATION_WORKERS, PROVEN_TASK_ENVELOPES } from '../lib/provider-routing.mjs';

import { DISPATCH_LISTING_GRACE_MINUTES } from './dispatch-lane.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { withCompletionLock, newCompletionRecord, applyCompletionUpdate, writeCompletion } from './completion-store.mjs';
import { releaseFixDispatchClaim } from '../conveyor/fix-dispatch-claim.mjs';
import { buildCiHealComment, handBackCiHealReview, redactSecrets } from '../conveyor/ci-heal-mark.mjs';
import { recordOwedWrite, clearOwedWrite, owedWriteAlreadyLive, postPrComment } from '../conveyor/ci-heal-owed.mjs';
import { fetchFresh } from '../lib/git-fetch-fresh.mjs';

const LISTING_GRACE_MS = DISPATCH_LISTING_GRACE_MINUTES * 60_000;
/** The slowest honest attempt: lane acquire (15m) + gate (20m) + worker (70m) + a margin. Past it no liveness probe is trusted. */
export const HEAL_ATTEMPT_MAX_AGE_MS = 3 * 60 * 60_000;
/** Settled rows are pure history (the attempt cap is counted off PR comments), so the poll drops them after this. */
export const SETTLED_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Redact BEFORE cutting: a cut first can slice a credential's recognisable prefix off and leave its tail unredactable. */
const redactedTail = (text, max) => redactSecrets(String(text ?? '').slice(-(max + REDACT_MARGIN))).slice(-max);
/** Redaction scans at most `max + margin` chars (worker output can be 64 MB); a credential cut by the margin leaves its
 *  fragment inside the margin, which the final cut discards — so redact-before-cut still holds for credentials < margin. */
const REDACT_MARGIN = 4096;

/** The only failure facts a public comment may carry: enum/number/ISO-shaped fields, never free text. */
export function publicFailureEvidence(terminal = {}) {
  const pick = (value, shape) => (typeof value === 'string' && shape.test(value) ? value : 'unknown');
  return `outcome: ${pick(terminal.outcome, /^[a-z][a-z-]{0,40}$/)}; exit: ${Number.isInteger(terminal.exitCode) ? terminal.exitCode : 'unknown'}; `
    + `signal: ${pick(terminal.signal, /^SIG[A-Z0-9]{1,12}$/)}; quota: ${pick(terminal.quotaState, /^[a-z][a-z-]{0,20}$/)}; `
    + `reset: ${pick(terminal.quotaResetsAt, /^\d{4}-\d{2}-\d{2}T[\d:.]{1,20}Z$/)}`;
}
function probeHealPid(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

/** Attempt evidence shares the coordination sidecar across dispatcher and wrapper checkouts. */
export const healAttemptsDir = () => join(resolveCoordinationRoot(), 'ci-heal-attempts');
function attemptPath(id, dir) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id ?? '')) throw new Error('invalid CI-heal attempt identity');
  return join(dir, `${id}.json`);
}
export function readHealAttempt(id, { dir = healAttemptsDir() } = {}) {
  const row = JSON.parse(readFileSync(attemptPath(id, dir), 'utf8'));
  if (row.attemptId !== id || row.repo !== 'we' || !Number.isInteger(row.pr) || row.pr <= 0 || !row.session || !Number.isFinite(Date.parse(row.startedAt)) || !/^[a-f0-9]{40}$/.test(row.headSha ?? '') || (row.terminal && (typeof row.terminal.outcome !== 'string' || typeof row.terminal.pushed !== 'boolean'))) throw new Error('unreadable CI-heal ownership');
  return row;
}
function saveAttempt(row, dir) {
  mkdirSync(dir, { recursive: true });
  const path = attemptPath(row.attemptId, dir), tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(row) + '\n');
  renameSync(tmp, path);
  return row;
}
export function beginHealAttempt(request, { dir = healAttemptsDir(), now = () => new Date().toISOString(), logPathFor = () => null, readHead = pr => realIo().prHead(pr) } = {}) {
  const attemptId = randomUUID();
  const headSha = request.headRefOid ?? readHead(request.pr)?.headRefOid;
  if (!/^[a-f0-9]{40}$/.test(headSha ?? '')) throw new Error('CI-heal attempt requires the examined PR head before launch');
  return saveAttempt({ attemptId, repo: 'we', pr: Number(request.pr), headSha, session: request.sessionSlug,
    startedAt: now(), host: hostname(), logPath: logPathFor(`${request.sessionSlug}-${attemptId}`), runId: request.runId ?? null, effectKey: request.effectKey ?? null,
    claimOwner: request.claimOwner ?? null, claimRoot: request.claimRoot ?? null,
    worker: request.probationWorker, handle: null, terminal: null, published: false }, dir);
}
export function bindHealAttempt(id, handle, { dir = healAttemptsDir() } = {}) {
  return withCompletionLock(id, () => {
    const row = readHealAttempt(id, { dir });
    if (row.host !== hostname() || !/^pid:[1-9][0-9]*$/.test(handle) || (row.handle && row.handle !== handle)) throw new Error('ambiguous CI-heal wrapper ownership');
    return saveAttempt({ ...row, handle }, dir);
  }, { dir });
}

/** Publication is confirmed by a trusted read; an ambiguous write remains owed and blocks new attempts. */
export function publishHealAttempt(row, { readComments = r => JSON.parse(execFileSyncThrottled('gh', ['pr', 'view', String(r.pr), '--repo', REPO_SLUG, '--json', 'comments'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })).comments,
  post = args => postPrComment({ ...args, exec: execFileSyncThrottled }), owe = recordOwedWrite, clear = clearOwedWrite } = {}) {
  const body = buildCiHealComment({ attemptId: row.attemptId, headSha: row.headSha,
    // Structured fields only: the raw worker/log tail stays in the local attempt row (a denylist redactor cannot
    // vouch for arbitrary text under the trusted bot login, #3577 round 2).
    failed: !row.terminal.pushed, detail: publicFailureEvidence(row.terminal), reason: 'red-ci' });
  const rec = { repo: row.repo, slug: REPO_SLUG, pr: row.pr, kind: 'ci-heal', headSha: row.headSha, attemptId: row.attemptId, body };
  owe(rec); // Write BEFORE the external operation, including reads that can fail.
  const comments = readComments(row);
  if (!Array.isArray(comments)) throw new Error('CI-heal trusted comments unreadable');
  if (!owedWriteAlreadyLive(comments, rec)) {
    post({ pr: row.pr, repo: rec.slug, body });
    if (!owedWriteAlreadyLive(readComments(row), rec)) throw new Error('CI-heal durable publication not confirmed');
  }
  clear(rec);
}

export function finishHealAttempt(id, terminal, { dir = healAttemptsDir(), publish = publishHealAttempt,
  complete = row => {
    const record = newCompletionRecord({ session: `ci-heal-${row.attemptId}`, sessionId: row.attemptId, kind: 'ci-heal', pr: row.pr, now: () => row.startedAt });
    writeCompletion(applyCompletionUpdate(record, { status: 'done', outcome: row.terminal.outcome }), join(dir, 'completions'));
  }, release = releaseFixDispatchClaim } = {}) {
  return withCompletionLock(id, () => {
    let row = readHealAttempt(id, { dir });
    if (row.settled === true) return row;
    if (!row.terminal) row = saveAttempt({ ...row, terminal: { ...terminal, detail: redactedTail(terminal.detail ?? 'unknown', 4000),
      ...(terminal.diagnostics == null ? {} : { diagnostics: redactedTail(terminal.diagnostics, 4000) }) } }, dir);
    if (!row.published) {
      publish(row);
      row = saveAttempt({ ...row, published: true }, dir);
    }
    complete(row);
    if (row.claimOwner) release({ repo: row.repo, pr: row.pr, kind: 'ci-heal', owner: row.claimOwner, ...(row.claimRoot ? { lockRoot: row.claimRoot } : {}) });
    return saveAttempt({ ...row, settled: true }, dir);
  }, { dir });
}

/** A launch that threw before any wrapper existed: settle the row as a failed attempt so it cannot block the PR. */
export function failHealAttempt(id, detail, opts = {}) {
  return finishHealAttempt(id, { outcome: 'executor-failed', pushed: false, exitCode: null, signal: null, quotaState: 'unknown', detail: String(detail) }, opts);
}

function attemptLogTail(path) {
  if (!path) return 'unknown (no attempt log)';
  let fd;
  try {
    fd = openSync(path, 'r');
    // Read a wider window than we keep, drop the line the window cut through (its credential prefix may be gone),
    // and redact BEFORE taking the final tail — so no boundary can strand a credential's tail (#3577 round 2).
    const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const text = buffer.toString('utf8'), whole = buffer.length === size;
    return redactedTail(whole ? text : text.slice(text.indexOf('\n') + 1), 2000) || 'unknown (empty attempt log)';
  } catch (error) { return `unknown (attempt log unavailable: ${error.code ?? 'read error'})`; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Only an owned, positively dead wrapper past grace can acquire an orphan terminal outcome. */
export function observeHealAttempt(id, { dir = healAttemptsDir(), handle, pr, repo = 'we', isPidAlive = probeHealPid,
  now = () => new Date(), settle = (attemptId, terminal) => finishHealAttempt(attemptId, terminal, { dir }) } = {}) {
  try {
    const row = readHealAttempt(id, { dir });
    // The host only matters to the pid liveness probe below; a row that already has a terminal outcome (or never
    // had a process) is settled from its own record, so a renamed host can never strand an old row (#3577 review).
    if ((handle && row.handle !== handle) || (pr != null && row.pr !== pr) || row.repo !== repo) throw new Error('ambiguous CI-heal wrapper ownership');
    // A settled row is history: answer from it without taking the completion lock or re-running settlement, so a
    // poll over every row ever written costs reads only (#3577 round 2).
    if (row.settled === true && row.terminal) return { status: 'resolved', result: { attemptId: id, ...row.terminal }, error: row.terminal.pushed ? undefined : row.terminal.detail };
    let detail = null;
    if (!row.terminal) {
      const age = now().getTime() - Date.parse(row.startedAt);
      if (!Number.isFinite(age)) throw new Error('unknown CI-heal start time');
      if (age > HEAL_ATTEMPT_MAX_AGE_MS) {
        // No honest attempt runs this long. A foreign host, a renamed host or a recycled pid would otherwise hold
        // the PR forever, so past the ceiling the row settles as a failure whatever the liveness probe says.
        detail = `attempt exceeded the ${HEAL_ATTEMPT_MAX_AGE_MS / 60_000}-minute ceiling without a terminal outcome (handle ${row.handle ?? 'none'}, host ${row.host ?? 'unknown'}); diagnostics: ${attemptLogTail(row.logPath)}`;
      } else if (!/^pid:[1-9][0-9]*$/.test(row.handle ?? '')) {
        // The launch never bound a wrapper: inside the grace window it may still be binding (fail closed), past it
        // no process can be waited for, so it settles as a failure instead of holding the PR forever (#3577 review).
        if (age < LISTING_GRACE_MS) throw new Error('unknown CI-heal wrapper handle');
        detail = `launch never bound a wrapper handle; whether a process started cannot be told; diagnostics: ${attemptLogTail(row.logPath)}`;
      } else {
        if (row.host !== hostname()) throw new Error('ambiguous CI-heal wrapper ownership');
        const live = isPidAlive(Number(row.handle.slice(4)));
        if (live === true) return { status: 'running', result: null };
        if (live !== false) throw new Error('unknown CI-heal wrapper liveness');
        if (age < LISTING_GRACE_MS) return { status: 'running', result: null };
        detail = `owned wrapper ${row.handle} exited without terminal publication; exit, signal and quota cause unknown; diagnostics: ${attemptLogTail(row.logPath)}`;
      }
    }
    const terminal = row.terminal ?? { outcome: 'executor-failed', pushed: false, exitCode: null, signal: null, quotaState: 'unknown', detail };
    const settled = settle(id, terminal);
    return { status: 'resolved', result: { attemptId: id, ...settled.terminal }, error: settled.terminal.pushed ? undefined : settled.terminal.detail };
  } catch (error) { return { status: 'unresolved', error: String(error.message ?? error) }; }
}

/** The reconcile poll uses exactly the observer boundary, including its fail-closed persistence checks. */
export function pollHealAttempts({ repo = 'we', pr, dir = healAttemptsDir(), observe = observeHealAttempt, now = () => new Date(),
  warn = message => console.error(message) } = {}) {
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.json')).flatMap(name => {
    const id = name.slice(0, -5);
    let row;
    try { row = readHealAttempt(id, { dir }); }
    catch (error) {
      if (error.code === 'ENOENT') return []; // pruned between the listing and the read
      // One bad row must not abort the repo-wide pass: hold only the PR it provably belongs to, and say so loudly.
      let owner = null, idleMs = 0;
      try { owner = JSON.parse(readFileSync(attemptPath(id, dir), 'utf8')); idleMs = now().getTime() - statSync(attemptPath(id, dir)).mtimeMs; } catch { /* owner stays unknown */ }
      // Past the age ceiling an unreadable row can no longer be a live attempt: stop holding the PR (the file stays as evidence).
      if (idleMs > HEAL_ATTEMPT_MAX_AGE_MS) owner = null;
      const ownerPr = Number.isInteger(owner?.pr) && owner.pr > 0 && owner.repo === repo ? owner.pr : null;
      warn(`CI-heal attempt row ${id} is unreadable (${error.message}); ${ownerPr ? `holding PR #${ownerPr} only` : 'its PR is unknown, so it holds none'}`);
      if (pr != null && ownerPr !== pr) return [];
      return [{ pr: ownerPr, attemptId: id, status: 'unresolved', error: `unreadable CI-heal attempt row: ${error.message}` }];
    }
    if (row.settled === true && now().getTime() - Date.parse(row.startedAt) > SETTLED_ROW_RETENTION_MS) {
      try { unlinkSync(attemptPath(id, dir)); } catch { /* a racing poll already pruned it */ }
      return [];
    }
    if (row.repo !== repo || (pr != null && row.pr !== pr)) return [];
    return [{ pr: row.pr, attemptId: row.attemptId, ...observe(row.attemptId, { dir, repo, pr: row.pr, handle: row.handle }) }];
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The WE checkout every tool is resolved from — by script location, never cwd. */
export const WE_ROOT = resolve(HERE, '..', '..');
const REPO_SLUG = CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug;
const GATE_TIMEOUT_MS = 20 * 60 * 1000;

/** Parse `--k=v` flags. PURE. */
export function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const policy = readRoutingPolicy();
  const configured = flags.worker ? null : resolveOperationRoute({ operation: 'ci-heal', taskType: flags.taskType ?? 'ci-heal', policy, gateClosed: false, available: ['codex', 'antigravity'] });
  const worker = typeof flags.worker === 'string' ? JSON.parse(flags.worker) : configured ? { ...PROBATION_WORKERS[configured.provider === 'codex' ? 'codex' : configured.model.startsWith('claude-') ? 'antigravity-claude' : 'antigravity-gemini'], model: configured.model, effort: configured.effort, taskType: flags.taskType ?? 'ci-heal' } : null;
  if (worker) worker.model = resolvePolicyModel(worker.provider, worker.model, policy);
  return {
    attemptId: flags['heal-attempt'] ?? null,
    pr: Number(flags.pr),
    session: String(flags.session ?? ''),
    reason: String(flags.reason ?? 'red-ci'),
    num: flags.num ? String(flags.num) : null,
    lane: flags.lane ? Number(flags.lane) : null,
    scope: typeof flags.scope === 'string' && flags.scope ? flags.scope.split(',') : [],
    worker,
    dryRun: flags['dry-run'] === true,
  };
}

/**
 * THE ARC. Returns `{outcome, executor, detail}` — `executor` is who actually changed code: the worker's
 * executor when it ran, `mechanical` when the rebase alone healed it, `none` when nothing was pushed.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} io - see {@link realIo} for the shape.
 */
export async function runProbationHeal(args, io) {
  if (!Number.isInteger(args.pr) || args.pr <= 0 || !args.session || !args.worker?.id) throw new Error('probation-heal-run: --pr, --session and --worker are required');
  // An ownership refusal is not this process's attempt to settle. Keep it outside the exception boundary.
  if (args.attemptId) io.bindAttempt?.(args.attemptId, `pid:${process.pid}`);
  const evidence = { executor: 'none', pushed: false };
  try { return await runHealArc(args, io, evidence); }
  catch (error) {
    if (error.healPersistence) throw error;
    const terminal = { outcome: 'executor-failed', ...evidence,
      exitCode: error.status ?? null, signal: error.signal ?? null, quotaState: evidence.quotaState ?? 'unknown',
      ...pickAgyEvidence(evidence),
      ...parseAgyReportEvidence(error.stdout ?? ''), ...pickAgyEvidence(error.telemetry),
      detail: redactedTail(error.stderr || error.message || error, 4000) };
    io.settleAttempt?.(args.attemptId, terminal);
    io.completion({ pr: args.pr, session: args.session, item: args.num, status: 'done', outcome: terminal.outcome });
    io.log(`CI-heal executor failed: ${terminal.detail}`);
    return terminal;
  }
}

async function runHealArc(args, io, evidence) {
  const { pr, session, reason, worker } = args;
  const log = (m) => io.log(`probation-heal-run PR #${pr} [${worker.id}]: ${m}`);
  const complete = (status, outcome) => io.completion({ pr, session, item: args.num, status, outcome });
  let modelEvidence = {};
  let pushed = false;
  let workerEvidence = {};
  const finish = (outcome, executor, detail, row = {}) => {
    try {
      io.settleAttempt?.(args.attemptId, { outcome, executor, detail, pushed, ...workerEvidence, ...modelEvidence });
      complete('done', outcome);
    } catch (error) { error.healPersistence = true; throw error; }
    // One `probation-launch` row per heal the WORKER actually ran — a rebase-only heal is not a trial of it.
    if (executor === worker.executor) {
      io.appendScorecard(launchScorecardRow({ worker, modelEvidence, pr, repo: REPO_SLUG, handle: session, item: args.num, launchOutcome: outcome, ...row }));
    }
    log(`${outcome} — ${detail}`);
    return { outcome, executor, detail };
  };

  complete('started', null);
  const head = io.prHead(pr);
  if (!head || head.state !== 'OPEN') return finish('not-applicable', 'none', 'the PR is not open');
  const examinedHead = head.headRefOid;
  if (args.attemptId) io.validateAttempt?.(args.attemptId, { pr, session, headSha: examinedHead });

  const acquired = io.acquireLane({ ref: head.headRefName, lane: args.lane, session, scope: args.scope });
  const lanePath = typeof acquired === 'string' ? acquired : acquired?.path;
  if (!lanePath) {
    const failure = acquired?.reason || 'lane acquire returned no path (no diagnostics)';
    const remote = io.probeOriginRef(head.headRefName);
    const detail = `${failure}; origin ref ${remote.state}: ${remote.reason || head.headRefName}`;
    if (remote.state === 'absent') {
      io.escalate({ pr, head: examinedHead, reason: `origin ref verified absent — ${head.headRefName}; ${detail}` });
      return finish('escalated-needs-human', 'none', detail);
    }
    return finish('blocked-on-infra', 'none', `${detail}; retry on a later tick`);
  }

  // x55dojc — force a known-clean git-hook baseline BEFORE any rebase/worker/commit runs in this lane, so a
  // PREVIOUS dispatch's leftovers in a reused pooled lane are never silently inherited. A cleanup that cannot
  // fully complete means no safe baseline exists — refuse outright rather than proceed on an unknown surface.
  const hookReset = io.resetHookSurface(lanePath);
  if (!hookReset.clean) {
    log(`SECURITY: could not establish a clean git-hook baseline in ${lanePath} (leftover: ${hookReset.leftover.join(', ') || '(config write failed)'}) — refusing before any git command runs`);
    io.escalate({ pr, head: examinedHead, reason: `could not clean the lane's git-hook surface before use (leftover: ${hookReset.leftover.join(', ') || '(config write failed)'})` });
    return finish('escalated-needs-human', 'none', 'refused: could not establish a clean git-hook baseline in the lane');
  }

  if (!io.rebaseOntoMain(lanePath)) {
    io.escalate({ pr, head: examinedHead, reason: 'conflict with main during rebase' });
    return finish('escalated-conflict', 'none', 'rebase onto main conflicted');
  }
  const rebaseMovedHead = io.headSha(lanePath) !== examinedHead;
  let gate = io.runGate(lanePath);
  const need = workerNeeded({ gateGreen: gate.pass, reason, rebaseMovedHead });
  log(`after rebase: gate ${gate.pass ? 'green' : 'red'}, head ${rebaseMovedHead ? 'moved' : 'unchanged'} — ${need.why}`);

  let executor = 'mechanical';
  let checkerRow = null;
  let diffRow = null;
  if (need.needed) {
    const baseSha = io.headSha(lanePath);
    // Snapshot what is untracked BEFORE the worker runs, so only files it creates can join the heal.
    const preexisting = io.untracked(lanePath);
    const task = (worker.taskType === 'test-fix' ? 'Test-fix: change only tests or test fixtures. If production code is wrong, stop and report it.\n\n' : '') + buildCiHealTask({ pr, reason, scope: args.scope, failingChecks: io.failingChecks(pr), gateOutput: gate.output, logTail: io.failedLogTail(pr) });
    const taskFile = io.writeTaskFile(lanePath, 'probation-heal-task.md', task);
    const preHookSurface = hookReset.snapshot;
    log(`running ${worker.launcher} --model=${worker.model}`);
    evidence.executor = worker.executor;
    const run = io.runWorker(buildWorkerArgv({ worker, weRoot: WE_ROOT, dir: lanePath, taskFile, pr, caller: 'probation-heal-run.mjs' }));
    modelEvidence = run.modelEvidence ?? {};
    Object.assign(evidence, modelEvidence);
    workerEvidence = { exitCode: run.status ?? null, signal: run.signal ?? null, diagnostics: redactedTail(run.out ?? 'unknown', 4000), quotaState: 'unknown' };
    executor = worker.executor;
    // x55dojc — checked BEFORE anything else the worker's run unlocks (the diff read, the gate, a commit):
    // any change to the lane's git-hook surface refuses outright, regardless of whether the worker also
    // finished cleanly or produced an in-envelope diff.
    const postHookSurface = io.snapshotHookSurface(lanePath);
    const hookCheck = hookSurfaceChanged(preHookSurface, postHookSurface);
    if (hookCheck.changed) {
      log(`SECURITY: the worker's own run changed the lane's git-hook surface — refusing, discarding, never committing/pushing: ${hookCheck.reason}`);
      // The pre-worker config comes back first (the whole file), so `discardChanges` never runs git under it —
      // and if it could not, no git runs in the lane at all; a human gets it.
      const restored = io.resetHookSurface(lanePath, preHookSurface).clean;
      if (restored) io.discardChanges(lanePath, baseSha, preexisting);
      const detail = `${hookCheck.reason}${restored ? '' : ' (the lane config could not be restored — the lane was NOT discarded; quarantine it)'}`;
      io.escalate({ pr, head: examinedHead, reason: `git-hook surface changed during the worker's run: ${detail}` });
      return finish('escalated-needs-human', executor, `refused: ${detail}`, { diff: diffRow });
    }
    const summary = summarizeNumstat(io.diffNumstat(lanePath, baseSha, preexisting), { exclude: preexisting });
    diffRow = { files: summary.files, loc: summary.loc };
    if (!summary.files) return finish('escalated-needs-human', executor, `the worker changed nothing (${run.ok ? 'it finished' : 'it failed'}); ${redactedTail(run.out || 'exit cause unknown', 4000)}`, { diff: diffRow });
    const fits = healDiffWithinEnvelope(summary, PROVEN_TASK_ENVELOPES[worker.taskType ?? 'ci-heal']);
    if (!fits.ok) {
      io.discardChanges(lanePath, baseSha, preexisting);
      return finish('gate-red', executor, `not pushed: ${fits.reason}`, { diff: diffRow });
    }
    const pathsOk = healDiffPathsAllowed(summary.paths, { scope: args.scope });
    if (!pathsOk.ok) {
      io.discardChanges(lanePath, baseSha, preexisting);
      return finish('gate-red', executor, `not pushed: ${pathsOk.reason}`, { diff: diffRow });
    }
    gate = io.runGate(lanePath);
    if (!gate.pass) return finish('gate-red', executor, 'the gate is still red after the worker\'s repair', { diff: diffRow });
    if (worker.checker) {
      const checkerTask = io.writeTaskFile(lanePath, 'probation-heal-check.md', buildCheckerTask({ pr, reason, diff: io.diffText(lanePath, baseSha), failingChecks: io.failingChecks(pr) }));
      const verdict = parseCheckerVerdict(io.runChecker(buildCheckerArgv({ checker: worker.checker, weRoot: WE_ROOT, dir: lanePath, taskFile: checkerTask, pr, caller: 'probation-heal-run.mjs' })));
      checkerRow = { provider: worker.checker, verdict: verdict.verdict, reason: verdict.reason };
      if (!verdict.approved) return finish('gate-red', executor, `the ${worker.checker} checker did not approve: ${verdict.verdict} ${verdict.reason}`, { diff: diffRow, checker: checkerRow });
    }
    // x55dojc — re-checked immediately before the ONE commit this arc ever makes: the gate and, when present,
    // the checker are each their own subprocess (the checker is itself an untrusted model, #3922) between the
    // first check above and here, so this is not a redundant re-read of the same window.
    const preCommitHookSurface = io.snapshotHookSurface(lanePath);
    const preCommitCheck = hookSurfaceChanged(postHookSurface, preCommitHookSurface);
    if (preCommitCheck.changed) {
      log(`SECURITY: the lane's git-hook surface changed during the gate/checker window — refusing, discarding, never committing/pushing: ${preCommitCheck.reason}`);
      const restored = io.resetHookSurface(lanePath, preHookSurface).clean;
      if (restored) io.discardChanges(lanePath, baseSha, preexisting);
      const detail = `${preCommitCheck.reason}${restored ? '' : ' (the lane config could not be restored — the lane was NOT discarded; quarantine it)'}`;
      io.escalate({ pr, head: examinedHead, reason: `git-hook surface changed during the gate/checker window: ${detail}` });
      return finish('escalated-needs-human', executor, `refused: ${detail}`, { diff: diffRow, checker: checkerRow });
    }
    io.commit(lanePath, summary.paths, buildHealCommitMessage({ pr, reason, worker, item: args.num, subject: `${reason}: repair ${summary.paths.join(', ')}` }));
  } else if (!gate.pass || !rebaseMovedHead) {
    return finish('no-change', 'none', need.why);
  }

  if (!io.push(lanePath, head.headRefName, examinedHead)) {
    return finish('blocked-on-infra', executor, 'the push was refused (the PR head moved, or the remote is unreachable)', { diff: diffRow, checker: checkerRow });
  }
  pushed = true;
  evidence.pushed = true;
  io.markHealed({ pr, reason, attemptId: args.attemptId, headSha: io.headSha(lanePath), cwd: lanePath });
  return finish(executor === 'mechanical' ? 'no-change' : 'healed', executor, executor === 'mechanical' ? 'the rebase alone healed it; pushed' : 'repaired and pushed; a full review is owed', { diff: diffRow, checker: checkerRow });
}

// ─── the real processes ────────────────────────────────────────────────────────────────────────────────────

function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
function trySh(bin, args, opts = {}) {
  try { return { ok: true, out: sh(bin, args, opts) }; } catch (e) { return { ok: false, status: e.status, signal: e.signal, stdout: String(e?.stdout ?? ''), out: `${e?.stdout ?? ''}${e?.stderr ?? ''}` || String(e?.message ?? e) }; }
}
const node = (script, args, opts) => trySh(process.execPath, [join(WE_ROOT, script), ...args], opts);

/** The real `io` for {@link runProbationHeal}. Every call is bounded and never throws past its own contract.
 *  x55dojc — `laneEnv` disables git hooks (see `../lib/git-hook-surface.mjs`) for every subprocess the
 *  LAUNCHER runs in the lane, so a planted hook can never fire with the launcher's own credentials. The worker
 *  and checker get `workerEnv` instead (#4291 advisory review): they keep the repo's own `.githooks/pre-push`
 *  main-push guard. */
export function realIo({ session, env = process.env, run = trySh } = {}) {
  const workerEnv = { ...env, LANE_SESSION: session };
  const laneEnv = withHooksDisabled(workerEnv);
  return {
    bindAttempt: bindHealAttempt,
    validateAttempt: (id, expected) => {
      const row = readHealAttempt(id);
      if (row.pr !== expected.pr || row.session !== expected.session || row.headSha !== expected.headSha) throw new Error('CI-heal attempt examined head/ownership changed before worker launch');
    },
    settleAttempt: (id, terminal) => { if (id) return finishHealAttempt(id, terminal); },
    log: (m) => console.error(m),
    completion: ({ pr, session: s, item, status, outcome }) => {
      const args = ['report', `--repo=${REPO_SLUG}`, `--session=${s}`, '--kind=ci-heal', `--pr=${pr}`, `--status=${status}`];
      if (item) args.push(`--item=${item}`);
      if (outcome) args.push(`--outcome=${outcome}`);
      const result = node('scripts/operations/completion-cli.mjs', args);
      if (!result.ok) throw new Error(`CI-heal completion failed: ${result.out}`);
    },
    prHead: (pr) => {
      const r = trySh('gh', ['pr', 'view', String(pr), '--repo', REPO_SLUG, '--json', 'headRefOid,headRefName,state']);
      return r.ok ? JSON.parse(r.out) : null;
    },
    acquireLane: ({ ref, lane, session: s, scope }) => {
      const args = ['acquire', `--repo=${WE_ROOT}`, '--purpose=probation-ci-heal', `--session=${s}`, `--base=${ref}`];
      if (lane) args.push(`--lane=${lane}`);
      if (scope?.length) args.push(`--scope=${scope.join(',')}`);
      const r = run(process.execPath, [join(WE_ROOT, 'scripts/lane-pool.mjs'), ...args], { env: laneEnv, timeout: 15 * 60 * 1000 });
      if (!r.ok) return { path: null, reason: r.out.trim() || 'lane acquire failed without output' };
      const last = r.out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      return last.startsWith('/') ? last : { path: null, reason: `lane acquire returned no path: ${r.out.trim()}` };
    },
    probeOriginRef: (ref) => {
      const fullRef = `refs/heads/${ref}`;
      const r = run('git', ['-C', WE_ROOT, 'ls-remote', '--exit-code', '--refs', 'origin', fullRef], { env: laneEnv, timeout: 30_000 });
      if (r.ok && r.out.split('\n').some((line) => line.split('\t')[1] === fullRef)) return { state: 'present', reason: r.out.trim() };
      if (!r.ok && r.status === 2) return { state: 'absent', reason: 'git ls-remote --exit-code returned 2 (no matching ref)' };
      return { state: 'unknown', reason: r.out.trim() || 'remote probe did not establish presence or absence' };
    },
    rebaseOntoMain: (dir) => {
      try { fetchFresh({ cwd: dir, branches: ['main'], maxAgeMs: 0, run: (args) => sh('git', ['-C', dir, ...args], { env: laneEnv }) }); } catch { return false; }
      if (trySh('git', ['-C', dir, 'rebase', 'origin/main'], { env: laneEnv }).ok) return true;
      trySh('git', ['-C', dir, 'rebase', '--abort'], { env: laneEnv });
      return false;
    },
    headSha: (dir) => sh('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: laneEnv }).trim(),
    resetHookSurface: (dir, baseline) => resetHookSurface(dir, baseline),
    snapshotHookSurface: (dir) => snapshotHookSurface(dir),
    runGate: (dir) => {
      const r = node('scripts/verify-lane.mjs', ['run', '--repo=.'], { cwd: dir, env: laneEnv, timeout: GATE_TIMEOUT_MS });
      return { pass: r.ok, output: r.out.slice(-12000) };
    },
    failingChecks: (pr) => {
      const r = trySh('gh', ['pr', 'checks', String(pr), '--repo', REPO_SLUG]);
      return r.out.split('\n').filter((l) => /\tfail/.test(l)).join('\n') || r.out.slice(0, 2000);
    },
    failedLogTail: () => '',
    writeTaskFile: (dir, name, text) => {
      // Inside `.git`, so the task text never shows up in the heal diff.
      const p = join(dir, '.git', name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    runWorker: (argv) => {
      // SYNCHRONOUS on purpose: both launchers block until the model's turn ends (see their headers).
      // `workerEnv`, never `laneEnv`: the worker's own git use keeps the repo's guard hooks (see `realIo`).
      const r = trySh(process.execPath, argv, { env: workerEnv, timeout: 70 * 60 * 1000 });
      return { modelEvidence: parseAgyReportEvidence(r.stdout ?? r.out), ok: r.ok, status: r.status ?? null, signal: r.signal ?? null, out: redactedTail(r.out, 4000) };
    },
    runChecker: (argv) => {
      const r = trySh(process.execPath, argv, { env: workerEnv, timeout: 20 * 60 * 1000 });
      if (!r.ok) return '';
      try { return JSON.parse(r.out).lastMessage ?? ''; } catch { return ''; }
    },
    untracked: (dir) => sh('git', ['-C', dir, 'ls-files', '-z', '--others', '--exclude-standard'], { env: laneEnv }).split('\0').filter(Boolean),
    diffNumstat: (dir, base, preexisting = []) => {
      const created = newUntrackedPaths(preexisting, sh('git', ['-C', dir, 'ls-files', '-z', '--others', '--exclude-standard'], { env: laneEnv }).split('\0').filter(Boolean));
      if (created.length) trySh('git', ['-C', dir, 'add', '--intent-to-add', '--', ...created], { env: laneEnv });
      // The launcher intent-adds every untracked file for its own diff; take the pre-existing ones back out of the
      // index so no intent-to-add entry for a file the worker never wrote is left in the lane.
      if (preexisting.length) trySh('git', ['-C', dir, 'reset', '-q', '--', ...preexisting], { env: laneEnv });
      // `--no-renames`: a rename becomes an explicit delete + add (both paths listed), never `old => new`, one path
      // string `commit`'s `git add` rejects. `-z`: NUL-delimited, so no path is ever C-quoted.
      return sh('git', ['-C', dir, 'diff', '--no-renames', '-z', '--numstat', base], { env: laneEnv });
    },
    diffText: (dir, base) => sh('git', ['-C', dir, 'diff', base], { env: laneEnv }),
    // Undo ONLY the worker's own changes: reset tracked files, and delete just the untracked paths it created.
    // `trySh` throughout: a git hiccup listing untracked files must not skip the reset below.
    discardChanges: (dir, base, preexisting = []) => {
      const listed = trySh('git', ['-C', dir, 'ls-files', '-z', '--others', '--exclude-standard'], { env: laneEnv });
      const created = listed.ok ? newUntrackedPaths(preexisting, listed.out.split('\0').filter(Boolean)) : [];
      trySh('git', ['-C', dir, 'reset', '--hard', base], { env: laneEnv });
      if (created.length) trySh('git', ['-C', dir, 'clean', '-f', '--', ...created], { env: laneEnv });
    },
    commit: (dir, paths, message) => {
      const msgFile = join(dir, '.git', 'probation-heal-commit-msg.txt');
      writeFileSync(msgFile, message);
      sh('git', ['-C', dir, 'add', '--', ...paths], { env: laneEnv });
      sh('git', ['-C', dir, 'commit', '-F', msgFile, '--', ...paths], { env: laneEnv });
    },
    push: (dir, ref, examinedHead) => trySh('git', ['-C', dir, 'push', `--force-with-lease=refs/heads/${ref}:${examinedHead}`, 'origin', `HEAD:refs/heads/${ref}`], { env: laneEnv }).ok,
    markHealed: ({ pr, reason, attemptId, headSha, cwd }) => attemptId
      ? handBackCiHealReview({ pr, repo: REPO_SLUG, headSha, cwd, exec: execFileSyncThrottled })
      : node('scripts/conveyor/ci-heal-mark.mjs', [String(pr), `--repo=${REPO_SLUG}`, `--reason=${reason}`]),
    escalate: ({ pr, head, reason }) => node('scripts/conveyor/ci-heal-escalation-mark.mjs', [String(pr), `--repo=${REPO_SLUG}`, `--head=${head}`, '--outcome=needs-human', `--reason=${reason}`]),
    appendScorecard: (row) => {
      // Best-effort: a lost trial row must never fail a heal that worked.
      try { appendScorecardRow(row); } catch (e) { console.error(`probation-heal-run: scorecard row not written: ${e?.message ?? e}`); }
    },
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.attemptId) args.attemptId = beginHealAttempt({ pr: args.pr, sessionSlug: args.session, probationWorker: args.worker }).attemptId;
  runProbationHeal(args, realIo({ session: args.session }))
    .then((r) => { console.log(JSON.stringify(r)); })
    .catch((e) => { console.error(`probation-heal-run: ${e?.message ?? e}`); process.exitCode = 1; });
}
