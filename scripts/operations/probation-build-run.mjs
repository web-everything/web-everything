#!/usr/bin/env node
import { resolveOperationRoute, resolvePolicyModel, readRoutingPolicy } from '../lib/dispatch-routing-policy-io.mjs';
import { parseAgyReportEvidence } from '../lib/antigravity-run-evidence.mjs';
import { machinePrTitle } from './machine-pr-title.mjs';
import { classifyPrepareFailure } from '../conveyor/prepare-failure-policy.mjs';
/**
 * @file scripts/operations/probation-build-run.mjs
 * @description THE PROBATION BUILD RUN (agy-launcher-probation, #4291) — the detached per-dispatch
 *   process `dispatch-providers/probation-worker.mjs` starts for doc-fix builds. Also runs directly from
 *   the operator CLI for one non-critical doc-fix or bugfix item.
 *   PR #2819 opened the model-probation gate and started RECORDING a doc-fix pick; this script is what actually
 *   LAUNCHES it, the doc-fix sibling of `we:scripts/operations/probation-heal-run.mjs` (`ci-heal`). It follows
 *   the same arc as a normal mechanical `build` dispatch (claim, build, gate, resolve, PR), with the SCRIPT
 *   doing every script-decidable step and the probation worker (Codex / Antigravity-Claude) doing only the
 *   writing itself:
 *
 *     1. claim the item in the lane (`we:scripts/backlog.mjs claim`);
 *     2. run the worker SYNCHRONOUSLY through its launcher (`gemini-direct-task.mjs` / `codex-direct-task.mjs`,
 *        both foreground-blocking by design) against the item's own spec text;
 *     No-change runs first reuse the hold router's already-done classifier and citation-checked landing.
 *     Otherwise route worker-declined: attach Findings, remove scope for preparation, and land only
 *     the card through the same verified, parked PR path (never resolve a decline).
 *     3. bound the build diff to the selected taskType's envelope (`we:scripts/lib/provider-routing.mjs#PROVEN_TASK_ENVELOPES`);
 *     4. resolve the item (`we:scripts/operations/run.mjs resolve`) and commit everything — the worker's files
 *        plus the item's own now-resolved backlog card — in ONE commit, trailers naming the worker;
 *     5. run the gate on the FINAL commit (the default, marker-writing `verify-lane` mode, not the marker-less
 *        `run` mode `probation-heal-run.mjs` uses — this script needs a fresh marker for `open-pr
 *        --requireVerified=true` below, which a heal never calls);
 *     6. open the PR through the canonical producer (`we:scripts/operations/run.mjs open-pr`), PARKED
 *        `review:pending` — never `ready-to-merge` — because a probation launch always "owes a run rating"
 *        (`selectProbationWorker`'s own docblock): promotion out of probation is an explicit human decision,
 *        never automatic, and that starts with every probation PR getting a real look;
 *     7. append one `probation-launch` scorecard row whenever the worker actually ran (an item that could not
 *        even be claimed writes no row — it is not a trial of the worker).
 *
 * UNLIKE `probation-heal-run.mjs`, this script CLAIMS and RESOLVES a backlog item (a heal repairs an existing
 * PR's CI and touches no item state at all), and it OPENS a brand-new PR rather than pushing to one that
 * already exists.
 *
 * HOW A FAILED ATTEMPT UNDOES ITSELF (agy-launcher-probation, #4291 plan review). Nothing is ever pushed until
 * `open-pr` succeeds, so — up to that point — every mutation this script makes (the claim's `active` stamp, the
 * worker's diff, the resolve's `resolved` stamp, even a commit already made) lives ONLY in this lane's own
 * working tree/history, never visible to `main` or any other dispatch. A single `git reset --hard` back to
 * {@link baseSha} (captured right after the claim, before this script's own commit ever exists) therefore undoes
 * ALL of it in one step — the claim included. This is deliberately NOT `we:scripts/backlog.mjs release`: by the
 * time a late failure (a red final gate) is detected, the on-disk item file already reads `resolved` (inside
 * the commit this script just made), and `release` only transitions `active`/`preparing` → `open` — calling it
 * against a `resolved` file (or, after the reset already ran, an already-pristine `open` file) refuses. Relying
 * on the git-level undo instead of the CLI verb sidesteps that mismatch entirely and is exactly as correct: the
 * canonical item was NEVER anything but `open` throughout a failed attempt, because nothing left the lane.
 *
 * TWO try/catches, split exactly at the gate (`runProbationBuild` below), so an unexpected thrown error — not
 * just an explicit `ok:false` — is always handled, but never handled the SAME way on both sides of it. Every
 * step up to and including the gate is inside the first: any thrown error there resets the lane (`abandon`),
 * same as an explicit check failing. `writePrBody`/`openPr` run inside a SECOND, inner try/catch instead: by
 * the time they run the commit is gate-GREEN, and a throw there reports `escalated-needs-human` and leaves the
 * built commit in the lane, never resetting it — exactly like the `submitted.ok === false` case already
 * handled explicitly beside it.
 *
 * NEVER merges, never touches `main` directly (the PR opens `review:pending`, and the resident drain daemon
 * lands it once a human clears the review), never releases the LANE on success (the lease ages out, matching
 * every other conveyor delivery arc's own EXIT step) or on failure (matching `probation-heal-run.mjs`, which
 * never releases the lane either — the lease reaper reclaims it).
 *
 * Operator CLI: --num=<item> --taskType=doc-fix|bugfix|test-fix|prepare --worker=<roster id|JSON> [--model=<allowed id>].
 * Omitted taskType remains doc-fix; omitted session gets a random per-run identity. Worker names resolve
 * from PROBATION_WORKERS (agy Claude defaults to Sonnet). Flash is for simple mechanical work and requires
 * a read-only Codex APPROVE. No enclosing Claude session is started.
 *
 * IO lives in the `io` object so the whole arc is testable with fakes; the CLI block at the bottom wires the
 * real processes.
 */

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { summarizeAgyEvents } from '../gemini-direct-task.mjs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { readField, removeFrontmatterField } from '../backlog/frontmatter.mjs';
import { parseCard } from '../lib/priority-order.mjs';
import { appendScorecard as appendScorecardRow } from '../conveyor/run-scorecard-store.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { hookSurfaceChanged, resetHookSurface, snapshotHookSurface, withHooksDisabled } from '../lib/git-hook-surface.mjs';
import { AGY_CLAUDE_MODEL_BY_TIER, PROBATION_WORKERS, PROVEN_TASK_ENVELOPES, isStatuteTierPath } from '../lib/provider-routing.mjs';
import { isDocScopePath } from '../lib/dispatch-task-type.mjs';
import {
  buildCheckerArgv, parseCheckerVerdict, buildDocFixCommitMessage, buildDocFixTask, buildWorkerArgv, frontmatterTamperedBeyondClaim, PREPARE_OWNED_FRONTMATTER_KEYS,
  BACKLOG_ID_SOURCE, parseProposedBlockedBy, validateProposedBlockedBy,
  healDiffWithinEnvelope, launchScorecardRow, newUntrackedPaths, summarizeNumstat,
} from '../lib/probation-launcher.mjs';
import { defaultPoolRoot, workspaceFor } from '../lib/lane-pool-paths.mjs';
import { HOLD_SESSION_ENV, HOLD_DISPATCH_KIND_ENV, HOLD_RUN_ID_ENV } from '../readiness/heavy-admission.mjs';
import { daemonCloneRoots, isDaemonCloneRealpath } from '../lib/daemon-clone-registry.mjs';
import { placeBuildDispatchHold } from '../conveyor/build-dispatch-claim.mjs';
import { planHoldRouting, reserveHoldRoute } from '../conveyor/build-dispatch-hold-router.mjs';
import { clearScopeAndAppendFinding, sanitizeHoldReason, landRoute } from './build-dispatch-hold-route-land.mjs';
import { classifyPrepareReport, deriveScopeFromCard, isSafeRepoRelativePath, needsYouReason, replaceCardScope, scopeIsDefective } from '../conveyor/prepare-outcome.mjs';
import { extractSubmitResult } from './open-pr.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

import { settleDispatchEffect } from './deliver-item-settle.mjs';
import { prepareCardStatus } from '../conveyor/prepare-result.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Read-only launch checkout and pool reference — by script location, never cwd. */
export const WE_ROOT = resolve(HERE, '..', '..');
const REPO_SLUG = CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug;
const GATE_TIMEOUT_MS = 20 * 60 * 1000;
/** Build modes call plain `claim`/`resolve`; prepare mode uses its separate two-key allowlist below.
 *  Build modes never call `prepare-stamp` or `resolve` with
 *  `--graduated-to=`/`--codified-to=` — so its own frontmatter-tamper checks allow only what THOSE two calls
 *  can legitimately produce (#4291 plan-review finding, round 8; see `frontmatterTamperedBeyondClaim`'s own
 *  docblock for why this must be narrower than the shared default). */
const BUILD_OWNED_FRONTMATTER_KEYS = Object.freeze(['status', 'dateStarted', 'dateResolved']);

