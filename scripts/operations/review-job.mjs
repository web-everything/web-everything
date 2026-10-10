#!/usr/bin/env node
import { readReviewCiGate, formatReviewCiSkip } from '../lib/review-ci-gate-io.mjs';
/**
 * @file scripts/operations/review-job.mjs
 * @description x26lw6u (epic #3383) — RUN THE INDEPENDENT-REVIEW ARC AS A DETERMINISTIC JOB, NOT A CLAUDE
 * WRAPPER SESSION.
 *
 *   node scripts/operations/review-job.mjs run --pr=1234 --repo=web-everything/web-everything   # the arc, foreground
 *
 * THE WASTE THIS REMOVES (measured 2026-09-24 → 25, the review daemon's own transcripts). The review daemon
 * (`we:skills-src/conveyor/review-daemon.mjs`) used to start one `claude --bg` session per owed review
 * (`we:scripts/operations/review-dispatch.mjs#dispatchReview`), handing it `we:skills-src/review/
 * review-agent-brief.md` — a FIXED five-step arc with no judgment in it: report `started`, acquire a lane, run
 * `we:scripts/operations/review-loop-cli.mjs` once, report `done`, release the lane. The brief forbids the
 * session from acting on the result. 388 such sessions cost ~27 active hours (~11.3h of it idle-waiting on the
 * loop), 213 of them never reached the loop at all, and each held ~0.7 GB RSS. This file is that arc as code.
 *
 * WHY THE WRAPPER SESSION WAS NOT LOAD-BEARING (verified from source before this file was written):
 *   1. THE JUDGING IS ALREADY FRESH WITHOUT IT. `review-loop-cli.mjs` drives `review-pr`, whose jurors are
 *      spawned by `we:scripts/lib/judge-spawn.mjs` as separate `claude -p` processes with their OWN derived
 *      `--session-id` — independent of whoever called the CLI. The wrapper session never judged anything.
 *   2. THE ONE THING IT DID SUPPLY IS AN ACTOR ID. `we:scripts/lib/review-independence.mjs#currentActorId`
 *      reads `CLAUDE_CODE_SESSION_ID` off plain `process.env`; `review-pr`'s `read` step and
 *      `we:scripts/review-set-label.mjs` compare it with the PR's `authored-by-actor` stamp. A `--bg` session's
 *      id is a random value the harness mints — "independent" only in the sense that it is not the author's.
 *      This job mints its own fresh random UUID per round and hands it to its children the same way, so the
 *      clearer is still a real, distinct, per-round identity (never '' — an unset id would downgrade every
 *      clear to `unknown-clearer`, "Independence NOT established", which is why this is set, not skipped).
 *      The job never authors a PR, so its id can never equal an author stamp.
 *   3. THE PROMPT-INJECTION RESIDUAL SHRINKS. A session reading the reviewed diff could in principle be talked
 *      into running something other than the arc (`#3433`'s deny list exists for that). A script has no prompt.
 *
 * WHAT STAYS A SESSION. Nothing in this arc needs judgment, so nothing here spawns one. The fix and ci-heal
 * dispatches (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`, `we:scripts/operations/ci-heal-pr-dispatch.mjs`)
 * do real code-editing work and are untouched. A `review:human` park is still parked by `review-pr` itself and
 * cleared only by a human (`--to=clear-human`); this job never clears, merges or re-runs anything. The old
 * session path stays reachable behind {@link REVIEW_DISPATCH_MODE_ENV}`=session` (or `--mode=session` on
 * `review-dispatch.mjs`'s CLI).
 *
 * LIVENESS WITHOUT A TRANSCRIPT. Everything that decided "is a review already running on this PR" read
 * `claude agents --json` and bound a row by its `review-<pr>` NAME (`we:scripts/conveyor/reconcile-core.mjs
 * #bindAgents`, `we:scripts/conveyor/review-status-tag.mjs#deriveReviewStatus`). A job has no listing row, so
 * it writes a JOB RECORD (`<root>/.operations/review-jobs/<slug>.json`: slug, pid, startedAt, cwd) and
 * {@link listReviewJobAgents} turns every record whose pid is still alive into a row of the SAME shape
 * (`name`, `state: 'working'`, `pid`, `startedAt`, `cwd`, `kind: 'review-job'`). Those two readers merge the
 * rows in ({@link listAgentsWithReviewJobs}), so double-dispatch refusal and the `review-status:reviewing`
 * label keep working with no change to either pure core. A dead pid is pruned, never read as live. The job
 * row carries no `sessionId`, so `we:scripts/conveyor/hung-session.mjs` answers `no-signal` for it (it never
 * guesses hung without a transcript) — the job bounds ITSELF instead: the loop runs under a hard timeout
 * ({@link resolveLoopTimeoutMs}). `we:scripts/conveyor/session-reaper.mjs` reads its own listing and never
 * sees a job row, so it can never try to `claude stop` one.
 *
 * NO LANE → NEXT TICK, BOUNDED. The daemon already caps each tick's dispatches by how many lanes are acquirable
 * (`review-daemon.mjs#defaultAcquirableLaneCount`). If the job still finds none after a short bounded wait, it
 * reports `deferred-no-lane`, exits, and the PR is simply owed again on the next tick — no session was burned.
 * After {@link MAX_LANE_DEFERRALS} deferrals in a row the outcome escalates to `blocked-on-infra`, and
 * {@link dispatchReviewJob} then declines to spawn for that PR until the same 15-minute cool-off reconcile
 * already uses for `blocked-on-infra` (`reconcile-core.mjs#INFRA_RETRY_COOLOFF_MS`) has passed.
 *
 * NOTIFICATION. The completion record (`we:scripts/operations/completion-cli.mjs`'s store, #3436) is written
 * `started` then `done` exactly as the brief's steps 0/3 wrote it — same session slug, same outcome words
 * (`bounced` / `auto-cleared` / `parked` / `blocked-on-infra`) — so `markSelfReportedDone`, telemetry and every
 * `completion-cli.mjs show` reader see no difference. The label/comment on the PR is written by
 * `review-loop-cli.mjs` itself, unchanged. One telemetry trace per round (`telemetry-store.mjs#recorderFor`).
 *
 * WHY A PLAIN MODULE, NOT AN `op()` DECLARATION. The judged work already IS a declared operation (`review-pr`,
 * driven by `review-loop-cli.mjs`). This file is the harness around it — acquire, run, report, release — the
 * same standalone shape `review-dispatch.mjs` and `dispatch-abort.mjs` argue for in their headers, and the one
 * the prototype `review-dispatch-wrapper.mjs` (origin/lane/mechanical-dispatcher, #3908) used. Its
 * outcome classifier is ported from there, with #3647's fix folded in: a non-zero exit whose stdout still
 * parses as a finished review reports the review's real outcome, never a blanket `blocked-on-infra`.
 *
 * IMPURE, but every effect goes through an injected `io` so the whole arc is unit-tested with fakes.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNotALaneCheckout, REPO_ROOT, resolveGhShimSettingsEnv } from './dispatch-lane-io.mjs';
import {
  decideJobClaim, jobLogPath, pidAlive, readJobRecord, removeJobRecord, reviewJobsDir, writeJobRecord,
} from './review-job-store.mjs';
import { assertMainNotStale, dispatchReview, isReviewCodePath, planReviewDispatch } from './review-dispatch.mjs';
import { runReport } from './completion-cli.mjs';
import { writeReviewJobDone, writeReviewJobStarted } from './review-job-envelope.mjs';
import { workerWrapperEnabledFor } from './worker-wrapper-launch.mjs';
import { tryReadCompletion } from './completion-store.mjs';
import { rateAndRecordReviewJob } from '../conveyor/run-rating.mjs';
import { recorderFor, setActiveRecorder } from './telemetry-store.mjs';
import { ACTOR_ENV } from '../lib/review-independence.mjs';
import { INFRA_RETRY_COOLOFF_MS } from '../conveyor/reconcile-core.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { extraSeatsEnabled, redTeamEnabled, resolveSeatTimeoutMs } from './review-extra-seats.mjs';
import { redTeamRequired } from '../lib/jury-core.mjs';
import { decideStackDispatch, fingerprintOf, mainNetDiffText, readBottomLanded, readStackBase, readStackThread, resolveStackAwareReview, stackNetDiffText, liveStackMarkers } from '../conveyor/review-stack-base.mjs';
import { UNATTENDED_REVIEW_ACTOR } from './review-loop-cli.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { isUnderTest } from '../lib/under-test.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);

// The job-record store, re-exported so a caller has one import for the whole review-job surface.
export * from './review-job-store.mjs';

/** `job` (default) or `session` — which dispatch path the review daemon takes. */
export const REVIEW_DISPATCH_MODE_ENV = 'WE_REVIEW_DISPATCH_MODE';

