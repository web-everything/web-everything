#!/usr/bin/env node
/**
 * @file scripts/conveyor/canary.mjs
 * @description x0nxuqd (epic #4075/#3383) — THE REAL END-TO-END DISPATCH CANARY. One entry point:
 *
 *   node scripts/conveyor/canary.mjs [--repo=<owner>/<name>] [--timeout-ms=N] [--poll-ms=N]
 *
 * Dispatches ONE tiny, real `claude --bg` session through the SAME production dispatch path every
 * build/fix/ci-heal daemon uses (`we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks` — read-only
 * import, never re-derived): the same scratch cwd (`dispatchSessionCwd`), the same dynamic trust grant
 * (`grantDispatchTrust`, internal to the sink), the same `--settings` env composition
 * (`resolveDispatchSettingsEnv`), the same append-system-prompt file
 * (`DISPATCHED_AGENT_SYSTEM_PROMPT_FILE`), and the same generic brief-filling machinery (`fillBrief`,
 * `we:scripts/operations/dispatch-lane.mjs`) every kind fills its own brief with — just a dedicated, tiny
 * brief (`we:skills-src/conveyor/canary-agent-brief.md`) instead of a real backlog item's delivery brief.
 *
 * WHY THIS EXISTS: the daemon-soak harness (`we:scripts/conveyor/soak/`) simulates every session with a FAKE
 * world (`w.claude.sessions()`), so it structurally cannot catch a break in the REAL `claude --bg` path — which
 * is exactly what PR #2701 (dispatched sessions now start in a scratch cwd outside every trusted checkout, card
 * #4174) broke: a session's first `Edit` into its own freshly-acquired lane clone can hang on an unanswerable
 * permission prompt, because nobody is watching a `--bg` session turn by turn. The operator's own rule for this
 * class of daemon change: "one real end-to-end run before counting a daemon change as proven." This is that
 * run, packaged as a single command any daemon-change worker can run after loading an overlay.
 *
 * WHAT IT WATCHES FOR, per stage (`we:scripts/conveyor/canary-stages.mjs`'s pure evaluator — see that file for
 * the full contract): spawned · no-permission-prompt · lane-acquired · edit-ok · gate-ran · pushed ·
 * session-finished · cleaned-up (lane released, throwaway branch deleted, scratch folder reaped).
 *
 * BOUNDED, ALWAYS. This process blocks in the FOREGROUND until the canary's own session finishes or
 * `--timeout-ms` elapses (default 10 minutes) — it never backgrounds itself and never asks its caller to poll a
 * task-output file (the exact anti-pattern `we:CLAUDE.md`'s pinned rule exists to prevent). Cleanup always runs,
 * whether the run passed, failed, or timed out.
 *
 * COST: the spawned session's own brief (`canary-agent-brief.md`) is deliberately tiny — one lane acquire, one
 * new one-line marker file, one gate run, one push to a throwaway `canary/<timestamp>` branch, no PR — so a
 * real run costs a few minutes on the operator's own default (Sonnet) worker tier, not a full delivery's worth
 * of tokens.
 */
import { readGit } from '../lib/proc-read.mjs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT, createDispatchSinks,
  dispatchSessionCwd, defaultListAgents, revokeDispatchTrust,
} from '../operations/dispatch-lane-io.mjs';
import { DISPATCH_EFFECT, fillBrief, REPO_AWARE_VALUE_PATTERNS, DISPATCH_LISTING_GRACE_MINUTES } from '../operations/dispatch-lane.mjs';
import { gateFor } from '../lib/repo-profile.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { resolveSessionTranscript } from '../operations/agent-usage-report.mjs';
import { tailLines, summarizeEntry } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { evaluateCanaryStages, CANARY_STAGES, watchCanary, runCanaryCleanup, overallOf,
  clipToolResults, TRANSCRIPT_SCAN_FIELD_MAX } from './canary-stages.mjs';

const CANARY_BRIEF_PATH = join(REPO_ROOT, 'skills-src', 'conveyor', 'canary-agent-brief.md');