/**
 * The item's own declared `scope:`, repo-prefix stripped. PURE. #4291 plan review, round 7 — this IS the
 * allowlist a doc-fix worker's touched paths are checked against; an empty result means the item declared no
 * scope, which the arc refuses to build against at all (see the "no declared scope" refusal) rather than
 * falling back to an ever-incomplete denylist (rounds 4-6's own history: statute, then `CLAUDE.md`/
 * `AGENTS.md`, then `GEMINI.md` — a denylist never runs out of paths it forgot).
 * @param {string[]} scope
 * @returns {string[]}
 */
function declaredScopePaths(scope) {
  return (scope || [])
    .map(String)
    // #4291 plan-review finding (security, round 10) — a doc-fix item's scope CAN name another repo
    // (`frontierui:docs/x.md`), because this launcher runs whole-item scope through, not a WE-only filtered
    // copy of it. Blindly stripping ANY `<repo>:` prefix would let a `frontierui:docs/a.md` entry allowlist a
    // same-named `docs/a.md` in THIS (WE) lane that was never actually declared for WE. Keep only bare paths
    // and explicit `we:` entries — this launcher (`probationLaunchDecision`'s own `repo === 'we'` gate) only
    // ever builds in the WE lane, so a foreign-repo entry is simply not an allowlist member here.
    .filter((p) => !/^[a-z][\w-]*:/.test(p) || p.startsWith('we:'))
    .map((p) => p.replace(/^we:/, ''));
}

/**
 * Does `path` fall inside `scopeEntries` (from {@link declaredScopePaths})? PURE. #4291 plan-review finding
 * (correctness, round 9) — a scope entry ending in `/` is a DIRECTORY prefix (every path under it counts,
 * mirroring `we:scripts/lib/dispatch-task-type.mjs#isDocScopePath`'s own `DOC_PATH_PREFIXES` convention); any
 * other entry is an exact file path, except for narrow sibling test globs. Without this, an item scoped to a directory (a legitimate, ordinary
 * `scope:` shape) would have EVERY file the worker touches rejected as "out of scope" — after the worker
 * already spent its full synchronous run finding that out.
 * @param {string} path
 * @param {string[]} scopeEntries
 * @returns {boolean}
 */