/** The lane-pool `--purpose` — the brief's own `review-loop`, so the pool's accounting is unchanged. */
export const REVIEW_LOOP_LANE_PURPOSE = 'review-loop';

/** Bounded acquire wait. Shorter than the brief's 180s on purpose: the next tick (120s later) IS the retry, and
 *  a waiting job costs a sleeping node process, not a session. */
export const REVIEW_JOB_LANE_WAIT_MS = 60_000;

/** Consecutive no-lane deferrals before the outcome escalates to `blocked-on-infra` and dispatch cools off. */
export const MAX_LANE_DEFERRALS = 5;

export const DEFERRED_NO_LANE = 'deferred-no-lane';
export const BLOCKED_ON_INFRA = 'blocked-on-infra';
const LANE_DEFERRALS_LABEL = 'lane-deferrals:';

/** Hard ceiling on one review-loop round. Measured jurors: correctness ~333s, security ~112s on average; the
 *  slowest recent wrapper sessions ran ~21 min end to end. 45 min is a hang, not a slow review. */
export const DEFAULT_LOOP_TIMEOUT_MS = 45 * 60 * 1000;
export const LOOP_TIMEOUT_ENV = 'WE_REVIEW_JOB_TIMEOUT_MS';

/** @param {object} [env] @returns {number} */
export function resolveLoopTimeoutMs(env = process.env) {
  const n = Number(env?.[LOOP_TIMEOUT_ENV]);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_LOOP_TIMEOUT_MS;
}

/** @param {object} [env] @returns {'job'|'session'} — anything unrecognised reads as the default `job`. */
export function resolveReviewDispatchMode(env = process.env) {
  const raw = String(env?.[REVIEW_DISPATCH_MODE_ENV] ?? '').trim().toLowerCase();
  return raw === 'session' ? 'session' : 'job';
}

// ── PURE CLASSIFIERS ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * PURE — `review-loop-cli.mjs --json`'s payload → the brief's own outcome words (ported from the prototype
 * `review-dispatch-wrapper.mjs#classifyReviewLoopOutcome`):
 *   queued accept (`accept-needs-human`) → `parked`; `preventionFiled` → `auto-cleared`;
 *   `stopped: complete|effect-in-flight` → `auto-cleared` on an `accept` verdict, else `bounced`;
 *   `stopped: confirm` → `parked` (a `review:human` park); anything else → `blocked-on-infra`.
 */
export function classifyReviewLoopOutcome(parsed) {
  const runId = typeof parsed?.runId === 'string' ? parsed.runId : null;
  const verdict = typeof parsed?.verdict?.verdict === 'string' ? parsed.verdict.verdict : null;
  const loopOutcome = typeof parsed?.verdict?.loop?.outcome === 'string' ? parsed.verdict.loop.outcome : null;
  const base = { verdict, loopOutcome, runId };
  if (parsed?.queued === 'accept-needs-human') return { outcome: 'parked', ...base };
  if (Array.isArray(parsed?.preventionFiled)) return { outcome: 'auto-cleared', ...base };
  const stopped = typeof parsed?.stopped === 'string' ? parsed.stopped : null;
  if (stopped === 'complete' || stopped === 'effect-in-flight') {
    return { outcome: verdict === 'accept' ? 'auto-cleared' : 'bounced', ...base };
  }
  if (stopped === 'confirm') return { outcome: 'parked', ...base };
  return { outcome: BLOCKED_ON_INFRA, ...base };
}

/**
 * PURE — the completion label for a loop that PRINTED a payload: null on a clean exit, else `exit N`, plus the
 * payload's own `stopped` word and `error` text when it carries them (so a refusal is recorded verbatim).
 * @returns {string|null}
 */
