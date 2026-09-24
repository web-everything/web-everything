#!/usr/bin/env node
/**
 * @file skills-src/conveyor/runner.mjs
 * @description The conveyor HEADLESS RUNNER (WE #2702, epic #2677(b), the DELEGATE half) — a SINGLETON-LOCKED,
 *   no-LLM runner that drives the mechanized tick core ({@link ../../scripts/conveyor/tick-core.mjs}, #2699)
 *   for the conveyor. It reads state and STEPS the tested state machine — it spends NO model context per tick
 *   (memory rule / #2701 clause 1): every guard, TTL, re-dispatch gate, watcher-arm, and idle-stop decision is
 *   the tick core's, applied deterministically; the runner is a THIN SHELL that threads the core's `nextState`
 *   into the next tick UNCHANGED and SURFACES the tick's decisions. It never re-derives a guard rule.
 *
 * WHAT #2701 SETTLES (the ratified mechanics-not-agent boundary, codified at
 *   [we:docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent]):
 *   1. The per-lane driver is a headless runner over the tested tick-core state machine — no per-tick model
 *      context. THIS file is that runner.
 *   2. NO per-lane conducting agent (Option B rejected) — so this is ONE singleton-locked runner, not an
 *      always-on LLM conductor per lane. The singleton right is held by {@link ./runner-lock.mjs}.
 *   3. A single supervisor is deferred (Option C) and genuine NOVELTY escalates to the main-session judgment
 *      layer — the runner never improvises a ruling. So the runner EMITS its dispatch/watch decisions
 *      ({@link tickSurface}) for the judgment layer to execute; it does not itself spawn LLM delivery agents.
 *
 * SCOPE (#2702, NOT #2703): this builds the runner MECHANISM — the singleton lock + the loop that steps the
 *   core, carries bookkeeping, runs the deterministic no-LLM passes (infra-blocked recovery §4b, lease-reaper
 *   §4c, session-reaper §4d, the reconcile-fix dispatch pass #3438), and surfaces the tick. It does NOT retire
 *   the main-session serial loop (that is #2703, blocked on this) and does NOT wire headless LLM agent-spawning
 *   (the CLI agent-runner backend,
 *   [#agent-runner-cli-backend]) — both belong to the retirement slice. The guard SEMANTICS are PRESERVED
 *   verbatim: they live in the tick core; the runner alters none of them.
 *
 * PURE-CORE / IO-SHELL SPLIT (the hard design constraint, mirrored from tick-core.mjs):
 *   • The PURE core ({@link carryForward}, {@link shouldStop}, {@link tickSurface}, {@link runLoop}) has NO
 *     fs / child_process / clock of its own — every effect (stepping a tick, the mechanical passes, emitting,
 *     heartbeating the lease, sleeping) is INJECTED. `runLoop` is the runner's whole control flow, unit-tested
 *     (skills-src/conveyor/__tests__/runner.test.mjs) with fake effects — no git/network, no real lease.
 *   • The IO SHELL (the `main()` CLI + the `cli*` effect builders, gated on the main-module check) shells
 *     `tick-core.mjs` (bookkeeping in on STDIN, `{ decisions, nextState }` out), runs the two deterministic
 *     passes, prints the surface, and heartbeats the real singleton lease.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, renameSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { defaultFetchOpenPrs } from '../../scripts/conveyor/open-pr-fetch.mjs';
import {
  RUNNER_LOCK_ROOT, runnerOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';
import { execFileSync } from 'node:child_process';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../../scripts/lib/constellation-repos.mjs';
import { readUnsupported, recordUnsupported } from '../../scripts/conveyor/unsupported-repo.mjs';
import { selectStatusCandidates } from '../../scripts/conveyor/reconcile-core.mjs';
import { localDateString } from '../../scripts/lib/local-date.mjs';
import { withSelfSync } from '../../scripts/lib/daemon-self-sync.mjs';
import { withGithubAppAuth } from '../../scripts/lib/github-app-auth-env.mjs';

/** The runner's tick interval — matches the SKILL's chained-sleep heartbeat (§2.5): ~120 s, just under the
 *  5-min prompt-cache window so a main-session loop's ticks stay cheap. The headless runner spends no model
 *  context, so the interval is only about how promptly it reacts to freed lanes / new PRs. */
export const DEFAULT_TICK_INTERVAL_MS = 120_000;

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/**
 * Build the NEXT tick's STDIN payload from THIS tick's output, threading `nextState` through UNCHANGED. This
 * is the thin-shell invariant made explicit: the runner carries the tick core's bookkeeping forward verbatim
 * — it never edits a guard, a TTL counter, or the watcher set (the core owns all of it). `signals` (e.g.
 * `returnedBuildNums`) are the ONLY thing the runner may add, and only from observed agent completions.
 * @returns {{ bookkeeping: object, signals: object }}
 */
export function carryForward(out, { signals = {} } = {}) {
  return { bookkeeping: (out && out.nextState) || {}, signals: signals || {} };
}

/**
 * Decide whether the loop STOPS after processing this tick. Two mechanical stop conditions, both from the core
 * (never re-derived): the core's `decisions.idleStop` (queue-empty AND no operator feedback for the window),
 * or a spent tick budget (`--max-ticks`, for a bounded/`--once` run). Pure — no clock.
 * @returns {{ stop: boolean, reason: string|null }}
 */
export function shouldStop(out, { tick = 0, maxTicks = Infinity } = {}) {
  if (out && out.decisions && out.decisions.idleStop) return { stop: true, reason: 'idle-stop' };
  if (Number.isFinite(maxTicks) && tick + 1 >= maxTicks) return { stop: true, reason: 'max-ticks' };
  return { stop: false, reason: null };
}