function pathInScope(path, scopeEntries) {
  return scopeEntries.some((entry) => {
    // Only the prepare-owned test glob is supported; '*' never spans a directory.
    const pattern = /^((?:.*\/)?__tests__\/[^/*]+)\*(\.test\.[cm]?[jt]sx?)$/.exec(entry);
    if (pattern) return dirname(path) === dirname(entry) && path.startsWith(pattern[1]) && path.endsWith(pattern[2]);
    return entry.endsWith('/') ? path.startsWith(entry) : path === entry;
  });
}

/** Exact source entries own sibling __tests__ files, never arbitrary helpers or subdirectories. */
function sourceTestPattern(source) {
  if (!/\.[cm]?[jt]sx?$/.test(source) || /(?:\.test\.|\.spec\.|\*|(?:^|\/)__tests__\/)/.test(source)) return null;
  const extension = extname(source);
  return join(dirname(source), '__tests__', `${basename(source, extension)}*.test${extension}`);
}

function ownedTest(path, entries) {
  return entries.some(source => {
    return sourceTestPattern(source) && dirname(path) === join(dirname(source), '__tests__')
      && basename(path).startsWith(basename(source, extname(source)))
      && /\.test\.[cm]?[jt]sx?$/.test(path);
  });
}

function missingTestScope(raw) {
  const entries = declaredScopePaths(parseYamlFrontmatter(raw).scope);
  return entries.flatMap(source => {
    const pattern = sourceTestPattern(source);
    return pattern && !entries.some(entry => entry !== source && ownedTest(entry, [source]))
      ? [`we:${pattern}`] : [];
  });
}

/** gray-matter's executable engines, each replaced by one that refuses. */
const REFUSE_ENGINE = () => { throw new Error('executable frontmatter refused'); };
const NO_EXEC_ENGINES = Object.freeze({ js: REFUSE_ENGINE, javascript: REFUSE_ENGINE, coffee: REFUSE_ENGINE, coffeescript: REFUSE_ENGINE, cson: REFUSE_ENGINE });

/**
 * A card's frontmatter data, YAML only. #4291 advisory finding (security) — gray-matter's DEFAULT engines
 * `eval` a `---js` block, and `findItem` re-reads the card after the worker ran, so a bare `matter(text)` would
 * run worker-written JS inside the launcher. Anything but a plain `---` YAML block throws (→ no scope).
 * @param {string} text
 * @returns {object}
 */
function parseYamlFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) throw new Error('not a plain YAML frontmatter block');
  return matter(text, { language: 'yaml', engines: NO_EXEC_ENGINES }).data;
}

/** The real path of `rel` under `dir`, or `null` when `rel` is not a safe repo-relative path, does not exist, or
 *  resolves (through a symlink) outside the lane. Card-text paths reach the filesystem only through this. */
function laneContainedPath(dir, rel) {
  if (!isSafeRepoRelativePath(rel)) return null;
  try {
    const root = realpathSync(dir);
    const real = realpathSync(join(dir, rel));
    return real === root || real.startsWith(root + sep) ? real : null;
  } catch { return null; }
}

/** Parse `--k=v` flags, resolving roster workers and minting an omitted session. */
export function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const taskType = flags.taskType ?? 'doc-fix';
  if (!['doc-fix', 'bugfix', 'test-fix', 'prepare'].includes(taskType)) throw new Error('taskType must be doc-fix or bugfix or test-fix or prepare');
  const policy = readRoutingPolicy();
  const configured = flags.worker ? null : resolveOperationRoute({ operation: taskType === 'prepare' ? 'prepare-item' : 'build', taskType, policy, gateClosed: false, available: ['codex', 'antigravity', 'agy-claude', 'agy-gemini'] });
  const supplied = typeof flags.worker === 'string'
    ? (Object.hasOwn(PROBATION_WORKERS, flags.worker) ? { id: flags.worker } : JSON.parse(flags.worker))
    : configured ? { id: configured.provider === 'codex' ? 'codex' : configured.model.startsWith('claude-') ? 'antigravity-claude' : 'antigravity-gemini', model: configured.model, effort: configured.effort } : null;
  let worker = null;
  if (supplied) {
    const def = Object.hasOwn(PROBATION_WORKERS, supplied.id) ? PROBATION_WORKERS[supplied.id] : null;
    if (!def) throw new Error('unknown probation worker');
    const defaultModel = def.model ?? AGY_CLAUDE_MODEL_BY_TIER.sonnet;
    // An operator-pinned worker/model (CLI) keeps the narrow per-worker allowlist and the prepare roster; only a
    // policy-selected route may use the wider catalogue. The dispatcher, not this runner, evaluated the critical-work gate.
    // A full worker JSON is the dispatcher's own (policy-resolved) hand-off; a bare worker id or --model is an operator pin.
    const explicit = Boolean(flags.model) || (typeof flags.worker === 'string' && Object.hasOwn(PROBATION_WORKERS, flags.worker));
    let model;
    try { model = resolvePolicyModel(def.provider, flags.model ?? supplied.model ?? defaultModel); }
    catch (error) { throw new Error(`disallowed model for ${def.id}: ${error.message}`); }
    if (explicit) {
      const allowed = def.provider === 'antigravity' ? [defaultModel, 'claude-sonnet-4-6', 'gemini-3.8-flash-high'] : [defaultModel];
      if (taskType === 'prepare' && (!['codex', 'antigravity-gemini'].includes(def.id) || model !== defaultModel)) throw new Error('prepare requires a Codex or Gemini roster model');
      if (!allowed.includes(model)) throw new Error(`disallowed model for ${def.id}: ${model}`);
    }
    // A Gemini override must never bypass the simple-only/checker constraints.
    const flash = model.startsWith('gemini-');
    worker = { ...supplied, ...def, model, taskType,
      simpleOnly: def.simpleOnly || flash, checker: flash ? 'codex' : def.checker };
  }
  return {
    runId: flags['run-id'] ?? null,
    effectKey: flags['effect-key'] ?? null,
    num: flags.num ? String(flags.num) : null,
    session: String(flags.session ?? `probation-${flags.num ?? 'unknown'}-${worker?.id ?? 'unknown'}-${randomBytes(4).toString('hex')}`),
    taskType,
    attemptTag: flags.attempt ? String(flags.attempt) : '',
    lane: flags.lane ? Number(flags.lane) : null,
    scope: typeof flags.scope === 'string' && flags.scope ? flags.scope.split(',') : [],
    worker,
  };
}

/**
 * THE ARC. Returns `{outcome, executor, pr, detail}` — `executor` is who actually wrote the change (the worker's
 * own executor whenever it ran; `'none'` when nothing was ever attempted).
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} io - see {@link realIo} for the shape.
 */
export async function runProbationBuild(args, io) {
  const { num, session, worker } = args;
  const taskType = args.taskType ?? 'doc-fix';
  if (!['doc-fix', 'bugfix', 'test-fix', 'prepare'].includes(taskType)) throw new Error('taskType must be doc-fix or bugfix or test-fix or prepare');
  if (!num || !session || !worker?.id) throw new Error('probation-build-run: --num, --session and --worker are required');
  const preparing = taskType === 'prepare';
  if (preparing && !['codex', 'antigravity-gemini'].includes(worker.id)) throw new Error('prepare requires codex or antigravity-gemini');
  const log = (m) => io.log(`probation-build-run #${num} [${worker.id}]: ${m}`);
  let declinedReason = null;
  let modelEvidence = {};
  let couldNotPrepare = false;
  let proposedEdges = [];
  const finish = (outcome, executor, detail, row = {}) => {
    const evidence = preparing && !['opened-pr', 'could-not-prepare', 'prepare-already-done', 'prepare-needs-you'].includes(outcome) ? {
      error: detail, sessionAbsent: !workerRan,
      resultAuthored: Boolean(row.diff?.files), resultDiscarded: Boolean(row.resultDiscarded),
    } : null;
    const failure = evidence ? { cause: classifyPrepareFailure(evidence), evidence } : {};
    // One `probation-launch` row per build the WORKER actually ran — an item that could never be claimed or
    // found is not a trial of it.
    if (executor === worker.executor) {
      io.appendScorecard({ ...launchScorecardRow({
        worker: { ...worker, taskType }, modelEvidence, checker: checkerRow, pr: row.pr ?? null, repo: REPO_SLUG, handle: session, item: num, launchOutcome: outcome, diff: row.diff ?? null,
      }), ...failure });
    }
    if (declinedReason) detail = `worker-declined: ${declinedReason} — ${detail}`;
    log(`${outcome} — ${detail}`);
    const result = { outcome, executor, pr: row.pr ?? null, detail, ...failure };
    if (preparing) {
      try { io.settlePrepare?.({ runId: args.runId, key: args.effectKey,
        status: ['opened-pr', 'prepare-already-done'].includes(outcome) ? 'applied' : 'failed', result }); }
      catch (e) { log(`prepare settlement failed: ${e?.message ?? e}`); }
    }
    return result;
  };

  // Mutable across the whole arc, read by the ONE catch at the bottom — #4291 plan review round 4
  // (claim-accuracy): every earlier draft protected only PART of the arc (`baseSha`/`preexisting` captured
  // outside a try, or a separate try per phase), which meant an error in the unprotected part propagated past
  // this function entirely instead of reporting cleanly. Wrapping the WHOLE arc in one try/catch — with these
  // three variables as the only state the catch needs — closes that for every call, not just the ones a
  // reviewer happened to name.
  let checkerRow = null;
  let lanePath = null;
  let baseSha = null;
  let preexisting = [];
  let workerRan = false; // did the worker actually run? decides the caught error's scorecard attribution.
  // `executor` defaults to the worker's (a launch attempt worth a scorecard row) but a pre-worker consistency
  // check that never ran it passes `'none'` explicitly, so `finish` never credits/blames it for a trial it had
  // no part in.
  const abandon = (outcome, detail, row = {}, executor = worker.executor) => {
    if (baseSha != null) io.discardChanges(lanePath, baseSha, preexisting);
    return finish(outcome, executor, detail, { ...row, resultDiscarded: baseSha != null });
  };

  try {
    const blockers = io.openBlockers(num);
    if (blockers.length) return finish('blocked', 'none', `blockedBy not resolved on main: ${blockers.map((n) => `#${n}`).join(', ')}`);

    lanePath = io.acquireLane({ lane: args.lane, session, scope: args.scope, taskType });
    if (!lanePath) return finish('not-applicable', 'none', 'could not acquire a lane for this build');

    // x55dojc — force a known-clean git-hook baseline BEFORE any claim/worker/commit runs in this lane, so a
    // PREVIOUS dispatch's leftovers in a reused pooled lane are never silently inherited. A cleanup that
    // cannot fully complete means no safe baseline exists — refuse outright before running any worker.
    const hookReset = io.resetHookSurface(lanePath);
    if (!hookReset.clean) {
      log(`SECURITY: could not establish a clean git-hook baseline in ${lanePath} (leftover: ${hookReset.leftover.join(', ') || '(config write failed)'}) — refusing before any git command runs`);
      return finish('escalated-needs-human', 'none', 'refused: could not establish a clean git-hook baseline in the lane');
    }

    let item = io.findItem(num, lanePath);
    if (!item) return finish('not-applicable', 'none', `no backlog/${num}-*.md file in this checkout`);
    if (preparing && parseYamlFrontmatter(item.raw).status !== 'open') {
      return finish('not-applicable', 'none', 'prepare requires an open card');
    }

    // Captured BEFORE the claim, so the check right after it can tell "claim only edited the working tree"
    // (the assumption every `abandon` below rests on) apart from "claim also committed", which would move
    // HEAD and quietly invalidate treating `baseSha` as the true pre-claim state.
    const preClaimSha = io.headSha(lanePath);

    if (!preparing && !io.claim(num, session, lanePath)) {
      return finish('not-applicable', 'none', 'the item could not be claimed (already active/resolved, or a blocker reopened)');
    }

    // Captured right after the claim succeeds, BEFORE this run's own commit ever exists — see the file
    // docblock for why a plain `git reset --hard` back to this sha (never `backlog.mjs release`) is what
    // `abandon` uses to undo the claim along with everything after it, in one step.
    // #4291 advisory finding (codex-correctness) — `baseSha` is set to the KNOWN pre-claim sha BEFORE the
    // post-claim re-read, so a throw from that re-read (the claim already succeeded) still reaches the catch
    // with a base to reset to, and the claim is undone rather than left `active` in the lane.
    baseSha = preClaimSha;
    const postClaimSha = io.headSha(lanePath);
    // #4291 plan review, round 4 (claim-accuracy) — verified LIVE, not just asserted: if `claim` ever committed
    // (moving HEAD), the pre-claim sha is no longer the lane's own state, and every `abandon` path's
    // `git reset --hard` would silently stop being the full undo the file docblock promises.
    if (postClaimSha !== preClaimSha) {
      baseSha = null; // `abandon` must not reset across an unexplained commit.
      return abandon('escalated-needs-human', `claim moved HEAD (${preClaimSha} → ${postClaimSha}) — refusing before running any worker, because this launcher's undo assumes claim never commits`, {}, 'none');
    }
    // Snapshot what is untracked BEFORE the worker runs, so only files it creates can join the build.
    preexisting = io.untracked(lanePath);

    // #4291 plan review, round 4 — every design decision from here on (relying on a plain `git reset --hard`
    // to undo the claim, never `backlog.mjs release`; the doc-fix guard's own frontmatter allow-list) rests on
    // ONE assumption: `claim` only ever splices `status`+`dateStarted`, ground-truthed by reading
    // `we:scripts/backlog/frontmatter.mjs#applyTransition` directly (see `CLAIM_OWNED_FRONTMATTER_KEYS`'s own
    // docblock). Rather than leave that as a one-time review-time fact, RE-CHECK it live on every run: if
    // `claim` ever changes to write something else, this catches it immediately — before the worker ever
    // runs, while undoing it costs nothing — instead of that drift surfacing later as a silently-wrong
    // envelope/tamper check.
    const afterClaim = io.findItem(num, lanePath);
    if (frontmatterTamperedBeyondClaim(item.raw, afterClaim?.raw, BUILD_OWNED_FRONTMATTER_KEYS)) {
      return abandon('escalated-needs-human', 'claim wrote frontmatter this launcher does not expect — refusing before running any worker (see CLAIM_OWNED_FRONTMATTER_KEYS)', {}, 'none');
    }

    // #4291 plan review, round 7 — a doc-fix build REFUSES outright with no declared `scope:`, before running
    // any worker. Rounds 4-6 tried bounding an unscoped worker's touch-set with a DENYLIST of specific
    // dangerous paths (statute, `CLAUDE.md`/`AGENTS.md`, another backlog card, …) and it kept being provably
    // incomplete — round 5 named `CLAUDE.md`, round 6 named `GEMINI.md`, and any next round could name a
    // `git mv` trick or a path the denylist never enumerated. A doc-fix item is already expected to declare a
    // plausible `scope:` (the readiness pre-check's own "scope sane" criterion, and the ROUTER already needs
    // `filesTouched`/`estimatedSize` to offer a probation worker at all — `we:scripts/lib/provider-routing.mjs
    // #selectProbationWorker`'s `isWithinProvenEnvelope` check), so refusing the rare unscoped item is not a
    // capability this loses so much as a precondition this launcher was always going to need anyway — and it
    // closes the whole class of "the denylist didn't name X" findings at once, rather than growing the list
    // forever.
    // #4291 advisory finding (codex-correctness) — the allowlist is the CARD's own `scope:` as read in this
    // lane, never the dispatch's `--scope` argument: a stale or overridden dispatch scope must not widen what
    // the worker may touch. `--scope` is what the lane LEASED, so a touched path must fall inside BOTH: the card
    // grants the edit, the lease keeps it off files a sibling lane may hold.
    const scopeEntries = preparing ? [item.path] : declaredScopePaths(item.scope);
    const leasedEntries = declaredScopePaths(args.scope);
    if (!scopeEntries.length) {
      return abandon('not-applicable', 'the item declares no scope: — refusing before running any worker; a probation build needs a declared scope to bound what the worker may touch', {}, 'none');
    }

    // The item's own file is EXCLUDED from every diff/envelope measurement below, on top of `preexisting` — the
    // claim (and later the resolve) mutate it too, and that bookkeeping diff is not the worker's own change;
    // left in, it would inflate the doc-fix envelope's file/line count with an unrelated frontmatter edit
    // (agy-launcher plan review, #4291). It is added to the final commit explicitly and separately, exactly
    // once.
    const excludeFromDiff = preparing ? [] : [...preexisting, item.path];

    const task = preparing ? io.readPrepareBrief(lanePath)
      .replaceAll('{{ITEM_NUM}}', String(num)).replaceAll('{{ITEM_SPEC_PATH}}', item.path) +
      '\nTest scope is required before stamping: after any factual scope correction (#4658), the card scope must also list the existing or planned matching test file for each source entry (or one of the following narrow patterns).\n' +
      declaredScopePaths(item.scope).map(sourceTestPattern).filter(Boolean).map(p => `we:${p}`).join('\n') : buildDocFixTask({ num, title: item.title, spec: item.spec, scope: item.scope, taskType }) +
      '\nIf the work already exists, check every Done-when against main and find the delivering commit in git log. ' +
      'When all checks pass, report "spec already done on main: commit <sha>" with the actual delivering SHA.\n';
    let taskFile = io.writeTaskFile(lanePath, 'probation-build-task.md', task);
    let summary, diffRow, postHookSurface;
    const preHookSurface = hookReset.snapshot;
    // A guarded stamp validates authored prose too (e.g. locus prefixes). Let the
    // same worker repair that concrete diagnostic before discarding its result.
    let rescoped = null;
    for (let attempt = 0; attempt < (preparing ? 2 : 1); attempt++) {
      log(`running ${worker.launcher} --model=${worker.model}`);
      const run = io.runWorker(buildWorkerArgv({ worker, weRoot: lanePath, dir: lanePath, taskFile }), lanePath);
      modelEvidence = run.modelEvidence ?? {};
      workerRan = true;
      // x55dojc — checked BEFORE the `run.ok` gate below on purpose: even a worker that crashed or timed out
      // could have planted a hook before it did, so this must never be skipped just because the run itself
      // failed.
      postHookSurface = io.snapshotHookSurface(lanePath);
      const hookCheck = hookSurfaceChanged(preHookSurface, postHookSurface);
      if (hookCheck.changed) {
        log(`SECURITY: the worker's own run changed the lane's git-hook surface — refusing, discarding, never committing/pushing: ${hookCheck.reason}`);
        // The pre-worker config comes back (the whole file, not just hooksPath) BEFORE `abandon`'s discard runs git.
        // If it could not, no git runs in the lane at all: `baseSha = null` skips the discard, and a human gets it.
        if (!io.resetHookSurface(lanePath, preHookSurface).clean) baseSha = null;
        return abandon('escalated-needs-human', `refused: ${hookCheck.reason}${baseSha == null ? ' (the lane config could not be restored — the lane was NOT discarded; quarantine it)' : ''}`, {});
      }
      // #4291 plan-review finding (correctness, round 2) — a worker that crashed or timed out but still left a
      // partial, envelope-sized diff must never be treated as a clean build: a resolved item + an opened PR would
      // credit a failed run as a success. `run.ok` (not just "did it change anything") gates everything after it.
      if (!run.ok) return abandon('escalated-needs-human', `not built: the worker did not finish cleanly: ${String(run.out ?? '').slice(0, 300)}`, {});

      summary = summarizeNumstat(io.diffNumstat(lanePath, baseSha, excludeFromDiff), { exclude: excludeFromDiff });
      diffRow = { files: summary.files, loc: summary.loc };
      // #4291 plan-review finding (correctness/security) — `item.path` is excluded from the diff/envelope above
      // (it is the CLAIM's own bookkeeping, not the worker's change), which means a worker that rewrites the
      // item's own file directly — disobeying "do not resolve the backlog item" — would otherwise be invisible
      // to every check above AND silently committed. Re-read the item and require BOTH its BODY (the spec text)
      // and its frontmatter to be unchanged from before the worker ran.
      // #4291 advisory finding (codex-correctness) — compared byte for byte against the POST-CLAIM read, never the
      // pre-claim one with the claim-owned keys allowed: those keys may change through `claim`, not through the
      // worker, so a worker forging `status:`/`dateStarted:` is tamper too.
      // Check the excluded card even on a no-change run.
      const postWorkerItem = io.findItem(num, lanePath);
      if (preparing ? frontmatterTamperedBeyondClaim(item.raw, postWorkerItem?.raw, PREPARE_OWNED_FRONTMATTER_KEYS) : (postWorkerItem?.spec !== item.spec || postWorkerItem?.raw !== afterClaim?.raw)) {
        return abandon('escalated-needs-human', "not built: the worker edited the item's own backlog card — refusing", { diff: diffRow });
      }
      // The prepare worker's final line, read into the outcome words of the planned worker-result contract
      // (we:scripts/conveyor/prepare-outcome.mjs). A colon-less or dashed report ("already-done - delivered by ...",
      // "could-not-prepare - scope is wrong") used to fall through to "prepare requires a card-only diff" and be
      // recorded as a failure (live #4560, #4328).
      // After a re-scope the runner's OWN card edit is in the diff, so `summary.files` is no longer zero for a worker
      // that changed nothing: it counts as "no worker diff" only while the card is still byte-for-byte what the
      // runner wrote and nothing else changed - otherwise a second decline would skip this branch and the
      // runner-authored edit would read as a prepared card (PR #4323 review).
      const workerMadeNoChange = !summary.files
        || (rescoped !== null && postWorkerItem?.raw === item.raw && summary.paths.every((p) => p === item.path));
      const report = preparing && workerMadeNoChange ? classifyPrepareReport(run.lastMessage) : null;
      if (report?.outcome === 'no-change' || (report?.outcome === 'blocked' && report.blocker.kind === 'spec-defect')) {
        if (io.headSha(lanePath) !== baseSha) return abandon('escalated-needs-human', `refused: worker moved HEAD before ${report.outcome} routing`, { diff: diffRow });
      }
      if (rescoped !== null && summary.files && workerMadeNoChange && report?.outcome === 'done') {
        // The only change in the lane is the runner's own scope edit and the worker declined nothing: nothing was prepared.
        return abandon('gate-red', `prepare requires a card-only diff from the worker; only the runner's re-scope was present. worker report: ${sanitizeHoldReason(run.lastMessage, { max: 1200 }) || 'no final message'}`, { diff: diffRow });
      }
      const needsYou = (kind, detail) => {
        const reason = needsYouReason(kind, detail);
        const [route] = planHoldRouting([{ num, reason }]);
        io.holdWorkerDecline(route);
        return abandon('prepare-needs-you', reason, { diff: diffRow });
      };
      if (report?.outcome === 'no-change') {
        // Never resolve on the worker's word: the landing pass re-checks that the commit is on origin/main,
        // credits this card, touches real source, and that the tests it added pass on current main.
        if (!report.commit) return needsYou('already-done', 'the worker said the card is already done but cited no delivering commit');
        const [done] = planHoldRouting([{ num, reason: `spec already done on main: commit ${report.commit}` }]);
        io.holdWorkerDecline(done);
        io.discardChanges(lanePath, baseSha, preexisting);
        const landed = io.landAlreadyDone(done, lanePath, { citation: 'prepare' });
        if (landed.status === 'landed') return finish('prepare-already-done', worker.executor, `already-done: ${done.commit}; verified independently; opened resolve PR #${landed.pr}`, { diff: diffRow, pr: landed.pr });
        // Replace the already-done hold installed above: left in place it would keep describing an automatically
        // routable claim the landing pass just refused (PR #4323 review). The needs-you hold overwrites it.
        const reason = needsYouReason('already-done', `claimed commit ${report.commit} was not verified: ${landed.error}`);
        const [route] = planHoldRouting([{ num, reason }]);
        io.holdWorkerDecline(route);
        return finish('prepare-needs-you', worker.executor, reason, { diff: diffRow });
      }
      if (report?.outcome === 'blocked' && report.blocker.kind === 'spec-defect') {
        // A bad scope is re-derived from the code the card cites (one hop through a cited backlog card's own
        // scope); one re-scoped retry per run. When nothing can be derived, hold with a needs-you reason: it must
        // never stay a silent prepare-unstamped, and clearing the scope would only loop it back into prepare.
        const exists = (rel) => io.pathExists?.(lanePath, rel) === true;
        const derived = rescoped ? [] : deriveScopeFromCard(item.raw, { exists, readScope: (rel) => io.readCardScope?.(lanePath, rel) ?? [] });
        const current = declaredScopePaths(item.scope).map((e) => e.replace(/^we:/, ''));
        const changed = derived.length > 0 && derived.map((e) => e.replace(/^we:/, '')).join('\n') !== current.join('\n');
        if (attempt === 0 && changed && scopeIsDefective(item.scope, { exists })) {
          rescoped = derived;
          const newRaw = replaceCardScope(item.raw, derived);
          io.writeCard(lanePath, item.path, newRaw);
          item = { ...item, raw: newRaw, scope: derived };
          log(`worker reported a spec defect; re-derived scope ${derived.join(', ')} and retrying once`);
          taskFile = io.writeTaskFile(lanePath, 'probation-build-task.md', `${task}\n\nThe runner re-derived this card's scope from the code it cites and wrote it into the card: ${derived.join(', ')}. Prepare against that scope; list the matching test files too. Do not report the scope as wrong again unless these files are also wrong.\n`);
          continue;
        }
        return needsYou('spec-defect', report.summary);
      }
      if (report?.outcome === 'blocked') {
        if (io.headSha(lanePath) !== baseSha) return abandon('escalated-needs-human', 'refused: worker moved HEAD before prepare finding', { diff: diffRow });
        couldNotPrepare = true;
        declinedReason = sanitizeHoldReason(run.lastMessage, { max: 1200 });
        const [route] = planHoldRouting([{ num, reason: `worker-declined: ${declinedReason}` }]);
        io.holdWorkerDecline(route);
        const unstamped = removeFrontmatterField(removeFrontmatterField(item.raw, 'preparedDate'), 'preparedAgainstSha');
        io.writeCard(lanePath, item.path, clearScopeAndAppendFinding(unstamped, route));
        break;
      }
      if (preparing && (!summary.files || summary.paths.some(p => p !== item.path))) {
        return abandon('gate-red', `prepare requires a card-only diff; worker report: ${sanitizeHoldReason(run.lastMessage, { max: 1200 }) || 'no final message'}`, { diff: diffRow });
      }
      if (!summary.files) {
        // Classify the original report: prefixing it with worker-declined deliberately suppresses
        // already-done in the shared router. Its landing pass owns citation validation and graduatedTo.
        const [done] = planHoldRouting([{ num, reason: run.lastMessage }]);
        if (done?.route === 'already-done') {
          if (io.headSha(lanePath) !== baseSha) {
            return abandon('escalated-needs-human', 'refused: worker moved HEAD before already-done routing', { diff: diffRow });
          }
          io.holdWorkerDecline(done);
          io.discardChanges(lanePath, baseSha, preexisting);
          const landed = io.landAlreadyDone(done, lanePath);
          return finish(landed.status === 'landed' ? 'opened-pr' : 'escalated-needs-human', worker.executor,
            landed.status === 'landed' ? `already-done: ${done.commit}; opened PR #${landed.pr}`
              : `already-done landing failed: ${landed.error}`, { diff: diffRow, pr: landed.pr });
        }
        declinedReason = sanitizeHoldReason(run.lastMessage, { max: 600 })
          || 'The worker changed nothing and provided no final message.';
        const [route] = planHoldRouting([{ num, reason: `worker-declined: ${declinedReason}` }]);
        io.holdWorkerDecline(route);
        // Start from the pre-claim card: this is a finding, never a resolved build or abandoned active claim.
        io.writeCard(lanePath, item.path, clearScopeAndAppendFinding(item.raw, route));
      } else {
        // #4291 plan-review finding (security) — a doc-fix worker is TOLD to touch documentation only, but nothing
        // upstream enforces it: a hostile or mistaken spec could steer it into a test/config/CI file that still fits
        // the tiny envelope. Every path it actually touched (never `item.path` — checked separately below, because
        // a `.md` backlog card would otherwise pass this exact check too) must be a documentation path.
        const nonDocPaths = summary.paths.filter((p) => !isDocScopePath(p));
        if (taskType === 'doc-fix' && nonDocPaths.length) {
          return abandon('gate-red', `not built: touched non-documentation path(s) — a doc-fix worker may edit documentation only: ${nonDocPaths.join(', ')}`, { diff: diffRow });
        }
        // #4291 plan-review finding (security, rounds 4-7) — `isDocScopePath` accepts ANY `.md`/`docs/` path, which
        // is too wide on its own (round 5 named `CLAUDE.md`, round 6 named `GEMINI.md` against an earlier denylist
        // fallback that no longer exists — see the "no declared scope" refusal above). The ALLOWLIST is the item's
        // own declared `scope:`, guaranteed non-empty by that refusal: the worker may touch ONLY the paths the item
        // itself names.
        // An empty `--scope` is a whole-clone lease (lane-pool's own meaning), not deny-all — the card alone bounds it.
        // Gated on the RAW `--scope`: a lease naming only other repos' paths filters to `[]` but is still a lease.
        const added = new Set(io.addedPaths?.(lanePath, baseSha) ?? []);
        const allowed = (p, entries) => pathInScope(p, entries)
          || (['bugfix', 'test-fix'].includes(taskType) && added.has(p) && !preexisting.includes(p) && ownedTest(p, entries));
        const outOfScopePaths = summary.paths.filter((p) => !allowed(p, scopeEntries) || ((args.scope ?? []).length > 0 && !allowed(p, leasedEntries)));
        if (outOfScopePaths.length) {
          return abandon('gate-red', `not built: touched path(s) outside the item's own declared scope — a probation worker may edit only what the item names: ${outOfScopePaths.join(', ')}`, { diff: diffRow });
        }

        if (summary.paths.some(isStatuteTierPath)) {
          return abandon('gate-red', 'not built: statute-tier paths are refused', { diff: diffRow });
        }
        const fits = healDiffWithinEnvelope(summary, PROVEN_TASK_ENVELOPES[taskType]);
        if (!fits.ok) {
          // A test-only boundary violation is still refused; only size overflow routes to the builder.
          if (fits.reason.startsWith('test-fix refused')) return abandon('gate-red', `not built: ${fits.reason}`, { diff: diffRow });
          if (io.headSha(lanePath) !== baseSha) {
            return abandon('escalated-needs-human', 'refused: worker moved HEAD before envelope routing', { diff: diffRow });
          }
          declinedReason = `scope exceeds the ${taskType} envelope — route to the builder: ${fits.reason}`;
          const [route] = planHoldRouting([{ num, reason: `worker-declined: ${declinedReason}` }]);
          io.holdWorkerDecline(route);
          io.discardChanges(lanePath, baseSha, preexisting);
          if (summarizeNumstat(io.diffNumstat(lanePath, baseSha, excludeFromDiff), { exclude: excludeFromDiff }).files) {
            return abandon('gate-red', 'could not discard the over-envelope implementation diff', { diff: diffRow });
          }
          io.writeCard(lanePath, item.path, clearScopeAndAppendFinding(item.raw, route));
          summary = { files: 0, loc: 0, paths: [] };
          break;
        }

        if (worker.checker) {
          const checkerTask = io.writeTaskFile(lanePath, 'probation-build-check.md', [
            `Check this ${taskType} against its spec. Answer APPROVE or REJECT on the first line, then reasons.`,
            'Reject scope creep, weakened tests, incorrect fixes, or work that is not simple and mechanical.',
            item.spec, io.diffText(lanePath, baseSha),
          ].join('\n\n'));
          const verdict = parseCheckerVerdict(io.runChecker(buildCheckerArgv({ checker: worker.checker, weRoot: lanePath, dir: lanePath, taskFile: checkerTask }), lanePath));
          checkerRow = { provider: worker.checker, verdict: verdict.verdict, reason: verdict.reason };
          const checkerHooks = hookSurfaceChanged(postHookSurface, io.snapshotHookSurface(lanePath));
          if (checkerHooks.changed) {
            if (!io.resetHookSurface(lanePath, preHookSurface).clean) baseSha = null;
            return abandon('escalated-needs-human', `refused: checker changed the git-hook surface: ${checkerHooks.reason}`, { diff: diffRow });
          }
          if (!verdict.approved) return abandon('gate-red', `the ${worker.checker} checker did not approve: ${verdict.reason}`, { diff: diffRow });
        }

        const resolved = preparing
          ? (missingTestScope(postWorkerItem.raw).length
            ? { ok: false, out: `Missing test scope: ${missingTestScope(postWorkerItem.raw).join(', ')}` }
            : prepareCardStatus(postWorkerItem?.raw).hasSections
            ? io.stampPrepare(num, lanePath)
            : { ok: false, out: 'Missing nonempty Design, MVP, Test plan, or Proof plan sections.' })
          : io.resolveItem(num, lanePath);
        if (preparing && !resolved.ok && attempt === 0) {
          const diagnostic = resolved.reason ?? resolved.out ?? 'stamp failed';
          log(`prepare validation failed; returning to worker: ${diagnostic}`);
          taskFile = io.writeTaskFile(lanePath, 'probation-build-task.md', `${task}\n\nYour card failed prepare validation. Repair the card in place, preserving the completed sections. The runner will retry stamping.\n${diagnostic}`);
          continue;
        }
        if (!resolved.ok) return abandon('escalated-needs-human', `${preparing ? 'prepare-unstamped' : 'resolve refused'}: ${resolved.reason ?? resolved.out ?? ''}`, { diff: diffRow });
      }

      break;
    }

    if (preparing && !couldNotPrepare) {
      const stamped = io.findItem(num, lanePath);
      const fm = parseYamlFrontmatter(stamped?.raw ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fm.preparedDate ?? '')) || fm.preparedAgainstSha !== baseSha) return abandon('gate-red', 'prepare-unstamped', { diff: diffRow });
      if (frontmatterTamperedBeyondClaim(item.raw, stamped.raw, PREPARE_OWNED_FRONTMATTER_KEYS)
        || summarizeNumstat(io.diffNumstat(lanePath, baseSha, [])).paths.some(p => p !== item.path)) {
        return abandon('gate-red', 'prepare changed fields or files outside its envelope', { diff: diffRow });
      }
      // Ruling #4670 (2026-10-03): blockedBy edges are PROPOSED in the card body, never applied. Hold them to the
      // same DAG rules check:standards enforces (no resolved/missing/self target, no cycle) before the PR opens.
      proposedEdges = parseProposedBlockedBy(stamped.raw);
      if (proposedEdges.length) {
        const graph = io.blockedByGraph?.(lanePath);
        const bad = graph ? validateProposedBlockedBy(String(num), proposedEdges, graph) : ['the backlog graph could not be read'];
        if (bad.length) return abandon('gate-red', `prepare proposed invalid blockedBy changes: ${bad.join('; ')}`, { diff: diffRow });
      }
    }

    // x55dojc — re-checked immediately before the ONE commit this arc ever makes: `resolveItem` is its own
    // subprocess (`run.mjs resolve`) between the post-worker snapshot above and here, so this is not a
    // redundant re-read of the same window.
    const preCommitHookSurface = io.snapshotHookSurface(lanePath);
    const preCommitCheck = hookSurfaceChanged(postHookSurface, preCommitHookSurface);
    if (preCommitCheck.changed) {
      log(`SECURITY: the lane's git-hook surface changed during resolve — refusing, discarding, never committing/pushing: ${preCommitCheck.reason}`);
      if (!io.resetHookSurface(lanePath, preHookSurface).clean) baseSha = null;
      return abandon('escalated-needs-human', `refused: ${preCommitCheck.reason}${baseSha == null ? ' (the lane config could not be restored — the lane was NOT discarded; quarantine it)' : ''}`, { diff: diffRow });
    }

    if (io.headSha(lanePath) !== baseSha) {
      return abandon('escalated-needs-human', 'refused: worker or resolve moved HEAD before the launcher commit', { diff: diffRow });
    }
    io.commit(lanePath, [...new Set([...summary.paths, item.path])], declinedReason ? `${machinePrTitle({ item: num, kind: 'findings', card: item })}\n` : buildDocFixCommitMessage({ num, worker, taskType, title: item.title }));

    // The FINAL gate, on the commit that carries both the build and the resolve — the marker-writing mode
    // (unlike `probation-heal-run.mjs#runGate`'s marker-less `run` mode), because `open-pr --requireVerified=true`
    // below needs a fresh GREEN marker keyed to this exact HEAD.
    const gate = io.runGate(lanePath);
    if (!gate.pass) return abandon('gate-red', `the gate is red after the build and the resolve: ${gate.failureDetail ?? gateFailureDetail(gate.output)}`, { diff: diffRow });

    if (preparing && !couldNotPrepare) {
      const committed = parseYamlFrontmatter(io.readCommittedCard(lanePath, item.path));
      if (!committed.preparedDate || committed.preparedAgainstSha !== baseSha) {
        return abandon('gate-red', 'prepare-unstamped at HEAD', { diff: diffRow });
      }
    }

    // #4291 plan-review finding (claim-accuracy, round 2) — a SEPARATE try/catch starts here, deliberately NOT
    // covered by the outer one's `abandon`: everything above this point undoes on ANY error, but the commit is
    // now gate-GREEN, and this docblock's own promise ("a failure after the gate is green leaves the built
    // commit in the lane for a human") must hold for an unexpected thrown error here too, not only for the
    // `submitted.ok === false` case already handled explicitly. `writePrBody`/`openPr` therefore never reach
    // `abandon` — a throw here reports `escalated-needs-human` and stops, exactly like a `!submitted.ok` result.
    try {
      const bodyFile = io.writePrBody(lanePath, { num, worker, diff: diffRow, taskType, declinedReason, proposedEdges });
      const submitted = io.openPr({ lanePath, num, slug: item.slug, attemptTag: args.attemptTag, bodyFile, taskType });
      if (!submitted.ok) {
        // The build is committed and gate-green in the lane either way — never discarded here. A
        // `blocked-on-infra` ref push is auto-retried by the conveyor's own recovery pass; anything else is a
        // real question for a human, and the built work stays in the lane for them to pick up rather than
        // being lost.
        return finish(submitted.blockedOnInfra ? 'blocked-on-infra' : 'escalated-needs-human', worker.executor, submitted.reason, { diff: diffRow });
      }
      return finish(couldNotPrepare ? 'could-not-prepare' : 'opened-pr', worker.executor, `opened PR #${submitted.pr}, parked review:pending — full review and a run rating are owed`, { diff: diffRow, pr: submitted.pr });
    } catch (e) {
      return finish('escalated-needs-human', worker.executor, `unexpected error opening the PR (the build is committed, gate-green, in the lane): ${e?.message ?? e}`, { diff: diffRow });
    }
  } catch (e) {
    // `workerRan` (set the instant `io.runWorker` returns, above) decides the executor: `'none'` for anything
    // that failed before the worker ever ran (so `finish` never writes a scorecard row for a trial the worker
    // had no part in), the worker's own otherwise — see the `abandon` docblock above.
    return abandon('escalated-needs-human', `unexpected error: ${e?.message ?? e}`, {}, workerRan ? worker.executor : 'none');
  }
}

// ─── the real processes ────────────────────────────────────────────────────────────────────────────────────

/** Keep the first failure before the subprocess output is truncated for the result. */
export function gateFailureDetail(output) {
  const lines = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim());
  const first = lines.find(line => /^(?:error\b|FAIL\b|Error:|npm error|[^\w\s]*\s*AssertionError:)/i.test(line));
  const check = first?.startsWith('error ') && lines.some(line => line.includes('check-standards'))
    ? 'check:standards'
    : first?.startsWith('FAIL') ? 'vitest' : 'verify-lane';
  return `${check}: ${(first || lines.find(line => line) || 'no diagnostic output').slice(0, 1500)}`;
}