export function loopFailureLabel(parsed, status) {
  const err = typeof parsed?.error === 'string' ? parsed.error.trim() : '';
  const stopped = typeof parsed?.stopped === 'string' ? parsed.stopped : '';
  if (status === 0 && !err) return null;
  return `exit ${status}${err && stopped ? ` (${stopped})` : ''}${err ? `: ${err}` : ''}`.slice(0, 500);
}

/**
 * PURE — pull the JSON payload out of the loop's stdout. `--json` prints ONE pretty-printed object, but a
 * stray leading line must not lose a finished review (#3647's lesson), so fall back to the first line that
 * opens an object and parse from there.
 * @returns {object|null}
 */
export function parseReviewLoopStdout(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep looking */ }
  }
  return null;
}

/**
 * PURE — the crash label when the loop's stdout held no parseable JSON at all (card x5s8b47's second, narrower
 * defect, distinct from its quota-hold fix). `review-loop-cli.mjs`'s own top-level `.catch` DELIBERATELY writes
 * `error: <real message>` to STDOUT (fd 1, not stderr — see its `IS_CLI` block) specifically so a crash still
 * says something a caller can read. That was being thrown away: the caller preferred `loop.stderr` whenever it
 * was non-empty (`loop.stderr || loop.stdout`), and stderr routinely carries content that has nothing to do
 * with the crash — confirmed LIVE (2026-09-28, this very lane's own `lane-pool.mjs acquire` run): a bare Node
 * `[DEP0040] DeprecationWarning: The \`punycode\` module is deprecated` line, emitted lazily during process
 * teardown by some dependency, landing on stderr well after (and unrelated to) whatever actually failed. That
 * is exactly what the card measured: "only a stray Node deprecation-warning line survives... as if it were the
 * explanation."
 *
 * Prefers stdout's OWN deliberate `error: ` line when present; falls back to the previous stderr-then-stdout
 * order otherwise, so a crash that happens BEFORE that catch handler even runs (an import-time throw, a raw
 * segfault, a kill) is no worse off than before this fix.
 * @param {{stdout?: string, stderr?: string}} loop
 * @returns {string}
 */
export function crashLabelFromLoop({ stdout, stderr } = {}) {
  const errorLines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('error: '));
  if (errorLines.length) return errorLines[errorLines.length - 1];
  return String(stderr || stdout || '');
}

/**
 * PURE — the outcome of THIS no-lane deferral, counting the previous ones off the prior completion record.
 * @returns {{count:number, outcome:string, label:string}}
 */
export function nextLaneDeferral(prev, max = MAX_LANE_DEFERRALS) {
  const prevCount = (prev?.outcome === DEFERRED_NO_LANE && typeof prev.label === 'string' && prev.label.startsWith(LANE_DEFERRALS_LABEL))
    ? Number(prev.label.slice(LANE_DEFERRALS_LABEL.length)) || 0
    : 0;
  const count = prevCount + 1;
  return { count, outcome: count >= max ? BLOCKED_ON_INFRA : DEFERRED_NO_LANE, label: `${LANE_DEFERRALS_LABEL}${count}` };
}

/** PURE — is this PR in the post-escalation cool-off (its last round exhausted the lane deferrals recently)? */
export function laneCooloffActive(record, nowMs, cooloffMs = INFRA_RETRY_COOLOFF_MS) {
  if (!record || record.status !== 'done' || record.outcome !== BLOCKED_ON_INFRA) return false;
  if (typeof record.label !== 'string' || !record.label.startsWith(LANE_DEFERRALS_LABEL)) return false;
  const at = Date.parse(record.updatedAt ?? '');
  return Number.isFinite(at) && nowMs - at < cooloffMs;
}