/**
 * The tick's SURFACE — exactly what the headless runner emits each tick. It spends no model context, so it
 * does NOT spawn the delivery / prepare / fix / CI-heal agents itself; it hands the core's already-filtered
 * decisions to the judgment layer to execute (#2701 clause 3), alongside the status line and per-tick notes.
 * A pure projection of `decisions` — it invents nothing and drops nothing.
 */
export function tickSurface(out) {
  const d = (out && out.decisions) || {};
  return {
    statusLine: d.statusLine || '',
    notes: Array.isArray(d.notes) ? d.notes : [],
    dispatch: {
      builds: Array.isArray(d.spawnBuilds) ? d.spawnBuilds : [],
      prepareScope: Array.isArray(d.spawnPrepareScope) ? d.spawnPrepareScope : [],
      prepareDecision: Array.isArray(d.spawnPrepareDecision) ? d.spawnPrepareDecision : [],
      fixes: Array.isArray(d.spawnFixes) ? d.spawnFixes : [],
      ciHeals: Array.isArray(d.spawnCiHeals) ? d.spawnCiHeals : [],
    },
    armWatchers: Array.isArray(d.armWatchers) ? d.armWatchers : [],
    // 2026-09-14 (#3521/lane-2 incident) — the tick core's SELF-DIAGNOSED stall list (see `advanceHeldStall` /
    // `tick-core.mjs`): items held on the exact same reason for `stallTicks` consecutive ticks. Projected
    // through verbatim so both the human-readable `emit` text and the durable external status file (below)
    // carry it — a driver that is stuck now says so itself, instead of a human having to notice the absence
    // of progress across many raw ticks the way this incident required.
    stalled: Array.isArray(d.stalled) ? d.stalled : [],
    // 2026-09-14 (#3521 decision-trace v1) — the tick core's plain-language "why" for its OWN dispatch/skip/
    // stall decisions this tick (see `buildDecisionTrace` / `tick-core.mjs`). Projected through so the durable
    // trace sidecar (below) can log it without re-deriving anything.
    decisionTrace: Array.isArray(d.decisionTrace) ? d.decisionTrace : [],
  };
}

/**
 * The runner's WHOLE control flow, as a reducer over injected effects — so it is unit-testable with fakes and
 * carries no IO of its own. Each tick: step the core (`tickOnce`), emit the surface, run the deterministic
 * mechanical passes, check stop, heartbeat the singleton lease, sleep, then carry `nextState` forward. A lost
 * lease (another process reclaimed a stale runner) STOPS the loop — the singleton right to drive is gone.
 *
 * @param {object} effects
 * @param {(payload:object)=>Promise<object>|object} effects.tickOnce  step the tick core → `{ decisions, nextState }`
 * @param {(surface:object,ctx:object)=>any} [effects.emit]            surface the tick (status + notes + dispatch)
 * @param {(ctx:object)=>any} [effects.mechanicalPasses]              run the no-LLM passes (§4b infra, §4c/§4d reapers)
 * @param {()=>boolean|Promise<boolean>} [effects.heartbeat]           extend the singleton lease; false ⇒ lost
 * @param {(ms:number)=>any} [effects.sleep]                           wait between ticks
 * @param {number} [effects.intervalMs]                                tick interval
 * @param {number} [effects.maxTicks]                                  bounded-run tick budget (Infinity = forever)
 * @param {object} [effects.initial]                                   first tick's STDIN payload (default `{}`)
 * @returns {Promise<{ ticks: number, stoppedReason: string, lastOut: object|null }>}
 */
export async function runLoop({
  tickOnce,
  emit = () => {},
  mechanicalPasses = () => {},
  heartbeat = () => true,
  sleep = () => {},
  intervalMs = DEFAULT_TICK_INTERVAL_MS,
  maxTicks = Infinity,
  initial = {},
} = {}) {
  if (typeof tickOnce !== 'function') throw new TypeError('runLoop requires a tickOnce effect');
  let payload = initial || {};
  let tick = 0;
  let stoppedReason = 'unknown';
  let lastOut = null;
  // The loop stops on the core's idle-stop, a spent `maxTicks` budget, or a lost lease; a real run passes
  // `maxTicks: Infinity` and relies on idle / lease-loss to end it (a test always bounds it via `maxTicks`).
  for (;;) {
    const out = await tickOnce(payload);
    lastOut = out;
    await emit(tickSurface(out), { tick });
    // Best-effort deterministic passes — a throw here must never wedge the loop (mirrors the SKILL's §4b/§4c/§4d
    // "best-effort; its exit never gates the tick").
    try { await mechanicalPasses({ tick, out }); } catch { /* best-effort — a pass failure never stalls a tick */ }

    const stop = shouldStop(out, { tick, maxTicks });
    if (stop.stop) { stoppedReason = stop.reason; break; }

    // Extend the singleton lease BEFORE sleeping; if it was reclaimed away (this runner went stale), STOP — we
    // no longer hold the sole-driver right, and continuing would risk the double-dispatch the lock prevents.
    const alive = await heartbeat();
    if (!alive) { stoppedReason = 'lease-lost'; break; }

    await sleep(intervalMs);
    // No `signals` folded in: this runner spawns no LLM agents (it only SURFACES the core's decisions — #2701
    // clause 3), so it observes no agent RETURN and has no `returnedBuildNums` to inject. Build guards still
    // retire via the CLAIMED path off each tick's fresh state read. Folding observed returns is #2703's job
    // (wiring headless agent-spawning), not this slice's.
    payload = carryForward(out);
    tick += 1;
  }
  return { ticks: tick + 1, stoppedReason, lastOut };
}

// ── IO SHELL (runs only as a CLI — owns all child_process / real lease; keeps the pure core effect-free) ────