function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
function trySh(bin, args, opts = {}) {
  try { return { ok: true, out: sh(bin, args, opts) }; } catch (e) { return { ok: false, stdout: String(e?.stdout ?? ''), out: `${e?.stdout ?? ''}${e?.stderr ?? e?.message ?? ''}` }; }
}

/**
 * argv (after `node scripts/operations/run.mjs`) for opening a probation build's PR. PURE, and exported
 * specifically so a test can assert `--mode=park`/`--parkLabel=review:pending`/`--requireVerified=true` are
 * present WITHOUT running a real `open-pr` process (#4291 plan review, round 3: a fake-io arc test can never
 * catch a later edit that drops one of these — this is the direct, cheap defence). Every probation build PR is
 * parked `review:pending`, never `label-on-green` — see the file docblock for why.
 * @param {{num: string|number, attemptTag?: string, slug: string, bodyFile: string, taskType?: 'doc-fix'|'bugfix'}} o
 * @returns {string[]}
 */
export function openPrArgv({ num, attemptTag, slug, bodyFile, taskType = 'doc-fix' }) {
  const ref = `lane/${num}${attemptTag ?? ''}-${taskType === 'prepare' ? 'prepare-' : ''}${slug}`;
  return [
    'open-pr', `--ref=${ref}`, '--sha=HEAD', '--base=main', `--bodyFile=${bodyFile}`,
    `--title=${machinePrTitle({ item: num, kind: taskType === 'prepare' ? 'prepare' : `${taskType}-build`, subject: slug.replace(/-/g, ' ') })}`,
    '--mode=park', '--parkLabel=review:pending', '--requireVerified=true', '--json',
  ];
}