// ── THE ARC ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The real effects, each one command. `root` is the checkout the arc runs from (the daemon's clone). */
export function createReviewJobIo({ root = REPO_ROOT, env = process.env, dir = reviewJobsDir(env, root) } = {}) {
  const node = (args, { actorId, timeoutMs } = {}) => spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...(actorId ? { [ACTOR_ENV]: actorId } : {}) },
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
  });
  return {
    root,
    now: () => Date.now(),
    newActorId: () => randomUUID(),
    readPrevCompletion: (slug) => { try { return tryReadCompletion(slug); } catch { return null; } },
    // 117 S3b — the job writes its record as the v2 envelope (launcher `node-job`): its own pid/timeout on `started`,
    // a schema-checked result + action on `done`, the v1 words unchanged. `WE_WORKER_WRAPPER=off` keeps the v1 report.
    report: (flags) => {
      if (!workerWrapperEnabledFor('review', env)) return runReport(flags);
      if (flags.status === 'started') return writeReviewJobStarted({ session: flags.session, pr: flags.pr, timeoutMs: flags.timeoutMs ?? null });
      return writeReviewJobDone({
        session: flags.session, pr: flags.pr ?? null, repo: flags.repo ?? null,
        classified: { outcome: flags.outcome, loopOutcome: flags.verdict ?? null, runId: flags.runId ?? null, label: flags.label ?? null },
      });
    },
    claim: (slug, record) => {
      const verdict = decideJobClaim(readJobRecord(slug, dir), record.pid, pidAlive);
      if (verdict.ok) writeJobRecord(record, dir);
      return verdict;
    },
    updateRecord: (record) => writeJobRecord(record, dir),
    unclaim: (slug, pid) => removeJobRecord(slug, pid, dir),
    acquireLane: ({ laneRepo, slug, actorId, waitMs, lane }) => {
      const r = node([
        'scripts/lane-pool.mjs', 'acquire', `--repo=${laneRepo}`, `--purpose=${REVIEW_LOOP_LANE_PURPOSE}`,
        `--session=${slug}`, `--wait-ms=${waitMs}`, '--adopt',
        ...(Number.isInteger(lane) && lane > 0 ? [`--lane=${lane}`] : []),
      ], { actorId, timeoutMs: waitMs + 10 * 60 * 1000 });
      const path = String(r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
      if (r.status === 0 && path.startsWith('/') && existsSync(path)) return { lanePath: path };
      return { lanePath: null, error: String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-3).join(' | ').slice(0, 500) };
    },
    runLoop: ({ pr, repo, lanePath, actorId, timeoutMs }) => {
      const r = node([
        'scripts/operations/review-loop-cli.mjs', `--pr=${pr}`, `--repo=${repo}`, `--cwd=${lanePath}`,
        '--provider=claude', '--json',
      ], { actorId, timeoutMs });
      return {
        status: r.status, signal: r.signal ?? null, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''),
        timedOut: r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGKILL' && r.status === null),
      };
    },
    releaseLane: (slug) => node(['scripts/lane-pool.mjs', 'release', '--all-pools', `--session=${slug}`], { timeoutMs: 5 * 60 * 1000 }),
    // #4194 — the ADDED non-Claude seats, run in their own process AFTER the verdict is decided, under a hard wall.
    // Whatever happens in there comes back as a status; nothing here can throw into the arc.
    runExtraSeats: ({ pr, repo, lanePath, loopPayload, slug }) => {
      if (!extraSeatsEnabled(env)) return { status: 'disabled', reason: 'kill switch thrown' };
      const loopFile = join(dir, `${slug}.loop.json`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(loopFile, JSON.stringify(loopPayload));
        const r = node([
          'scripts/operations/review-extra-seats.mjs', 'run', `--pr=${pr}`, `--repo=${repo}`, `--lane=${lanePath}`, `--loop-json=${loopFile}`,
        ], { timeoutMs: resolveSeatTimeoutMs(env) + 5 * 60 * 1000 });
        for (const line of String(r.stderr ?? '').split('\n').filter((l) => l && !/DeprecationWarning|trace-deprecation/.test(l))) {
          writeLineSync(2, `  ${line}`);
        }
        const last = String(r.stdout ?? '').trim().split('\n').pop() ?? '';
        try { return JSON.parse(last); } catch { return { status: 'error', reason: `seat runner exit ${r.status}${r.signal ? ` (${r.signal})` : ''}, no result` }; }
      } catch (e) {
        return { status: 'error', reason: String(e?.message ?? e).slice(0, 300) };
      } finally {
        try { rmSync(loopFile, { force: true }); } catch { /* best effort */ }
      }
    },
    // x00g3tt — the POST-ACCEPT RED TEAM, its own process and wall, run only after the added seats. Advisory: it
    // posts one deduped comment and writes evidence; nothing it returns reaches a label, merge or verdict.
    runRedTeam: ({ pr, repo, lanePath, loopPayload, slug }) => {
      if (!redTeamEnabled(env)) return { status: 'disabled', reason: 'kill switch thrown' };
      const loopFile = join(dir, `${slug}.red-team.loop.json`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(loopFile, JSON.stringify(loopPayload));
        const r = node([
          'scripts/operations/review-extra-seats.mjs', 'red-team', `--pr=${pr}`, `--repo=${repo}`, `--lane=${lanePath}`, `--loop-json=${loopFile}`,
        ], { timeoutMs: resolveSeatTimeoutMs(env) + 20 * 60 * 1000 });
        for (const line of String(r.stderr ?? '').split('\n').filter((l) => l && !/DeprecationWarning|trace-deprecation/.test(l))) {
          writeLineSync(2, `  ${line}`);
        }
        const last = String(r.stdout ?? '').trim().split('\n').pop() ?? '';
        try { return JSON.parse(last); } catch { return { status: 'error', reason: `red-team runner exit ${r.status}${r.signal ? ` (${r.signal})` : ''}, no result` }; }
      } catch (e) {
        return { status: 'error', reason: String(e?.message ?? e).slice(0, 300) };
      } finally {
        try { rmSync(loopFile, { force: true }); } catch { /* best effort */ }
      }
    },
    log: (line) => writeLineSync(2, `[${new Date().toISOString()}] ${line}`),
  };
}

/** x00g3tt — the compact form of the red team's result the job prints (the full rows live in the store). */
export function summarizeRedTeam(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    status: r.status ?? null,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.status === 'ran' ? {
      provider: r.provider, model: r.model, seatStatus: r.seat?.status ?? null, foldedVerdict: r.foldedVerdict ?? null,
      recheckStatus: r.recheckStatus ?? null, confirmedMissCount: r.confirmedMissCount ?? 0,
      findings: (r.findings ?? []).map((f) => ({ summary: f.summary, file: f.file ?? null, line: f.line ?? null, category: f.category ?? null, confirmed: f.confirmedByRecheck === true })),
      delegationTrial: r.delegationTrial ?? null, comment: r.comment?.status ?? null, rowsWritten: r.rowsWritten ?? 0,
    } : {}),
  };
}

/** #4194 — the compact form of the added seats' result the job prints (the full rows live in the store). */
export function summarizeExtraSeats(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    status: r.status ?? null,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(Array.isArray(r.seats) ? {
      seats: r.seats.map((x) => ({
        seat: x.seat, lens: x.lens, provider: x.provider, model: x.model, status: x.status, verdict: x.seatVerdict ?? null,
        findings: (x.findings ?? []).map((f) => ({ summary: f.summary, file: f.file, line: f.line, impact: f.impactIfUnfixed, confirmedByClaude: f.confirmedByClaude })),
      })),
    } : {}),
    ...(Array.isArray(r.skipped) && r.skipped.length ? { skipped: r.skipped } : {}),
    ...(r.rowsWritten != null ? { rowsWritten: r.rowsWritten } : {}),
    ...(r.callsUsedToday != null ? { callsUsedToday: r.callsUsedToday, dailyCap: r.dailyCap } : {}),
  };
}

function tail(text, n = 400) {
  const t = String(text ?? '').trim();
  return t.length > n ? t.slice(-n) : t;
}