/** Build the real `tickOnce` effect: shell `tick-core.mjs`, pipe the bookkeeping payload in on STDIN, parse
 *  `{ decisions, nextState }` off STDOUT. This is the SAME core the main-session SKILL loop shells (§2b) — the
 *  runner and the SKILL can never disagree on a guard, because there is exactly ONE core. */
function makeCliTickOnce({ tickCorePath, repo = null }) {
  return async (payload) => {
    const { execFileSync } = await import('node:child_process');
    const args = [tickCorePath];
    if (typeof repo === 'string' && repo) args.push(`--repo=${repo}`);
    const out = execFileSync('node', args, {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  };
}

/** Build the real `mechanicalPasses` effect: the deterministic, no-LLM passes the SKILL runs each tick —
 *  the infra-blocked recovery pass (§4b), the lease-reaper (§4c), the session-reaper (§4d, WE #3435 — stops
 *  a `claude agents` background session once ITS OWN process reports `done`/`failed`, a wholly separate
 *  resource from a lane lease), the reconcile-fix dispatch pass (#3438 — dispatches the fix agent
 *  `we:scripts/conveyor/reconcile-pass.mjs` decides is owed for a bounced PR with nothing live working it, a
 *  genuinely different population from `decisions.spawnFixes`'s own tick-core-launched-PRs-only scope; see that
 *  file's own header for the full reasoning), the branch-drift sweep (#3464 — `we:scripts/conveyor/
 *  branch-drift.mjs sweep`: reports the long-lived dispatched-work branch's live divergence/conflict state to
 *  its durable git-note report, the SAME "piggyback on a pass this headless runner already ticks" shape #3449
 *  used for lane-pool lease reconciliation, so drift is caught without a human or interactive session ever
 *  noticing it by hand), the parked-PR conflict watch (#xw0odtv — `we:scripts/conveyor/
 *  parked-pr-conflict-watch.mjs sweep`: labels + one-time-comments any review-parked PR that has drifted into a
 *  real merge conflict against `main`, catching exactly the axis branch-drift's single-branch watch and #2824's
 *  BEHIND-only freshness gate both leave uncovered), the general PR-landing-progress watch (we:3550 —
 *  `we:scripts/conveyor/parked-pr-progress-watch.mjs sweep`: flags a review-parked PR sitting past a
 *  configurable threshold with no independent review ever dispatched for it — the neglect axis neither
 *  sibling watch above catches), the review-reconcile pass (epic #3383, x5v8yy9 — reads
 *  `conveyor/reconcile-pass.mjs`'s own decision and dispatches `operations/review-dispatch.mjs` for every PR it
 *  names, plus the purely-informative `review-round-tag.mjs`/`review-status-tag.mjs` labels — the review step
 *  is now actually mechanized, not merely planned; see {@link selectStatusCandidates} for which PRs the status
 *  refresh covers), (#3421) the blocking-hiccup sink, and the CI queue-wait watch (#3574 — `we:scripts/
 *  conveyor/ci-queue-watch.mjs sweep`: samples `gh run list`'s started-minus-created wait time and appends it
 *  to a durable sidecar history, the SAME "piggyback on a pass this headless runner already ticks" shape
 *  branch-drift above uses, so a genuine Actions run-queue regression becomes a visible trend instead of
 *  invisible; purely informative — no dispatch gate reads its verdict). All ten are best-effort: a failure is
 *  swallowed (logged to stderr) and never gates the tick. Never a local merge — the drain stays the sole writer
 *  to `main`.
 *
 *  THE REVIEW-RECONCILE PASS needs no session-ephemeral bookkeeping of its own, unlike the tick's own
 *  build/prepare/fix/ci-heal guards: `reconcile-pass.mjs` reads real ground truth (findings on the PR, a live
 *  `claude agents` session bound to it via cwd/HEAD sha) every time it runs, so it can just be re-run every
 *  tick, safely — the same way `infra-blocked.mjs`/`lease-reaper.mjs` already are. Double-dispatch is already
 *  guarded UPSTREAM, not here: `reconcile-core.mjs`'s own liveness read binds a live session to a PR and
 *  refuses (`live-process`) BEFORE the `review` dispatch decision is ever reached, so a review already in
 *  flight for a PR simply does not appear in next tick's plan.
 *
 *  THE HICCUP SINK is the ONLY one of the eight that reads `out` (this tick's already-computed
 *  `decisions.suppressedBuilds` — the #3416 guard-suppression shape): it is the mechanical half of #3421's
 *  auto-file-a-fix story, filing a gated `blocking` learnings entry the moment a live guard holds a
 *  dispatch, rather than waiting for a human `/note`. It files NOTHING for the #3412 free-form-response
 *  shape — this runner spawns no LLM agents (#2701 clause 3) and so never observes an agent's return; that
 *  classification is the judgment layer's own job (skills-src/conveyor/SKILL.md), via the same
 *  hiccup-sink.mjs `fileHiccup`. */

/** Cap on {@link summarizeMechanicalPassError}'s output — generous for a real diagnostic, still bounded so one
 *  runaway stack trace can't flood `runner.log`. */
export const MECHANICAL_PASS_ERROR_LOG_CHARS = 800;

/**
 * The text `runQuiet` (below) logs for a failed mechanical pass — found live 2026-09-04 investigating a
 * `session-reaper.mjs` failure: `execFileSync`'s thrown error's OWN `.message` already carries the child's full
 * captured stderr, appended by Node itself after the leading `Command failed: <cmd>` line — but the previous
 * `String(e.message || e).split('\n')[0]` kept ONLY that first line and threw away everything after it,
 * discarding the real error on EVERY mechanical-pass failure this runner has ever logged, not just that one.
 * The one line `runner.log` actually recorded that night — `⚠ mechanical pass conveyor/session-reaper.mjs
 * failed (non-fatal): Command failed: node .../session-reaper.mjs` — carries zero information about WHY;
 * reproducing the exact same truncation against a real `execFileSync` throw (a child that `console.error`s
 * detail then exits 1) confirmed this is the whole gap, byte for byte. Collapses whitespace/newlines so a
 * multi-line stderr still logs as ONE `runner.log` line (grep-able, matching the file's existing one-line-per-
 * event convention), bounded to `maxChars` rather than left unbounded.
 * @param {unknown} e
 * @param {number} [maxChars]
 * @returns {string}
 */
export function summarizeMechanicalPassError(e, maxChars = MECHANICAL_PASS_ERROR_LOG_CHARS) {
  const full = String((e && e.message) || e);
  return full.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * Every mechanical pass this runner ticks, as the STABLE name `--skip-pass=<name>` (repeatable, see
 * `parseFlags`/`main()`) accepts — either the name the pass already logs (`warn(path, key, e)`'s `key`
 * doubles as a repo-scope tag, not this) or its script's basename without `.mjs`. `'reconcile-pass'` names
 * the WHOLE reconcile-pass → review-dispatch → review-round-tag/review-status-tag sequence (they run as one
 * group below, exactly the sequence `skills-src/conveyor/review-daemon.mjs` now runs standalone) — skipping
 * it skips all four steps together, never a partial slice of the group. `'hiccup-sink'` is the one pass with
 * no standalone `node <script>` invocation (a dynamic import, not `exec`), included here for completeness
 * since it is still one of the runner's mechanical passes and a real skip target.
 *
 * WHY A FIXED LIST (not derived from the call sites at runtime): an unknown `--skip-pass` name must refuse
 * the runner from starting at all (typo safety — a mistyped name must never silently no-op instead of
 * skipping the pass the operator meant), and doing that BEFORE the first tick needs a name list that exists
 * independent of ever calling {@link makeCliMechanicalPasses}.
 */
export const MECHANICAL_PASS_NAMES = Object.freeze([
  'infra-blocked',
  'lease-reaper',
  'session-reaper',
  'branch-drift',
  'lane-pool-health-watch',
  'operator-notify',
  'reconcile-fix-dispatch',
  'ci-queue-watch',
  'parked-pr-conflict-watch',
  'advisory-label-sweep',
  'review-hold-reconcile',
  'reconcile-pass',
  'duplicate-pr-watch',
  'parked-pr-progress-watch',
  'hiccup-sink',
]);

export function makeCliMechanicalPasses({
  scriptsDir, repo = null, hiccupSession, exec = execFileSync,
  fetchOpenPrs = defaultFetchOpenPrs, repos = CONSTELLATION_REPOS,
  unsupportedPath, skipPasses = new Set(),
} = {}) {
  const skip = (name) => skipPasses.has(name);
  return async ({ out } = {}) => {
    const warn = (path, key, e) => process.stderr.write(
      `⚠ mechanical pass ${path} [${key}] failed (non-fatal): ${summarizeMechanicalPassError(e)}\n`,
    );
    const run = (path, args, key, slug, capture = false) => {
      try {
        return { ok: true, output: exec('node', [join(scriptsDir, path), ...args, ...(slug ? [`--repo=${slug}`] : [])], {
          encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024,
        }) };
      } catch (error) {
        warn(path, key, error);
        return { ok: false, error };
      }
    };
    // WE-only: retries WE backlog infrastructure holds.
    if (!skip('infra-blocked')) run('conveyor/infra-blocked.mjs', ['retry'], 'we', repo);
    // WE-only: reaps the WE delivery pool's leases.
    if (!skip('lease-reaper')) run('conveyor/lease-reaper.mjs', [], 'we', repo);
    // WE-only invocation: session ground truth already resolves repo-aware slugs.
    if (!skip('session-reaper')) run('conveyor/session-reaper.mjs', [], 'we', repo);
    // WE-only: monitors the WE mechanical-dispatcher branch.
    if (!skip('branch-drift')) run('conveyor/branch-drift.mjs', ['sweep'], 'we', repo);
    // WE-only: cleans litter in the WE lane pool. Already runs as its own pass-daemon watcher
    // (skills-src/conveyor/pass-daemon.mjs) — a resident Dispatcher must skip this to avoid double-running it.
    if (!skip('lane-pool-health-watch')) run('conveyor/lane-pool-health-watch.mjs', [], 'we', repo);
    // Repo-agnostic: notifies from one cross-repo operator queue and ignores --repo, so run once.
    // Mechanical, no model: the only push to the operator after the advisory sweep.
    if (!skip('operator-notify')) run('operations/operator-notify.mjs', ['--once'], 'we', repo);
    // pr-watch is armed by tick-core for item-keyed conveyor builds/prepares in WE only.
    const explicitKey = repo === null ? null : repoKeyForSlug(repo);
    const selected = repo === null ? Object.entries(repos)
      : explicitKey && repos[explicitKey] ? [[explicitKey, repos[explicitKey]]] : [];
    if (repo !== null && !selected.length) {
      process.stderr.write(`⚠ unsupported-repo: ${repo} is not a constellation repo; skipping PR-facing passes\n`);
    }
    let duplicateRan = false;
    for (const [key, { slug }] of selected) {
      let prsFile = null;
      try {
        let prsArgs = [];
        try {
          const prs = fetchOpenPrs({ repo: slug });
          prsFile = join(tmpdir(), `conveyor-open-prs-${randomUUID()}.json`);
          writeFileSync(prsFile, JSON.stringify(prs), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          prsArgs = [`--prs-file=${prsFile}`];
        } catch (e) { warn('open-pr-fetch', key, e); }
        if (!skip('reconcile-fix-dispatch')) run('conveyor/reconcile-fix-dispatch.mjs', prsArgs, key, slug);
        if (!skip('ci-queue-watch')) run('conveyor/ci-queue-watch.mjs', ['sweep'], key, slug);
        // Already runs as its own pass-daemon watcher (skills-src/conveyor/pass-daemon.mjs) — a resident
        // Dispatcher must skip this to avoid double-running it.
        if (!skip('parked-pr-conflict-watch')) run('conveyor/parked-pr-conflict-watch.mjs', ['sweep', ...prsArgs], key, slug);
        if (!skip('advisory-label-sweep')) run('conveyor/advisory-label-sweep.mjs', ['sweep', ...prsArgs], key, slug);
        // #x01u7az — the one-time-and-ongoing cleanup for the two review-hold/advisory strays
        // `we:scripts/review-set-label.mjs#decideSetLabel`'s `rearm`/`clear-human` fix stops PRODUCING going
        // forward (a stray review:pending beside a live review:human; a stray advisory:* once review:human is
        // gone) — see that module's own header for the live PRs (#2549, #2578) this cleans up. Piggybacks on the
        // SAME shared open-PR snapshot as its sibling sweep, one line above.
        if (!skip('review-hold-reconcile')) run('conveyor/review-hold-reconcile.mjs', ['sweep', ...prsArgs], key, slug);
        // GROUP (skipped as ONE unit): reconcile-pass → review-dispatch (per PR) → review-round-tag /
        // review-status-tag — the exact sequence skills-src/conveyor/review-daemon.mjs now runs standalone,
        // per PR (#3876). A resident Dispatcher must skip 'reconcile-pass' whole to avoid duplicating it.
        if (!skip('reconcile-pass')) {
          const result = run('conveyor/reconcile-pass.mjs', ['--json', ...prsArgs], key, slug, true);
          if (result.ok) {
            try {
              const plan = JSON.parse(result.output);
              const reviews = (plan.dispatch ?? []).filter((d) => d?.kind === 'review');
              // Live-caught 2026-09-22, #xli631k: a PR owed a FIX (not a review) never reached
              // selectStatusCandidates at all, so its review-status:* label could go stale indefinitely once
              // its review session finished. Same fix as we:skills-src/conveyor/review-daemon.mjs's own.
              const fixes = (plan.dispatch ?? []).filter((d) => d?.kind === 'fix');
              const unsupported = [];
              for (const d of reviews) {
                const dispatched = run('operations/review-dispatch.mjs', [`--pr=${d.prNumber}`], key, slug);
                if (!dispatched.ok) {
                  const why = String(dispatched.error.stderr || dispatched.error.message || dispatched.error).trim().replace(/\s+/g, ' ');
                  if (key !== 'we' && why.includes('unsupported-repo')) {
                    unsupported.push({ kind: 'unsupported-repo', repo: key, prNumber: d.prNumber, action: 'review', why });
                  }
                  continue;
                }
                run('conveyor/review-round-tag.mjs', [String(d.prNumber), `--round=${(d.attempts ?? 0) + 1}`], key, slug);
              }
              for (const c of selectStatusCandidates(reviews, plan.refusals, fixes)) {
                run('conveyor/review-status-tag.mjs', [String(c.prNumber)], key, slug);
              }
              if (key !== 'we') {
                // Each producer replaces its own actions, preserving the sibling producer's refusals.
                const fixes = readUnsupported({ path: unsupportedPath }).filter((r) => r.repo === key && r.action !== 'review');
                recordUnsupported({ repo: key, rows: [...fixes, ...unsupported], path: unsupportedPath });
              }
            } catch (e) { warn('review-reconcile', key, e); }
          }
        }
        // WE-only: duplicate item numbers refer to WE backlog ids, not cross-repo deliveries.
        if (!skip('duplicate-pr-watch') && (key === 'we' || repo !== null)) {
          run('conveyor/duplicate-pr-watch.mjs', ['sweep', ...prsArgs], 'we', repo);
          duplicateRan = true;
        }
        if (!skip('parked-pr-progress-watch')) run('conveyor/parked-pr-progress-watch.mjs', ['sweep', ...prsArgs], key, slug);
      } finally {
        if (prsFile) { try { unlinkSync(prsFile); } catch { /* best-effort cleanup */ } }
      }
    }
    if (!duplicateRan && !skip('duplicate-pr-watch')) run('conveyor/duplicate-pr-watch.mjs', ['sweep'], 'we', repo);
    // WE-only: hiccups describe suppressed item-keyed WE builds.
    if (!skip('hiccup-sink')) {
      try {
        // Literal relative specifiers (not scriptsDir-joined) — a computed dynamic-import argument trips
        // Vite/Rollup's SSR import analysis (used to transform this file under vitest); a string literal is
        // what every bundler's static import graph expects. runner.mjs lives in skills-src/conveyor/, these
        // two in scripts/conveyor/ — the SAME relative hop TICK_CORE itself resolves via SCRIPTS_DIR above.
        const { classifySuppressedBuilds } = await import('../../scripts/conveyor/hiccup-classify.mjs');
        const { fileHiccups } = await import('../../scripts/conveyor/hiccup-sink.mjs');
        const suppressed = out && out.decisions && out.decisions.suppressedBuilds;
        const hiccups = classifySuppressedBuilds(suppressed);
        if (hiccups.length) fileHiccups(hiccups, { session: hiccupSession });
      } catch (e) {
        process.stderr.write(`⚠ mechanical pass hiccup-sink [we] failed (non-fatal): ${String(e.message || e).split('\n')[0]}\n`);
      }
    }
  };
}

/** The durable EXTERNAL status file's filename, under `.conveyor/` in the driven checkout — the same
 *  session-local, gitignored sidecar convention every other `.conveyor/*.json` state file in this repo uses
 *  (`queue.json`, `dispatch-pause.json`, …). See {@link writeDriverStatus}. */
export const DRIVER_STATUS_FILENAME = 'driver-status.json';

/**
 * Write the tick's surface to a durable file OUTSIDE the runner's own stdout, so "is the driver stuck?" is
 * answerable from a SEPARATE process (a human, another agent, `scripts/conveyor/driver-status.mjs`) without
 * grepping `runner.log` or waiting on a notification (2026-09-14, #3521/lane-2 incident — the driver ran for
 * 85+ minutes with its only record of the stall sitting in a log nobody was polling). Overwritten every tick;
 * atomic (temp file + rename) so a concurrent reader never observes a half-written file. Best-effort — a write
 * failure (e.g. a read-only checkout) is swallowed: the status file is a CONVENIENCE, never something the tick
 * loop itself depends on to keep running.
 * @param {string} path  the resolved `.conveyor/driver-status.json` path.
 * @param {{tick:number}} ctx
 * @param {object} surface  this tick's {@link tickSurface} projection.
 */
export function writeDriverStatus(path, ctx, surface) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify(
      {
        tick: ctx.tick,
        at: new Date().toISOString(),
        statusLine: surface.statusLine || '',
        stalled: Array.isArray(surface.stalled) ? surface.stalled : [],
        dispatch: surface.dispatch,
      },
      null,
      2,
    ) + '\n';
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (e) {
    process.stderr.write(`⚠ driver-status write failed (non-fatal): ${String(e.message || e).split('\n')[0]}\n`);
  }
}

/**
 * Append this tick's plain-language decision trace (see `buildDecisionTrace` / `tick-core.mjs`) to a durable,
 * DAY-SHARDED JSONL sidecar — `<traceDir>/<YYYY-MM-DD>.jsonl`, ONE line per trace entry, mirroring the existing
 * `.operations/telemetry/<date>.jsonl` day-sharding convention already in this repo so the trace's own growth is
 * naturally bounded to a day's worth of ticks per file instead of one ever-growing log. A DELIBERATELY SEPARATE
 * sidecar rather than piggybacking on `.operations/telemetry/` (2026-09-14): that store has an active
 * test-pollution/fragmentation fix in flight elsewhere at the time this was built, so writing into it here would
 * risk colliding with that in-progress change; once it lands, folding this trace into the shared store is the
 * natural next step (this file's whole schema is a flat, appendable line — nothing here depends on a private
 * format). Best-effort, same as {@link writeDriverStatus} — a write failure never gates the tick.
 * @param {string} traceDir  the resolved `.conveyor/decision-trace/` directory.
 * @param {{tick:number}} ctx
 * @param {Array<object>} entries  this tick's `surface.decisionTrace`.
 */
export function appendDecisionTrace(traceDir, ctx, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    mkdirSync(traceDir, { recursive: true });
    const at = new Date();
    // #2747 — the day-shard is the OPERATOR's calendar day (`localDateString`), not the runtime's UTC day.
    const day = localDateString(at);
    const lines = entries.map((e) => JSON.stringify({ tick: ctx.tick, at: at.toISOString(), ...e })).join('\n') + '\n';
    appendFileSync(join(traceDir, `${day}.jsonl`), lines);
  } catch (e) {
    process.stderr.write(`⚠ decision-trace write failed (non-fatal): ${String(e.message || e).split('\n')[0]}\n`);
  }
}

/** Build the real `emit` effect: print the tick's status line + notes, and the dispatch/watch decisions the
 *  judgment layer executes (the runner spends no model context, so it surfaces them — #2701 clause 3). Also
 *  writes the durable external status file every tick (see {@link writeDriverStatus}) and appends the tick's
 *  decision trace (see {@link appendDecisionTrace}), both regardless of `json`. */
function makeCliEmit({ json = false, statusPath = null, traceDir = null } = {}) {
  return (surface, ctx) => {
    if (statusPath) writeDriverStatus(statusPath, ctx, surface);
    if (traceDir) appendDecisionTrace(traceDir, ctx, surface.decisionTrace);
    if (json) { process.stdout.write(JSON.stringify({ tick: ctx.tick, ...surface }) + '\n'); return; }
    const { dispatch } = surface;
    const counts = `${dispatch.builds.length} build · ${dispatch.prepareScope.length + dispatch.prepareDecision.length} prepare · ${dispatch.fixes.length} fix · ${dispatch.ciHeals.length} heal · ${surface.armWatchers.length} watch`;
    process.stdout.write(`[tick ${ctx.tick}] ${surface.statusLine || '(no status)'}\n`);
    if (dispatch.builds.length || dispatch.prepareScope.length || dispatch.prepareDecision.length || dispatch.fixes.length || dispatch.ciHeals.length || surface.armWatchers.length) {
      process.stdout.write(`  ↳ surface for judgment layer: ${counts}\n`);
    }
    for (const n of surface.notes) process.stdout.write(`  ${n.text || JSON.stringify(n)}\n`);
  };
}

/** The one flag `parseFlags` accumulates into an ARRAY rather than overwriting (every other flag is
 *  last-wins) — `--skip-pass=<name>` is documented as repeatable, so a second occurrence must ADD, not
 *  replace, the first. */
const REPEATABLE_FLAGS = new Set(['skip-pass']);

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const value = eq === -1 ? true : a.slice(eq + 1);
    if (REPEATABLE_FLAGS.has(name)) {
      if (!Array.isArray(flags[name])) flags[name] = [];
      flags[name].push(value);
    } else {
      flags[name] = value;
    }
  }
  return flags;
}