/** Accept a report alone or the launcher's JSONL followed by a pretty-printed report. */
export function captureWorkerMessage(output, readLog = () => '') {
  const lines = String(output ?? '').split('\n');
  let report;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { report = JSON.parse(lines.slice(i).join('\n')); break; } catch { /* stream row */ }
  }
  const text = (value) => typeof value === 'string' && value.trim() ? value : '';
  const reported = text(report?.lastMessage) || text(report?.events?.finalResponse);
  if (reported) return reported;
  const fromStream = (stream) => {
    const events = String(stream).split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const codex = events.filter((e) => e?.type === 'item.completed' && e.item?.type === 'agent_message'
      && text(e.item.text)).at(-1)?.item.text;
    const gemini = summarizeAgyEvents(events);
    return text(codex) || text(gemini.finalResponse) || text(gemini.agentMessages.at(-1));
  };
  return fromStream(output) || fromStream(readLog(report?.logFile));
}

/** The real `io` for {@link runProbationBuild}. Every call is bounded and never throws past its own contract.
 *  x55dojc — `laneEnv` disables git hooks (see `../lib/git-hook-surface.mjs`) for every subprocess the
 *  LAUNCHER runs in the lane, so a planted hook can never fire with the launcher's own credentials. The worker
 *  gets `workerEnv` instead (#4291 advisory review): it keeps the repo's own `.githooks/pre-push` main-push guard. */