/**
 * THE ARC — one review round for `repo#pr`, start to finish, no Claude wrapper session:
 *   0. claim the job slot (refuse if a live job already holds it) and report `started`;
 *   1. acquire a lane (bounded wait);
 *   2. run `review-loop-cli.mjs --json` ONCE under a fresh actor id and a hard timeout;
 *   3. report `done` with the classified outcome / loop verdict / run id;
 *   4. release the lane and drop the job record — in `finally`, so every exit path cleans up;
 *   5. (#4194) only then, when the loop printed a finished review, run the ADDED non-Claude seats
 *      (`review-extra-seats.mjs`) and attach their summary as `extraSeats` — advisory, never read by any verdict;
 *   6. (x00g3tt) and, when that review ACCEPTED, the post-accept RED TEAM (`review-extra-seats.mjs red-team`),
 *      attached as `redTeam` — advisory in v1: one deduped comment + evidence rows, never a label or a merge.
 * @param {{pr:number|string, repo:string, laneWaitMs?:number, loopTimeoutMs?:number}} o
 * @param {ReturnType<typeof createReviewJobIo>} [io]
 * @returns {{pr:number, repo:string, sessionSlug:string, outcome:string, verdict:(string|null),
 *   loopOutcome:(string|null), runId:(string|null), lanePath:(string|null), label:(string|null), refused?:boolean,
 *   timings:{acquireMs:(number|null), loopMs:(number|null), totalMs:number}}}
 */
export function runReviewJob(opts = {}, io = createReviewJobIo()) {
  const seatsBox = {};
  const out = runReviewArc(opts, io, seatsBox);
  // #4194 — THE ADDED NON-CLAUDE SEATS (advisory lenses + one extra juror on Codex/Gemini), beside Claude's
  // mandatory seats and strictly AFTER the arc is over: the verdict is labelled, `done` is reported, the lane is
  // released and the job slot dropped — so the seats never delay the pipeline and nothing they do can touch the
  // outcome above. A missing hook, a crash, a timeout, a thrown kill switch: each is only a status in `extraSeats`.
  if (seatsBox.input && typeof io.runExtraSeats === 'function') {
    let extraSeats;
    try {
      extraSeats = io.runExtraSeats(seatsBox.input);
    } catch (e) {
      extraSeats = { status: 'error', reason: tail(e?.message ?? e, 300) };
    }
    io.log(`review-job ${out.sessionSlug}: added seats — ${extraSeats?.status ?? 'none'}${extraSeats?.reason ? ` (${extraSeats.reason})` : ''}`
      + `${Array.isArray(extraSeats?.seats) ? `: ${extraSeats.seats.map((x) => `${x.lens}@${x.provider}=${x.status}/${x.findingsCount ?? 0}f/${x.confirmedCount ?? 0}c`).join(', ')}` : ''}`);
    out.extraSeats = summarizeExtraSeats(extraSeats);
  }
  // x00g3tt — THE POST-ACCEPT RED TEAM: owed only when Claude's review ACCEPTED (`redTeamRequired`), and only after
  // everything above. Same containment as the seats: a crash is a status in `redTeam`, never a changed outcome.
  if (seatsBox.input && redTeamRequired(out.verdict) && typeof io.runRedTeam === 'function') {
    let redTeam;
    try {
      redTeam = io.runRedTeam(seatsBox.input);
    } catch (e) {
      redTeam = { status: 'error', reason: tail(e?.message ?? e, 300) };
    }
    io.log(`review-job ${out.sessionSlug}: red team — ${redTeam?.status ?? 'none'}${redTeam?.reason ? ` (${redTeam.reason})` : ''}`
      + `${redTeam?.status === 'ran' ? `: ${redTeam.findings?.length ?? 0} break(s), ${redTeam.confirmedMissCount ?? 0} confirmed, comment ${redTeam.comment?.status ?? '-'}` : ''}`);
    out.redTeam = summarizeRedTeam(redTeam);
  }
  return out;
}