/** Default overall bounded watch — long enough for a real lane-acquire + tiny edit + diff-selected gate +
 *  push (a few minutes), short enough that a genuinely wedged canary (the exact #2701 shape) still reports in
 *  bounded time rather than hanging the worker that ran it. Overridable via `--timeout-ms`. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 8 * 1000;
/** Bounded read of the spawned session's own transcript — never the whole file (mirrors `hung-session.mjs`'s
 *  own discipline). */
const TRANSCRIPT_TAIL_LINES = 60;
const TRANSCRIPT_MAX_BYTES = 800_000;

function parseArgs(argv) {
  const out = { repo: CONSTELLATION_REPOS.we.slug, timeoutMs: DEFAULT_TIMEOUT_MS, pollMs: DEFAULT_POLL_MS };
  for (const arg of argv) {
    const m = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'repo') out.repo = m[2];
    else if (m[1] === 'timeout-ms') out.timeoutMs = Math.max(30_000, Number(m[2]) || DEFAULT_TIMEOUT_MS);
    else if (m[1] === 'poll-ms') out.pollMs = Math.max(1000, Number(m[2]) || DEFAULT_POLL_MS);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function log(line) {
  process.stderr.write(`canary: ${line}\n`);
}

/** Best-effort `git ls-remote` for one ref on origin — never throws, answers `null` on any read failure so the
 *  caller treats "could not tell" distinctly from a confirmed absence. */
function refExistsOnOrigin(ref, { root = REPO_ROOT } = {}) {
  try {
    const out = readGit(['ls-remote', '--exit-code', 'origin', `refs/heads/${ref}`], {
      cwd: root, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out || '').trim().length > 0;
  } catch (e) {
    // `--exit-code` makes a genuine absence exit 2, not a thrown parse error — that is a confirmed `false`,
    // never `null`. Anything else (network, auth, timeout) is a real "could not tell".
    if (e && e.status === 2) return false;
    return null;
  }
}

/** Does `lane` still carry a live lease held by `session`? Read from `lane-pool.mjs status --json` (whose
 *  per-lane `lease.session` is the slug `acquire --session=` recorded). Never throws — `null` on any read
 *  failure, so the caller keeps "could not tell" distinct from a confirmed release. */
function laneLeasedTo(lane, session) {
  try {
    const out = execFileSync('node', ['scripts/lane-pool.mjs', 'status', '--json', `--lane=${lane}`, '--leased-only'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const row = (JSON.parse(out).lanes || []).find((l) => l?.lane === lane);
    if (!row) return null;
    return row.lease?.session === session;
  } catch {
    return null;
  }
}

/** Bounded, never-throwing transcript read for one `claude agents --json` row. Mirrors
 *  `we:scripts/conveyor/hung-session.mjs#readHungInfo`'s own IO shape (same tail size discipline, same
 *  "prefer the transcript's own newest embedded timestamp over file mtime" rule) without importing that file's
 *  hung-specific verdict — this canary needs the raw entries + newest timestamp, not a hung/not-hung answer. */
function readTranscriptTail(agentRow) {
  if (!agentRow?.cwd || !agentRow?.sessionId) return { entries: [], newestEntryAtMs: null };
  let file;
  try {
    file = resolveSessionTranscript({ session: String(agentRow.sessionId), cwd: String(agentRow.cwd) });
  } catch {
    return { entries: [], newestEntryAtMs: null };
  }
  let entries;
  try {
    const { lines } = tailLines(file, TRANSCRIPT_TAIL_LINES, TRANSCRIPT_MAX_BYTES);
    // Summarize with a large cap, THEN clip each tool_result to head + tail: the shared summarizer keeps only
    // a field's head, which would always cut off `verify-lane run`'s green line (printed last, after the
    // whole gate output).
    entries = lines.map((l) => clipToolResults(summarizeEntry(l, TRANSCRIPT_SCAN_FIELD_MAX)));
  } catch {
    return { entries: [], newestEntryAtMs: null };
  }
  let newestEntryAtMs = null;
  for (const e of entries) {
    const t = Date.parse(e?.ts ?? '');
    if (Number.isFinite(t) && (newestEntryAtMs === null || t > newestEntryAtMs)) newestEntryAtMs = t;
  }
  return { entries, newestEntryAtMs };
}

function printStages(stages, overall) {
  for (const s of stages) {
    const mark = s.status === 'pass' ? 'PASS' : s.status === 'fail' ? 'FAIL' : 'PENDING';
    log(`  [${mark}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  }
  log(`overall: ${overall.toUpperCase()}`);
}

async function main() {
  const { repo, timeoutMs, pollMs } = parseArgs(process.argv.slice(2));
  // Today this canary only exercises the WE dispatch path (its own lane pool, its own gate) — `--repo` is
  // still accepted and used to RESOLVE that gate (via the same `gateFor` a real fix/ci-heal brief calls),
  // so a caller naming a different constellation repo gets an honest refusal rather than a silently-wrong
  // WE gate substituted underneath it.
  const gateCommand = gateFor(repo, { weRoot: REPO_ROOT });
  if (!gateCommand) {
    log(`could not resolve a gate command for --repo=${repo} (gateFor returned null) — refusing to dispatch a canary with no gate to run`);
    process.exitCode = 1;
    return;
  }

  const canaryId = String(Date.now());
  const sessionSlug = `canary-${canaryId}`;
  const branchRef = `canary/${canaryId}`;
  const sessionUuid = randomUUID(); // minted HERE, not left to the sink — see below for why.
  const startedAtMs = Date.now();

  const briefTemplate = readFileSync(CANARY_BRIEF_PATH, 'utf8');
  const { prompt, unknownTokens } = fillBrief(
    briefTemplate,
    { SESSION_SLUG: sessionSlug, CANARY_ID: canaryId, WE_ROOT: REPO_ROOT, GATE_COMMAND: gateCommand },
    ['SESSION_SLUG', 'CANARY_ID', 'WE_ROOT', 'GATE_COMMAND'],
    [],
    REPO_AWARE_VALUE_PATTERNS,
  );
  if (unknownTokens.length) log(`brief carries unknown placeholder(s), left verbatim: ${unknownTokens.join(', ')}`);

  log(`dispatching ${sessionSlug} (repo=${repo}, gate="${gateCommand}")`);

  // #4174's own scratch-cwd formula, computed HERE with a session id WE minted (`mintSessionId` override
  // below), so the canary knows exactly where to look/clean up without guessing at the CLI's own printed
  // handle — that handle is `claude --bg`'s OWN id (`parseBackgroundedId`), a DIFFERENT string from the uuid
  // that actually determines the scratch cwd path (`dispatchSessionCwd`). Overriding `mintSessionId` is the one
  // seam `createDispatchSinks` exposes for exactly this — every other default stays production's own.
  const sinks = createDispatchSinks({ root: REPO_ROOT, mintSessionId: () => sessionUuid });
  const scratchCwd = dispatchSessionCwd(sessionUuid, { root: REPO_ROOT });

  let spawned = false;
  let dispatchError = null;
  try {
    await sinks[DISPATCH_EFFECT]({
      prompt,
      sessionSlug,
      num: 'canary',
      launchKind: 'canary',
      expectedWithinMinutes: Math.ceil(timeoutMs / 60_000),
    });
    spawned = true;
  } catch (e) {
    dispatchError = e;
    log(`dispatch failed: ${String((e && e.message) || e)}`);
  }

  const listingGraceMs = DISPATCH_LISTING_GRACE_MINUTES * 60_000;
  let laneNumberSeen = null;
  let pushedGroundTruth = null;
  let sessionFinished = spawned ? null : true; // a failed spawn is trivially "finished" — nothing is running.
  let finalStages = null;

  if (spawned) {
    // The loop itself lives in `canary-stages.mjs#watchCanary` (unit-tested); this shell only wires the real
    // reads. `defaultListAgents` signals a failed read by THROWING, which is exactly the contract it expects.
    ({ sessionFinished, laneNumberSeen, pushedGroundTruth, stages: finalStages } = await watchCanary({
      sessionSlug, branchRef, startedAtMs, timeoutMs, pollMs, listingGraceMs,
      deps: {
        now: () => Date.now(),
        sleep,
        listAgents: () => defaultListAgents({}),
        readTranscriptTail,
        refExistsOnOrigin: (ref) => refExistsOnOrigin(ref),
      },
    }));
  }

  // ── Cleanup — always runs, whatever the verdict above, but a session CONFIRMED STILL ALIVE never gets its
  // own lane / scratch cwd ripped out from under it. Caught live on x0nxuqd's own first real run: a session
  // stalled on the exact #2701 permission-prompt shape (`state: 'blocked'`, never resolving) was still a real,
  // running process when this canary's bounded watch timed out, and an earlier version of this cleanup
  // force-deleted its scratch cwd anyway — a real hazard this rewrite closes. The system's own
  // `we:scripts/conveyor/session-reaper.mjs` already owns reaping a FINISHED dispatched session's scratch cwd
  // (+ its trust entry) and a stalled lane's lease (the lease-reaper stall backstop); this canary defers to
  // both rather than racing them against a session that may still be alive. ─────────────────────────────────
  log('cleaning up …');
  if (sessionFinished !== true) {
    log(`session not confirmed finished (state may still be alive) — deferring lane release + scratch reap to the resident session-reaper rather than deleting a live process's files`);
  }
  // The "never touch a live session's lane / scratch cwd" ordering lives in `canary-stages.mjs#runCanaryCleanup`
  // (unit-tested with these same effects stubbed); this shell only supplies the real ones.
  const { laneReleased, branchDeleted, scratchReaped, pushedForCleanup } = runCanaryCleanup({
    sessionFinished, laneNumberSeen, sessionSlug, branchRef, pushedGroundTruth, scratchCwd,
    deps: {
      releaseLane: (lane, session) => {
        execFileSync('node', ['scripts/lane-pool.mjs', 'release', `--lane=${lane}`, `--session=${session}`, '--force'], {
          cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', stdio: 'ignore',
        });
      },
      laneLeasedTo,
      refExistsOnOrigin: (ref) => refExistsOnOrigin(ref),
      deleteRemoteBranch: (ref) => {
        execFileSync('git', ['push', 'origin', '--delete', ref], {
          cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', stdio: 'ignore',
        });
      },
      pathExists: existsSync,
      removeDir: (p) => rmSync(p, { recursive: true, force: true }),
      revokeTrust: revokeDispatchTrust,
    },
  });

  const final = evaluateCanaryStages({
    spawned,
    entries: [],
    nowMs: Date.now(),
    pushedGroundTruth: pushedForCleanup,
    // Pass the REAL value through, `null` included — never coerce an unresolved listing read into a claimed
    // `true`. `evaluateCanaryStages` already treats a null-and-timed-out session as "not finished" (`fail`,
    // honestly naming the unresolved outcome) rather than needing this caller to guess on its behalf.
    sessionFinished,
    cleanup: { laneReleased, branchDeleted, scratchReaped },
    timedOut: true, // cleanup only ever runs once the watch is over — every remaining "pending" must resolve
  });
  // Carry forward whichever richer, transcript-informed verdict the watch loop already produced for the
  // stages BEFORE cleanup (spawned .. session-finished) — only `cleaned-up` needed a fresh evaluation here.
  const stagesByName = Object.fromEntries((finalStages || final.stages).map((s) => [s.name, s]));
  stagesByName['cleaned-up'] = final.stages.find((s) => s.name === 'cleaned-up');
  const mergedStages = CANARY_STAGES.map((name) => stagesByName[name]);
  const mergedOverall = overallOf(mergedStages);

  log(`canary ${canaryId} — ${repo} — done watching`);
  printStages(mergedStages, mergedOverall);
  if (dispatchError) log(`dispatch error detail: ${String((dispatchError && dispatchError.message) || dispatchError)}`);

  process.exitCode = mergedOverall === 'pass' ? 0 : 1;
}

main().catch((e) => {
  log(`fatal: ${String((e && e.stack) || e)}`);
  process.exitCode = 1;
});