/**
 * Card xmh9mtr — the heavy-admission identity every heavy hold of this run (the worker's own vitest /
 * check:standards, and the final verify-lane) is recorded under. Set in env because the lane lease alone is
 * not durable here: a fresh probation lane can be reaped `pr-merged` seconds after acquire, which left every
 * external build hold in `durations.jsonl` with no session. Pure.
 */
export function probationHoldIdentityEnv({ session, runId = null, taskType = 'doc-fix' }) {
  if (!session) return {};
  return {
    [HOLD_SESSION_ENV]: String(session),
    [HOLD_DISPATCH_KIND_ENV]: taskType === 'prepare' ? 'prepare' : 'build',
    ...(runId ? { [HOLD_RUN_ID_ENV]: String(runId) } : {}),
  };
}

export function realIo({ session, runId = null, taskType = 'doc-fix', env = process.env, repoRoot = WE_ROOT } = {}) {
  const workerEnv = { ...env, LANE_SESSION: session, ...probationHoldIdentityEnv({ session, runId, taskType }) };
  const laneEnv = withHooksDisabled(workerEnv);
  // cwd alone is insufficient: backlog/operation tools derive their roots from import.meta.url.
  // Daemon clones are allowed as read-only launch sources; every writer uses the lane's script copy.
  const node = (script, args, opts) => trySh(process.execPath, [join(opts.cwd, script), ...args], opts);
  return {
    log: (m) => console.error(m),
    openBlockers(n) {
      const item = this.findItem(n, repoRoot);
      if (!item) throw new Error(`no backlog/${n}-*.md file in the launch checkout`);
      parseYamlFrontmatter(item.raw); // Reject executable frontmatter before the shared card parser.
      const { blockedBy: blockers } = parseCard(String(n), item.raw);
      if (!blockers.length) return [];
      // Read a single main snapshot, never a lane's unlanded resolution. Missing cards fail closed.
      const main = sh('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, env: laneEnv }).trim();
      const paths = sh('git', ['ls-tree', '-r', '--name-only', main, '--', 'backlog/'], { cwd: repoRoot, env: laneEnv }).trim().split('\n');
      return blockers.filter((id) => {
        const path = paths.find((p) => p.startsWith(`backlog/${id}-`) && p.endsWith('.md'));
        return !path || readField(sh('git', ['show', `${main}:${path}`], { cwd: repoRoot, env: laneEnv }), 'status') !== 'resolved';
      });
    },
    acquireLane: ({ lane, session: s, scope, taskType = 'doc-fix' }) => {
      const args = ['acquire', `--repo=${repoRoot}`, `--purpose=probation-${taskType}-build`, `--session=${s}`, '--base=main'];
      if (lane) args.push(`--lane=${lane}`);
      if (scope?.length) args.push(`--scope=${scope.join(',')}`);
      const r = node('scripts/lane-pool.mjs', args, { cwd: repoRoot, env: { ...laneEnv, LANE_POOL_ROOT: resolve(repoRoot, defaultPoolRoot(repoRoot, env)) }, timeout: 15 * 60 * 1000 });
      if (!r.ok) throw new Error(`could not acquire a lane: ${r.out.trim()}`);
      const last = r.out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      if (!last.startsWith('/')) throw new Error(`could not acquire a lane: ${r.out.trim() || 'lane-pool returned no lane path'}`);
      const realLane = realpathSync(last);
      const realRoot = realpathSync(repoRoot);
      if (realLane === realRoot || realLane.startsWith(`${realRoot}/`)
        || isDaemonCloneRealpath(realLane, daemonCloneRoots(workspaceFor(repoRoot), { env }))) {
        throw new Error('refused: acquired lane is the launch checkout or a registered daemon clone');
      }
      return realLane;
    },
    resetHookSurface: (dir, baseline) => resetHookSurface(dir, baseline),
    snapshotHookSurface: (dir) => snapshotHookSurface(dir),
    // The item's own backlog file, resolved by listing `backlog/` for `<num>-*.md` — never a hand-rolled loader
    // of `src/_data/backlog.js` (that loader's own consumer, `dispatch-lane-io.mjs#findItem`, is what handed
    // THIS dispatch its `num` in the first place; re-deriving the same fact a second way risks disagreeing
    // with it). The title is the file's own `# ` heading; the spec is the whole file body below the frontmatter.
    // num -> {status, blockedBy} for every card: the graph the proposed-edge DAG check (ruling #4670) walks.
    blockedByGraph: (dir) => {
      const graph = new Map();
      const cardFilename = new RegExp(`^(${BACKLOG_ID_SOURCE})-.*\\.md$`);
      try {
        for (const f of readdirSync(join(dir, 'backlog'))) {
          const m = cardFilename.exec(f);
          if (!m) continue;
          let fm = {};
          try { fm = parseYamlFrontmatter(readFileSync(join(dir, 'backlog', f), 'utf8')) ?? {}; } catch { /* unreadable card: no edges, unknown status */ }
          graph.set(m[1], { status: String(fm.status ?? ''), blockedBy: Array.isArray(fm.blockedBy) ? fm.blockedBy.map(String) : [] });
        }
      } catch { return null; }
      return graph;
    },
    findItem: (n, dir) => {
      let names;
      try { names = readdirSync(join(dir, 'backlog')); } catch { return null; }
      const name = names.find((f) => f.startsWith(`${n}-`) && f.endsWith('.md'));
      if (!name) return null;
      const path = `backlog/${name}`;
      const text = readFileSync(join(dir, path), 'utf8');
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      const titleMatch = /^#\s+(.+)$/m.exec(body);
      // `raw` — the file's whole text, unmodified — is what `frontmatterTamperedBeyondClaim` compares a later
      // re-read against (#4291 plan review): `spec` alone (the body) cannot see a worker that rewrites a
      // frontmatter FIELD (`scope:`, `blockedBy:`, …) rather than the body.
      // `scope` — the card's own declared `scope:` (the build's edit allowlist); anything but a list reads as none.
      let scope = [];
      try { const s = parseYamlFrontmatter(text)?.scope; if (Array.isArray(s)) scope = s.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()); } catch { /* unparseable frontmatter → no scope → refused */ }
      return { path, slug: name.slice(String(n).length + 1, -3), title: titleMatch ? titleMatch[1].trim() : '', spec: body, raw: text, scope };
    },
    holdWorkerDecline: (entry) => {
      // Dedup the daemon's landing pass while this runner lands the same routed finding.
      const lease = reserveHoldRoute({ num: entry.num, route: entry.route });
      if (!lease.ok) throw new Error('worker-declined hold routing is already in flight');
      const held = placeBuildDispatchHold({ num: entry.num, reason: entry.reason });
      if (!held.ok) throw new Error('could not place worker-declined dispatch hold');
    },
    writeCard: (dir, path, text) => writeFileSync(join(dir, path), text),
    // Both re-scope probes read card-text-supplied paths (untrusted): a path that is not repo-relative, or whose real
    // location (symlinks resolved) is outside the lane, is treated as absent and never opened (PR #4323 review).
    pathExists: (dir, rel) => laneContainedPath(dir, rel) !== null,
    // A cited backlog card's own `scope:` (one hop of the re-scope probe); unreadable reads as none.
    readCardScope: (dir, rel) => {
      try {
        const abs = laneContainedPath(dir, rel);
        if (abs === null) return [];
        const s = parseYamlFrontmatter(readFileSync(abs, 'utf8'))?.scope;
        return Array.isArray(s) ? s.filter((x) => typeof x === 'string') : [];
      } catch { return []; }
    },
    landAlreadyDone: (entry, dir, { citation = 'strict' } = {}) => landRoute({ ...entry, citation }, {
      // Reuse the runner's acquired lane; keep every mutation in it and hooks disabled.
      acquireFn: () => ({ path: dir }), releaseFn: () => {},
      runFn: (bin, argv, cwd, { timeoutMs = resolveChildTimeoutMs() } = {}) => sh(bin, argv, {
        cwd, env: laneEnv, timeout: timeoutMs, killSignal: 'SIGKILL',
      }),
    }),
    readCommittedCard: (dir, path) => sh('git', ['-C', dir, 'show', `HEAD:${path}`], { cwd: dir, env: laneEnv }),
    readPrepareBrief: (dir) => readFileSync(join(dir, 'skills-src/conveyor/prepare-item-worker-brief.md'), 'utf8'),
    stampPrepare: (n, dir) => node('scripts/backlog.mjs', ['prepare-stamp', String(n)], { cwd: dir, env: laneEnv }),
    claim: (n, s, dir) => node('scripts/backlog.mjs', ['claim', String(n), `--session=${s}`], { cwd: dir, env: laneEnv }).ok,
    headSha: (dir) => sh('git', ['-C', dir, 'rev-parse', 'HEAD'], { cwd: dir, env: laneEnv }).trim(),
    writeTaskFile: (dir, name, text) => {
      // Inside `.git`, so the task text never shows up in the build diff.
      const p = join(dir, '.git', name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    runWorker: (argv, dir = process.cwd()) => {
      // SYNCHRONOUS on purpose: both launchers block until the model's turn ends (see their own headers).
      // `workerEnv`, never `laneEnv`: the worker's own git use keeps the repo's guard hooks (see `realIo`).
      const launcher = argv.find((arg) => /(?:codex|gemini)-direct-task\.mjs$/.test(arg));
      const provider = launcher?.includes('gemini-direct-task') ? 'gemini' : 'codex';
      const logArg = argv.find((arg) => arg.startsWith('--log='));
      const logPath = logArg ? resolve(dir, logArg.slice(6)) : join(dir, '.git', `${provider}-direct-task.jsonl`);
      const signature = (path) => {
        try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return null; }
      };
      const before = signature(logPath);
      const r = trySh(process.execPath, argv, { cwd: dir, env: workerEnv, timeout: 70 * 60 * 1000 });
      // Capture now, before any lane cleanup. Never attribute an untouched previous run's log.
      const lastMessage = captureWorkerMessage(r.out, (reportedPath) => {
        const path = reportedPath ? resolve(dir, reportedPath) : logPath;
        if (!reportedPath && signature(path) === before) return '';
        try { return readFileSync(path, 'utf8'); } catch { return ''; }
      });
      return { modelEvidence: parseAgyReportEvidence(r.stdout ?? r.out), ok: r.ok, out: r.out.slice(-4000), lastMessage: typeof lastMessage === 'string' ? lastMessage : '' };
    },
    runChecker: (argv, dir) => {
      const r = trySh(process.execPath, argv, { cwd: dir, env: workerEnv, timeout: 20 * 60 * 1000 });
      if (!r.ok) return '';
      try { return JSON.parse(r.out).lastMessage ?? ''; } catch { return ''; }
    },
    addedPaths: (dir, base) => sh('git', ['-C', dir, 'diff', '--no-renames', '--diff-filter=A', '--name-only', base], { cwd: dir, env: laneEnv }).split('\n').filter(Boolean),
    diffText: (dir, base) => sh('git', ['-C', dir, 'diff', '--no-renames', base], { cwd: dir, env: laneEnv }),
    untracked: (dir) => sh('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { cwd: dir, env: laneEnv }).split('\n').filter(Boolean),
    diffNumstat: (dir, base, exclude = []) => {
      const created = newUntrackedPaths(exclude, sh('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { cwd: dir, env: laneEnv }).split('\n').filter(Boolean));
      if (created.length) trySh('git', ['-C', dir, 'add', '--intent-to-add', '--', ...created], { cwd: dir, env: laneEnv });
      if (exclude.length) trySh('git', ['-C', dir, 'reset', '-q', '--', ...exclude], { cwd: dir, env: laneEnv });
      // #4291 plan-review finding (security, round 8) — `--no-renames`, explicit and unconditional: with rename
      // detection on (a local `diff.renames` config, not this repo's own default), a renamed file's numstat
      // line reads `old => new` (or `{old => new}`) as ONE path string, which `summarizeNumstat` would then
      // treat as a single opaque path — matching neither the old nor the new name in the scope allowlist, so
      // it would ALREADY refuse (an unmatched path is out-of-scope), but only by accident of string mismatch,
      // not by design. Forcing rename detection off makes a rename report as a plain delete + add — two
      // ordinary paths the allowlist checks exactly like any other change — so the safety no longer depends on
      // arithmetic on an opaque `a => b` string ever failing to match.
      return sh('git', ['-C', dir, 'diff', '--no-renames', '--numstat', base], { cwd: dir, env: laneEnv });
    },
    // Undo ALL of this run's own changes back to `base` (the claim's stamp, any uncommitted diff, and a commit
    // already made alike — see the file docblock for why this, not `backlog.mjs release`, is the one undo this
    // script needs), then delete just the untracked paths the worker itself created.
    // #4291 plan-review finding (correctness, round 2) — every call here is `trySh` (never the throwing `sh`),
    // deliberately: this is the LAST-RESORT cleanup `abandon` calls from inside a `catch`, so a git hiccup here
    // must degrade (best-effort) rather than throw past it and skip the scorecard row / final report entirely.
    discardChanges: (dir, base, preexisting = []) => {
      const listed = trySh('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { cwd: dir, env: laneEnv });
      const created = listed.ok ? newUntrackedPaths(preexisting, listed.out.split('\n').filter(Boolean)) : [];
      trySh('git', ['-C', dir, 'reset', '--hard', base], { cwd: dir, env: laneEnv });
      if (created.length) trySh('git', ['-C', dir, 'clean', '-f', '--', ...created], { cwd: dir, env: laneEnv });
    },
    resolveItem: (n, dir) => {
      const r = node('scripts/operations/run.mjs', ['resolve', `--ref=${n}`, '--json'], { cwd: dir, env: laneEnv });
      if (r.ok) return { ok: true };
      let reason = r.out.trim().slice(0, 500);
      try { reason = JSON.parse(r.out)?.reason ?? reason; } catch { /* not JSON — keep the raw tail */ }
      return { ok: false, reason };
    },
    commit: (dir, paths, message) => {
      const msgFile = join(dir, '.git', 'probation-build-commit-msg.txt');
      writeFileSync(msgFile, message);
      sh('git', ['-C', dir, 'add', '--', ...paths], { cwd: dir, env: laneEnv });
      sh('git', ['-C', dir, 'commit', '-F', msgFile, '--', ...paths], { cwd: dir, env: laneEnv });
    },
    runGate: (dir) => {
      // The DEFAULT (marker-writing) mode — never `run` mode — so `open-pr --requireVerified=true` below finds
      // a fresh GREEN marker keyed to the commit this gate just verified.
      const r = node('scripts/verify-lane.mjs', ['--json'], { cwd: dir, env: laneEnv, timeout: GATE_TIMEOUT_MS });
      return { pass: r.ok, output: r.out.slice(-12000), failureDetail: r.ok ? null : gateFailureDetail(r.out) };
    },
    writePrBody: (dir, { num: n, worker: w, diff, taskType = 'doc-fix', declinedReason, proposedEdges = [] }) => {
      const bodyFile = join(dir, '.pr-body.md');
      writeFileSync(bodyFile, declinedReason ? [
        `Standalone worker declined #${n}; no implementation change.`, '',
        `> ${declinedReason}`, '',
        declinedReason.startsWith('scope exceeds')
          ? 'Implementation changes were discarded; the card is held for the builder with its scope preserved.'
          : 'The hold router removed scope and attached the finding. A prepare pass or human must re-scope the card.',
        'Full review is owed; parked review:pending.', '',
      ].join('\n') : [
        `${taskType} build on probation (${w.executor}/${w.model}) for #${n} (agy-launcher-probation, #4291).`,
        '',
        `Probation worker \`${w.id}\` built this item to spec via its own synchronous launcher, then the launcher`,
        `ran the gate, ${taskType === 'prepare' ? 'stamped the preparation' : 'resolved the item'} and committed. ${diff.files} file(s), ${diff.loc} line(s) changed —`,
        `within the proven \`${taskType}\` envelope.`,
        '',
        'Full review and a run rating are owed on this change; promotion out of probation stays an explicit',
        'human decision.',
        '',
        ...(proposedEdges.length ? [
          '## Proposed blockedBy changes — independent confirmation required (ruling #4670)',
          '',
          'The preparer proposed these edges in the card body; the card frontmatter is unchanged. The reviewer of this',
          'PR is the independent second actor: apply an edge to `blockedBy:` only if its file:line grounds hold.',
          '',
          ...proposedEdges.map((e) => e.line.startsWith('-') ? e.line : `- ${e.line}`),
          '',
        ] : []),
      ].join('\n'));
      return bodyFile;
    },
    openPr: ({ lanePath: dir, num: n, slug, attemptTag, bodyFile, taskType }) => {
      const r = node('scripts/operations/run.mjs', openPrArgv({ num: n, attemptTag, slug, bodyFile, taskType }), { cwd: dir, env: laneEnv });
      if (!r.ok) {
        const blockedOnInfra = /blocked-on-infra|outside dependency|network fault/i.test(r.out);
        return { ok: false, blockedOnInfra, reason: r.out.trim().slice(0, 1000) };
      }
      try {
        const submit = extractSubmitResult(JSON.parse(r.out));
        if (!submit?.pr) return { ok: false, blockedOnInfra: false, reason: `open-pr reported no PR number: ${r.out.slice(0, 500)}` };
        return { ok: true, pr: submit.pr, url: submit.url ?? null };
      } catch (e) {
        return { ok: false, blockedOnInfra: false, reason: `open-pr --json did not parse: ${e?.message ?? e}` };
      }
    },
    settlePrepare: settleDispatchEffect,
    appendScorecard: (row) => {
      // Best-effort: a lost trial row must never fail a build that worked.
      try { appendScorecardRow(row, { requireLock: true }); } catch (e) { console.error(`probation-build-run: scorecard row not written: ${e?.message ?? e}`); }
    },
  };
}

/** Refused before any process, mirroring `probation-heal-run.mjs`'s own script-existence discipline. */
export function assertRunnable() {
  if (!existsSync(join(WE_ROOT, 'scripts', 'operations', 'run.mjs'))) {
    throw new Error('probation-build-run: scripts/operations/run.mjs is not in this checkout');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    assertRunnable();
    const args = parseArgs(process.argv.slice(2));
    const result = await runProbationBuild(args, realIo({ session: args.session, runId: args.runId, taskType: args.taskType }));
    console.log(JSON.stringify(result));
    process.exitCode = result.outcome === 'opened-pr' || result.outcome === 'not-applicable' ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ outcome: 'escalated-needs-human', executor: 'none', pr: null, detail: String(e?.message ?? e) }));
    process.exitCode = 1;
  }
}