function runReviewArc({
  pr, repo, preferLane = null, laneWaitMs = REVIEW_JOB_LANE_WAIT_MS, loopTimeoutMs = resolveLoopTimeoutMs(), pid = process.pid,
} = {}, io, seatsBox = {}) {
  const planned = planReviewDispatch({ pr, repo });
  const slug = planned.sessionSlug;
  const t0 = io.now();
  const timings = { acquireMs: null, loopMs: null, totalMs: 0 };
  const result = (fields) => ({
    pr: planned.pr, repo: planned.repo, sessionSlug: slug, lanePath: null, verdict: null, loopOutcome: null, runId: null,
    label: null, ...fields, timings: { ...timings, totalMs: io.now() - t0 },
  });

  const record = { slug, pr: planned.pr, repo: planned.repo, pid, startedAt: new Date(t0).toISOString(), cwd: io.root };
  const claim = io.claim(slug, record);
  if (!claim.ok) {
    io.log(`review-job ${slug}: refused — a live job (pid ${claim.heldBy}) already holds this PR's slot`);
    return result({ outcome: 'refused-live-job', refused: true });
  }

  let tel = null;
  let root = null;
  try {
    tel = recorderFor({ kind: 'review', pr: planned.pr, attributes: { pr: planned.pr, repo: planned.repo, sessionSlug: slug, mode: 'job' } });
    setActiveRecorder(tel);
    root = tel.startRoot({ pr: planned.pr, repo: planned.repo, mode: 'job' });
  } catch { tel = null; root = null; }
  const span = (name) => { try { return root ? root.child(name) : null; } catch { return null; } };

  let classified = null;
  let lanePath = null;
  try {
    const prev = io.readPrevCompletion(slug);
    io.report({ session: slug, kind: 'review', pr: String(planned.pr), repo: planned.repo, status: 'started', timeoutMs: loopTimeoutMs });

    // NO pre-release of this slug's lease. The job slot above proves no live JOB owns the slug, but not that no
    // live SESSION does (the `--mode=session` path, or a session dispatched just before a switch-over and not yet
    // in `claude agents --json`) — releasing by slug here would pull a lane out from under it. Live-caught on the
    // daemon overlay 2026-09-25. A killed job's leftover lease is the lane pool's own reaper's job (#2748).
    const actorId = io.newActorId();
    io.log(`review-job ${slug}: actor ${actorId}; acquiring a lane (wait ≤ ${laneWaitMs}ms)`);
    const acquireSpan = span('lane.acquire');
    const tA = io.now();
    let acq;
    if (Number.isInteger(preferLane) && preferLane > 0) {
      acq = io.acquireLane({ laneRepo: planned.laneRepo, slug, actorId, lane: preferLane, waitMs: 0 });
      if (!acq.lanePath) io.log(`review-job ${slug}: preferred lane-${preferLane} not taken (${acq.error || 'unavailable'}) — falling back to auto-pick`);
      else io.log(`review-job ${slug}: preferred lane-${preferLane} acquired at ${acq.lanePath}`);
    }
    if (!acq?.lanePath) acq = io.acquireLane({ laneRepo: planned.laneRepo, slug, actorId, waitMs: laneWaitMs });
    timings.acquireMs = io.now() - tA;
    if (!acq.lanePath) {
      const d = nextLaneDeferral(prev);
      classified = { outcome: d.outcome, verdict: null, loopOutcome: null, runId: null, label: d.label };
      try { acquireSpan?.fail(new Error(acq.error || 'no free lane'), { outcome: d.outcome }); } catch { /* telemetry never throws */ }
      io.log(`review-job ${slug}: no lane (${acq.error || 'pool full'}) — ${d.outcome} (${d.label}); the next tick retries`);
      return result({ ...classified });
    }
    try { acquireSpan?.ok({ lanePath: acq.lanePath }); } catch { /* telemetry */ }
    lanePath = acq.lanePath;
    io.updateRecord({ ...record, cwd: lanePath, actorId });

    io.log(`review-job ${slug}: running review-loop-cli in ${lanePath}`);
    const loopSpan = span('review.loop');
    const tL = io.now();
    const loop = io.runLoop({ pr: planned.pr, repo: planned.repo, lanePath, actorId, timeoutMs: loopTimeoutMs });
    timings.loopMs = io.now() - tL;
    const parsed = parseReviewLoopStdout(loop.stdout);
    if (loop.timedOut) {
      classified = { outcome: BLOCKED_ON_INFRA, verdict: null, loopOutcome: null, runId: parsed?.runId ?? null, label: `review-loop timed out after ${loopTimeoutMs}ms` };
    } else if (parsed) {
      // #3647 — classify what the loop PRINTED even on a non-zero exit: a finished review whose secondary
      // filing step failed is still that review's real outcome.
      // THE REAL ERROR, NEVER SILENT: a loop that stopped before judging prints `{stopped, error}` (e.g.
      // `step-refused` + the refusal text). The label used to be only `exit 1`, and the added-seats arc then
      // reported "printed no diff" — the outage of 2026-10-03 hid its cause for hours.
      classified = { ...classifyReviewLoopOutcome(parsed), label: loopFailureLabel(parsed, loop.status) };
    } else {
      classified = {
        outcome: BLOCKED_ON_INFRA, verdict: null, loopOutcome: null, runId: null,
        label: `review-loop exit ${loop.status}: ${tail(crashLabelFromLoop(loop), 300)}`.slice(0, 500),
      };
    }
    try {
      if (classified.outcome === BLOCKED_ON_INFRA) loopSpan?.fail(new Error(classified.label || 'blocked-on-infra'), { outcome: classified.outcome });
      else loopSpan?.ok({ outcome: classified.outcome, verdict: classified.verdict, loopOutcome: classified.loopOutcome, runId: classified.runId });
    } catch { /* telemetry */ }
    if (classified.outcome === BLOCKED_ON_INFRA && classified.label) io.log(`review-job ${slug}: loop error — ${classified.label}`);
    io.log(`review-job ${slug}: loop finished in ${timings.loopMs}ms — ${classified.outcome} (verdict ${classified.verdict ?? '-'}, loop ${classified.loopOutcome ?? '-'}, run ${classified.runId ?? '-'})`);
    // #4194 — hand the added seats what they need; they run in `runReviewJob` once this arc has fully finished.
    if (parsed && !loop.timedOut) seatsBox.input = { pr: planned.pr, repo: planned.repo, lanePath, loopPayload: parsed, slug };
    return result({ ...classified, lanePath });
  } catch (e) {
    classified = { outcome: BLOCKED_ON_INFRA, verdict: null, loopOutcome: null, runId: null, label: tail(e?.message ?? e, 500) };
    io.log(`review-job ${slug}: crashed — ${classified.label}`);
    return result({ ...classified, lanePath });
  } finally {
    const done = classified ?? { outcome: BLOCKED_ON_INFRA, label: 'review-job exited without an outcome' };
    try {
      io.report({
        session: slug, pr: String(planned.pr), repo: planned.repo, status: 'done', outcome: done.outcome,
        ...(done.loopOutcome ? { verdict: done.loopOutcome } : {}),
        ...(done.runId ? { runId: done.runId } : {}),
        ...(done.label ? { label: String(done.label).slice(0, 500) } : {}),
      });
    } catch (e) { io.log(`review-job ${slug}: FAILED to write the done completion record — ${tail(e?.message ?? e, 200)}`); }
    if (lanePath) { try { io.releaseLane(slug); } catch { /* reported by the lane pool's own reaper */ } }
    try { io.unclaim(slug, pid); } catch { /* a stale record is pruned by pid next read */ }
    try { tel?.closeRoot({ outcome: done.outcome, label: done.label ?? null, attributes: { verdict: done.verdict ?? null, runId: done.runId ?? null } }); } catch { /* telemetry */ }
  }
}

// ── THE DISPATCH (what the daemon calls) ───────────────────────────────────────────────────────────────────────

/**
 * Start ONE review job for `repo#pr`, detached, and return at once — the daemon never waits on a review. Same
 * guards as the session path (`planReviewDispatch`, `assertNotALaneCheckout`, `assertMainNotStale`), plus two
 * of its own: a live job already on this PR refuses (belt to reconcile's braces), and a PR in the lane
 * cool-off is skipped. The child's env carries the GitHub App `gh` shim on `PATH` (the same override
 * `review-dispatch.mjs` hands a session through `--settings`), so every `gh` call the loop makes reads the fresh
 * shared token.
 * @returns {{mode:'job', pr:number, repo:string, sessionSlug:string, agentId:null, jobPid:(number|null),
 *   logPath:string, skipped?:string}}
 */