/** Coerce a flag value to a finite number, falling back when it is absent / bare (`true`) / non-numeric —
 *  so `--max-ticks=abc` can never silently become `NaN` (which would never trip the max-ticks stop). */
function finiteOr(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the parsed `--skip-pass` flag(s) (a string, an array from repeated flags, or absent) against the
 * known {@link MECHANICAL_PASS_NAMES} — PURE, so the typo-safety refusal is unit-testable with no CLI/process
 * involved. Any name outside the known list makes the WHOLE result invalid (`ok:false`) — a single typo must
 * refuse the runner's start, not silently skip nothing / skip everything else.
 * @param {string|string[]|undefined} flagValue
 * @param {{names?: readonly string[]}} [o]
 * @returns {{ok:true, skipPasses:Set<string>}|{ok:false, unknown:string[]}}
 */
export function resolveSkipPasses(flagValue, { names = MECHANICAL_PASS_NAMES } = {}) {
  const requested = Array.isArray(flagValue) ? flagValue : (flagValue === undefined ? [] : [flagValue]);
  const known = new Set(names);
  const unknown = requested.filter((n) => typeof n !== 'string' || !known.has(n));
  if (unknown.length) return { ok: false, unknown: [...new Set(unknown.map((n) => String(n)))] };
  return { ok: true, skipPasses: new Set(requested) };
}

/**
 * Acquire the singleton lease, drive the loop, and ALWAYS release the lease — the lifecycle wrapper, kept
 * SEPARATE from `main()` so it is unit-testable without `process.exit` (which does NOT unwind a `finally`, so
 * the release MUST NOT sit behind an exit). A held lease returns `{ started: false }` so the caller stands
 * down; otherwise the lease is released in the `finally` before the caller exits. The lease heartbeat is wired
 * IN here (over the injected `heartbeat`), so the loop's lease-loss stop reflects the real singleton right.
 * @returns {Promise<{ started: boolean, reason?: string, heldBy?: string|null, ticks?: number, stoppedReason?: string }>}
 */
/**
 * Wire a real `tickOnce` through the two per-tick daemon primitives a resident Dispatcher now needs, in
 * order: SELF-SYNC first (only when opted in — see below; {@link withSelfSync} — fetch + merge `origin/main`; a merge PRE-EMPTS the tick with
 * a restart instead of ticking on stale code), then the GitHub App TOKEN REFRESH
 * ({@link withGithubAppAuth} — opt-in via `WE_GITHUB_APP_*` env vars, a no-op otherwise), then the real tick.
 * This is the exact ordering `skills-src/conveyor/review-daemon.mjs`'s own `main()` already composes
 * (`withSelfSync(withGithubAppAuth(effects), {...})` — the OUTERMOST wrapper runs FIRST). Both wrappers
 * forward whatever arguments their wrapped `tickOnce` takes (see each module's own header), so the runner's
 * per-tick bookkeeping payload (threaded tick-to-tick via {@link carryForward}) still reaches the real
 * `tickOnce` unchanged — this function adds no IO of its own, only the composition.
 *
 * SELF-SYNC IS OPT-IN (`selfSync: true`, default OFF). Self-sync MUTATES the checkout (`git merge
 * origin/main`, then a restart) and is only safe in a DEDICATED unattended clone nobody else touches — the
 * precondition `daemon-self-sync.mjs` was designed around. runner.mjs is ALSO run interactively from the
 * operator's own live checkout (the /conveyor skill's documented flow), where an unasked-for merge commit or
 * a mid-session `process.exit(0)` is wrong. So unless the caller explicitly asserts "this is the dedicated
 * clone" (the CLI's `--self-sync` flag, which the staged launchd plist passes), only the App-token refresh
 * wraps the tick and no git mutation ever happens.
 * @param {{tickOnce:Function, root:string, onRestart:Function, authOpts?:object, sync?:Function, selfSync?:boolean, gate?:Function}} o
 *   `sync` is forwarded to {@link withSelfSync} (defaults to the real `selfSyncCheckout`) — exposed so a test
 *   can simulate "new commits arrived" without a real git checkout. `selfSync` must be exactly `true` to wire
 *   the self-sync wrapper at all. `gate` is likewise forwarded (#3383's live-smoke gate — defaults to the
 *   real `gateMergedCommit`) — exposed for the same reason `sync` is: a test that injects a merge without a
 *   real lane-pool/gh/reconcile-pass-shaped `root` needs to inject a passing gate too, or the (correct,
 *   unconditional-by-design) live smoke would reject that synthetic merge as it would any other broken one.
 * @returns {Function} the wrapped `tickOnce` effect, same call signature as the one passed in.
 */
export function wireSelfSyncAndAppAuth({ tickOnce, root, onRestart, authOpts, sync, selfSync = false, gate }) {
  const authed = withGithubAppAuth({ tickOnce }, authOpts);
  if (selfSync !== true) return authed.tickOnce;
  const selfSyncOpts = { root, onRestart, ...(sync ? { sync } : {}), ...(gate ? { gate } : {}) };
  return withSelfSync(authed, selfSyncOpts).tickOnce;
}

export async function driveConveyor({
  lockRoot = RUNNER_LOCK_ROOT,
  owner = runnerOwner(),
  buildEffects,
  acquire = acquireRunnerLease,
  heartbeat = heartbeatRunnerLease,
  release = releaseRunnerLeaseIfOwned,
} = {}) {
  if (typeof buildEffects !== 'function') throw new TypeError('driveConveyor requires a buildEffects factory');
  const acq = acquire(lockRoot, owner);
  if (!acq.ok) return { started: false, reason: acq.reason || 'held', heldBy: acq.heldBy ?? null };
  try {
    const effects = { ...buildEffects(owner), heartbeat: () => heartbeat(lockRoot, owner) };
    const result = await runLoop(effects);
    return { started: true, ticks: result.ticks, stoppedReason: result.stoppedReason };
  } finally {
    // Release BEFORE the caller exits — never behind a `process.exit` (which would skip it and leak the lease
    // for the full TTL, falsely standing down every launch inside that window). This is the drain daemon's
    // release-then-exit ordering (we:scripts/lane-drain.mjs), not a finally-after-exit.
    release(lockRoot, owner);
  }
}

async function main(argv) {
  const flags = parseFlags(argv);

  const HERE = dirname(fileURLToPath(import.meta.url));
  // Runner lives in skills-src/conveyor/; the tick core + the deterministic passes live in scripts/.
  const SCRIPTS_DIR = join(HERE, '..', '..', 'scripts');
  const TICK_CORE = join(SCRIPTS_DIR, 'conveyor', 'tick-core.mjs');
  // The checked-out repo root this runner is driving — resolved by SCRIPT LOCATION (never CWD), the same
  // convention `queue-scope.mjs` documents for its own sidecar, so a child process's own cwd can never point
  // the status file / trace dir at a different checkout than the one actually running.
  const REPO_ROOT = join(HERE, '..', '..');
  const STATUS_PATH = join(REPO_ROOT, '.conveyor', DRIVER_STATUS_FILENAME);
  const TRACE_DIR = join(REPO_ROOT, '.conveyor', 'decision-trace');

  const repo = typeof flags.repo === 'string' ? flags.repo : null;
  const json = !!flags.json;
  const intervalMs = finiteOr(flags['interval-ms'], DEFAULT_TICK_INTERVAL_MS);
  const maxTicks = flags.once ? 1 : finiteOr(flags['max-ticks'], Infinity);

  // --skip-pass=<name> (repeatable) — a resident daemon launch names the mechanical passes that ALREADY run
  // as their own standalone daemon/watcher (reconcile-fix-dispatch, the reconcile-pass→review-dispatch group,
  // parked-pr-conflict-watch, lane-pool-health-watch — see MECHANICAL_PASS_NAMES's own header), so this
  // runner never duplicates their dispatch. An unknown name refuses the runner from starting (typo safety) —
  // it never silently skips zero passes.
  const skipResolution = resolveSkipPasses(flags['skip-pass']);
  if (!skipResolution.ok) {
    process.stderr.write(`✗ unknown --skip-pass name(s): ${skipResolution.unknown.join(', ')}. Valid pass names: ${MECHANICAL_PASS_NAMES.join(', ')}\n`);
    process.exit(1);
    return;
  }
  const { skipPasses } = skipResolution;
  if (skipPasses.size) process.stderr.write(`conveyor runner: skipping mechanical pass(es): ${[...skipPasses].join(', ')}\n`);

  // --self-sync — the explicit opt-in asserting "this runner is in its own DEDICATED unattended clone" (the
  // staged launchd plist passes it). Without it the runner NEVER fetches/merges `origin/main` into the
  // checkout it runs from — an interactive launch from the operator's live checkout stays untouched.
  // Bare flag only: `--self-sync=true` would otherwise parse as the STRING 'true' and silently leave it OFF.
  if (flags['self-sync'] !== undefined && flags['self-sync'] !== true) {
    process.stderr.write(`✗ --self-sync takes no value (got --self-sync=${flags['self-sync']}); pass the bare flag to opt in, or omit it.\n`);
    process.exit(1);
    return;
  }
  const selfSync = flags['self-sync'] === true;
  if (selfSync) process.stderr.write(`conveyor runner: self-sync ON — will merge origin/main into ${REPO_ROOT} between ticks (dedicated clone only)\n`);

  const hiccupSession = typeof flags['hiccup-session'] === 'string' ? flags['hiccup-session'] : undefined;
  const buildEffects = (owner) => {
    const restartOntoNewCode = () => {
      // Between ticks only (never mid-dispatch): release the singleton lease ourselves — `process.exit`
      // never unwinds `driveConveyor`'s own `finally` release, so skipping this would leak the lease for its
      // full TTL. launchd's KeepAlive then relaunches onto the merged code (see daemon-self-sync.mjs header).
      releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner);
      process.exit(0);
    };
    return {
      tickOnce: wireSelfSyncAndAppAuth({
        tickOnce: makeCliTickOnce({ tickCorePath: TICK_CORE, repo }),
        root: REPO_ROOT,
        onRestart: restartOntoNewCode,
        selfSync,
      }),
      emit: makeCliEmit({ json, statusPath: STATUS_PATH, traceDir: TRACE_DIR }),
      mechanicalPasses: makeCliMechanicalPasses({ scriptsDir: SCRIPTS_DIR, repo, hiccupSession, skipPasses }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      intervalMs,
      maxTicks,
      initial: {},
    };
  };

  // #2702 SINGLETON LOCK — `driveConveyor` acquires the sole-driver right, runs the loop, and ALWAYS releases
  // the lease (in its `finally`, before we exit). A LIVE runner already driving ⇒ `started:false`, a polite
  // stand-down (exit 0, not an error).
  const outcome = await driveConveyor({ owner: runnerOwner(), buildEffects });
  if (!outcome.started) {
    process.stderr.write(`✗ another conveyor runner holds the singleton lease (heldBy=${outcome.heldBy}); standing down.\n`);
  } else {
    process.stderr.write(`conveyor runner stopped: ${outcome.stoppedReason} after ${outcome.ticks} tick(s).\n`);
  }
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`✗ runner error: ${String(e && e.stack || e)}\n`); process.exit(1); });
}