export function dispatchReviewJob({
  ciGate = readReviewCiGate,
  pr, repo, preferLane = null, root = REPO_ROOT, env = process.env, now = Date.now(), checkStaleness,
  dir = reviewJobsDir(env, root),
  spawnJob = defaultSpawnJob,
  readCompletion = (slug) => { try { return tryReadCompletion(slug); } catch { return null; } },
  resolveSettingsEnv = () => resolveGhShimSettingsEnv(undefined),
  isAlive = pidAlive,
  checkoutExists = existsSync, home = homedir(),
} = {}) {
  const planned = planReviewDispatch({ pr, repo, checkoutExists, home });
  assertNotALaneCheckout(root);
  // The job path is the DEFAULT review dispatch (the daemon calls it), so it must narrow a managed clone's
  // refusal to the review code path exactly like `dispatchReview` does (#4387). Without this the narrowing
  // never applied and every landed code file made the clone stale (live 2026-10-03: 21 commits behind).
  assertMainNotStale(root, checkStaleness, { dispatchPath: isReviewCodePath });
  const slug = planned.sessionSlug;
  const logPath = jobLogPath(slug, dir);
  const base = { mode: 'job', pr: planned.pr, repo: planned.repo, repoKey: planned.repoKey, sessionSlug: slug, agentId: null, logPath };

  const existing = readJobRecord(slug, dir);
  if (existing && Number.isInteger(existing.pid) && isAlive(existing.pid)) {
    return { ...base, jobPid: existing.pid, skipped: 'live-job' };
  }
  if (laneCooloffActive(readCompletion(slug), now)) {
    return { ...base, jobPid: null, skipped: 'lane-cooloff' };
  }

  const ci = ciGate({ repo: planned.repo, pr: planned.pr });
  if (!ci?.allowed) return { pr: planned.pr, repo: planned.repo, headSha: ci?.headSha ?? null, skipped: formatReviewCiSkip(ci), ci };
  const settingsEnv = resolveSettingsEnv() || {};
  const childEnv = { ...env, ...settingsEnv };
  // The dispatcher's own actor id (if it happens to run inside a session) must never leak into the job — the
  // job mints its own per round.
  delete childEnv[ACTOR_ENV];
  mkdirSync(dir, { recursive: true });
  const jobPid = spawnJob({
    argv: [THIS_FILE, 'run', `--pr=${planned.pr}`, `--repo=${planned.repo}`,
      ...(Number.isInteger(preferLane) && preferLane > 0 ? [`--prefer-lane=${preferLane}`] : [])], cwd: root, env: childEnv, logPath,
  });
  // Claim the slot for the child NOW, so the very next reader (a tick 120s later, or a status tag this same
  // tick) sees it — the child's own claim then finds its own pid already recorded and proceeds.
  if (Number.isInteger(jobPid)) {
    writeJobRecord({ slug, pr: planned.pr, repo: planned.repo, pid: jobPid, startedAt: new Date(now).toISOString(), cwd: root }, dir);
  }
  return { ...base, jobPid: Number.isInteger(jobPid) ? jobPid : null };
}

/** The real detached spawn: stdout/stderr appended to the job's own log, the child unref'd so the daemon's
 *  event loop never waits on it. */
export function defaultSpawnJob({ argv, cwd, env, logPath }) {
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, argv, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * The daemon's dispatch: the job by default, the old `claude --bg` session only when
 * {@link REVIEW_DISPATCH_MODE_ENV}`=session` asks for it.
 */
// Under test the stack check is inert unless a test injects one: the default reads `gh` and the network.
export function dispatchReviewByMode({ mode = resolveReviewDispatchMode(), stackCheck = isUnderTest() ? () => ({ base: null }) : checkStackBeforeReview, ...opts } = {}) {
  // Held item 177 — a stacked top whose accept is recorded against its stack base is HELD (no review until the
  // bottom lands) or, once the stack collapsed with an identical net diff, CARRIED. Either way nothing is dispatched.
  let stack = null;
  try { stack = stackCheck({ pr: opts.pr, repo: opts.repo, root: opts.root ?? REPO_ROOT, env: opts.env ?? process.env }); }
  catch { stack = null; }
  if (stack?.skipped) return { mode, pr: opts.pr, repo: opts.repo, skipped: stack.skipped };
  const named = (r) => (stack?.base && r && !r.skipped
    ? { ...r, mode: `${r.mode ?? mode} against stack base #${stack.base.pr} (${stack.base.ref}@${stack.base.contained.slice(0, 9)})` }
    : r);
  if (mode === 'session') {
    const { preferLane, ...sessionOpts } = opts;
    return named({ mode: 'session', ...dispatchReview(sessionOpts) });
  }
  return named(dispatchReviewJob(opts));
}

const STACK_CARRY_HEAD = /^[0-9a-f]{40}$/;
const STACK_CARRY_FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * Held item 177 — before a review is dispatched, read this PR's stack state and any `reviewed-stack` accept marker.
 * FAILS OPEN: any read error dispatches the review as before. Only the Web Everything repo (the clone this runs in).
 * @returns {{skipped?:string, base?:object|null}}
 */
export function checkStackBeforeReview({ pr, repo, root = REPO_ROOT, env = process.env,
  readStack = (n) => readStackBase({ pr: n, root, env }),
  readThread = (n) => readStackThread(n, { repo, root }),
  stackText = (base) => stackNetDiffText({ tree: base.tree, topHead: base.topHead, root }),
  mainText = (pin) => mainNetDiffText(pin, { root }),
  readBottom = (marker) => readBottomLanded({ marker, repo, root }),
  carry = (n, decision) => carryStackAccept({ pr: n, repo, root, env, decision }),
  log = (line) => writeLineSync(2, line) } = {}) {
  if (!resolveStackAwareReview(env) || repoKeyForSlug(repo) !== 'we') return { base: null };
  const base = readStack(pr);
  let thread = null;
  try { thread = readThread(pr); } catch { thread = null; }
  const comments = Array.isArray(thread?.comments) ? thread.comments : [];
  if (base) log(`review-job: ${repo}#${pr} is stacked on #${base.pr} — its review reads the diff against ${base.ref}@${base.contained.slice(0, 9)} (the bottom's head), not main`);
  if (!liveStackMarkers(comments).some((m) => m.top === Number(pr))) return { base };
  let stackFingerprint = null;
  let mainFingerprint = null;
  if (base) { try { stackFingerprint = fingerprintOf(stackText(base)); } catch { stackFingerprint = null; } }
  else if (thread?.headRefName && STACK_CARRY_HEAD.test(String(thread.headRefOid ?? ''))) {
    // The fingerprint is of THIS commit (`headRefOid`), not of whatever the branch name points at by now; the carry
    // below is bound to that same commit and fingerprint.
    try { const net = mainText({ headRefName: thread.headRefName, headRefOid: thread.headRefOid }); mainFingerprint = net?.scored ? fingerprintOf(net.text) : null; } catch { mainFingerprint = null; }
  }
  // The bottom is read only for a PR that would otherwise carry (collapsed stack, identical own diff): a bottom that
  // moved after the accept must be reviewed again, whatever the top's own diff says.
  let bottomLanded = null;
  const latest = liveStackMarkers(comments).filter((m) => m.top === Number(pr)).at(-1);
  if (!base && latest && mainFingerprint && mainFingerprint === latest.fingerprint) {
    try { bottomLanded = readBottom(latest); } catch (e) { bottomLanded = { ok: false, why: `the landing could not be read (${String(e?.message ?? e).slice(0, 120)})` }; }
  }
  const decision = decideStackDispatch({ pr, stack: base, comments, stackFingerprint, mainFingerprint, bottomLanded });
  if (decision.action === 'review' && decision.why) log(`review-job: ${repo}#${pr} ${decision.why} — reviewing as usual`);
  if (decision.action === 'held') return { base, skipped: decision.why };
  if (decision.action === 'carry') {
    const done = carry(pr, { ...decision, head: thread.headRefOid, fingerprint: mainFingerprint });
    if (done?.ok) { log(`review-job: ${repo}#${pr} ${decision.why} — accept carried forward`); return { base, skipped: decision.why }; }
    log(`review-job: ${repo}#${pr} stack-accept carry failed (${done?.error ?? 'unknown'}) — reviewing as usual`);
  }
  return { base };
}

/**
 * Carry a stacked accept forward through the SINGLE HOME (`review-set-label.mjs --to=accepted`), which re-derives
 * the net diff vs main itself and stamps `reviewed-sha`/`reviewed-diff` for it.
 *
 * BOUND TO WHAT WAS COMPARED. The comparison read the PR at one commit (`decision.head`) and found its net diff
 * byte-identical to the accepted one (`decision.fingerprint`). The writer re-reads the PR on its own, so a push in the
 * gap would otherwise get an accept stamped on a diff nobody compared. Both are therefore handed to the writer
 * (`--expect-head`, `--expect-fingerprint`), which refuses, before any write, a live head or a derived net diff that
 * differs. A decision without a full head and fingerprint is refused here, never carried unpinned.
 */
export function carryStackAccept({ pr, repo, root = REPO_ROOT, env = process.env, decision,
  run = (args, o) => spawnSync(process.execPath, args, o) } = {}) {
  try {
    const head = String(decision?.head ?? '');
    const fingerprint = String(decision?.fingerprint ?? '');
    if (!STACK_CARRY_HEAD.test(head) || !STACK_CARRY_FINGERPRINT.test(fingerprint)) {
      return { ok: false, error: 'carry refused: the compared head and fingerprint are not both known' };
    }
    const bodyPath = join('/tmp', `review-stack-carry-${String(repo).replace(/[^\w.-]+/g, '-')}-${pr}-${randomUUID()}.md`);
    const m = decision.marker;
    writeFileSync(bodyPath, [
      `**Stacked accept carried forward.** This PR was accepted against #${m.bottom}'s head (\`${m.bottomRef}\` @ ${String(m.contained).slice(0, 12)}).`,
      `#${m.bottom} is no longer below it, and its net diff vs main is byte-identical to the accepted diff (fingerprint \`${m.fingerprint.slice(0, 16)}\`), so the accept stands without another review.`,
    ].join('\n\n'), 'utf8');
    const res = run([join(root, 'scripts', 'review-set-label.mjs'), String(pr), `--repo=${repo}`, '--to=accepted',
      `--actor=${UNATTENDED_REVIEW_ACTOR}`, `--body-file=${bodyPath}`, `--expect-head=${head}`, `--expect-fingerprint=${fingerprint}`],
    { cwd: root, encoding: 'utf8', timeout: 180e3, env: { ...env, [ACTOR_ENV]: `review-stack-carry-${randomUUID()}` } });
    try { rmSync(bodyPath, { force: true }); } catch { /* tmp */ }
    return res?.status === 0 ? { ok: true } : { ok: false, error: String(res?.stderr || res?.stdout || `exit ${res?.status}`).trim().split('\n').pop() };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE);
if (IS_CLI) {
  const [sub, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const hit = rest.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  if (sub !== 'run') {
    writeLineSync(2, 'usage: review-job.mjs run --pr=<n> --repo=<owner/repo>');
    process.exitCode = 2;
  } else {
    // No signal handler: the arc is synchronous, so a handler could not run before the in-flight child returns
    // anyway. A killed job leaves a record with a dead pid (pruned on the next read) and, at worst, a lease under
    // its slug, which the lane pool's ghost-lease reaper reclaims (#2748).
    try {
      const lane = Number(flag('prefer-lane'));
      const out = runReviewJob({ pr: flag('pr'), repo: flag('repo'),
        preferLane: Number.isInteger(lane) && lane > 0 ? lane : null });
      writeAllSync(1, `${JSON.stringify(out)}\n`);
      // #4075/run-rating slice 1 — mechanical grading for this now-finished job-mode review, read back from
      // THIS job's own log file (stdout/stderr above were redirected there by `dispatchReviewJob`'s spawn — see
      // that function's own `openSync(logPath, 'a')`). Best-effort: `rateAndRecordReviewJob` never throws, and
      // a rating failure must never affect this CLI's own exit code. A refused job ran no review — nothing to
      // rate (`rateReviewJobLog` also skips any summary with no loop timing, the same guard at the pure layer).
      if (out.sessionSlug && !out.refused) { try { rateAndRecordReviewJob(jobLogPath(out.sessionSlug)); } catch { /* best-effort */ } }
      process.exitCode = out.refused ? 75 : 0;
    } catch (e) {
      writeLineSync(2, `review-job: error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
