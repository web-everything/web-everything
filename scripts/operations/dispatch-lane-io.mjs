import { conflictHelperAllowRules } from '../lib/conflict-helper-allow.mjs';
import { observeHealAttempt } from './probation-heal-run.mjs';
import { dispatchProviderAvailable } from '../lib/dispatch-provider-availability.mjs';
import { claudeSpawnAlias, resolvePolicyEffort } from '../lib/dispatch-routing-policy.mjs';
import { resolvePolicyModel, resolveOperationEffort, resolveOperationRoute, readRoutingPolicy, resolveDispatchRoute as decideDispatchRoute } from '../lib/dispatch-routing-policy-io.mjs';
import { meteredAlreadyDone, alreadyDoneRequest } from '../lib/gh-metered-reads.mjs';
import { readGitAlreadyDone } from '../lib/git-already-done.mjs';
/**
 * @file scripts/operations/dispatch-lane-io.mjs
 * @description THE IO SHELL of the `dispatch-lane` declaration (#3037, under epic #3029) — the tick reader its
 *   `read` step is injected with, the SINK that starts the agent, and the OBSERVER that later asks how it is
 *   going.
 *
 * WHY IT IS A SEPARATE FILE. {@link ./dispatch-lane.mjs} is the declaration: what the operation IS. This is the
 * only place it touches the world — the same pure-core / io-shell split {@link ./review-pr-io.mjs} uses, and
 * what lets the declaration be unit-tested with a stub reader and a stub spawner.
 *
 * EVERY BINDING HERE SHELLS SOMETHING THAT ALREADY EXISTS. Nothing in this file decides anything about a
 * dispatch:
 *   - the whole tick — guards, TTLs, lane exclusion, the re-dispatch gate, watcher arming — is ONE call to
 *     `we:scripts/conveyor/tick-core.mjs`, the same CLI the runner drives, with the caller's bookkeeping on
 *     STDIN exactly as the skill pipes it. Not `conveyor-state` + `dispatch-plan` re-composed here: that
 *     composition IS the tick core, and re-doing it is how a second, subtly different dispatcher gets born;
 *   - item identity is `normNum` (`we:scripts/conveyor/queue-store.mjs`) — the ONE normalizer the state read,
 *     the plan and the core all key on;
 *   - the item's slug and repo-qualified `scope:` come from the canonical backlog loader (`we:src/_data/backlog.js`),
 *     the same source `dispatch-plan.mjs` enriches its queue rows from;
 *   - the brief is whichever of the SIX authored mandates the launch's KIND names — the delivery brief for
 *     a build, `prepare-scope-agent-brief.md` / `prepare-decision-agent-brief.md` for a prepare (#3165), and
 *     `fix-agent-brief.md` / `fix-agent-ci-brief.md` for a fix / ci-heal repair (#3332) —
 *     read as text and filled by the declaration.
 *
 * THE SINK IS THE ONLY THING IN THIS REPO THAT STARTS AN AGENT. Read {@link createDispatchSinks} before
 * changing it — the handle contract lives there, and it is the reason a restart can still find the build.
 *
 * IMPURE by construction: `node`, `claude`, `fs`.
 */

// @cohesive: ONE operation's io boundary, which is what this repo's pure-core/io-shell pairing makes a single
// responsibility — `dispatch-lane.mjs` is the WHAT and this is the only place it touches the world, exactly as
// `review-pr.mjs` / `review-pr-io.mjs` are paired. The three things inside it (the tick READER the `read` step
// is injected with, the SINK that starts the agent, the OBSERVER that later asks how it is going) are the
// #3084 effect contract's own three halves for ONE effect type: they are registered under one `DISPATCH_EFFECT`
// string, they share the handle contract the sink's docblock owns, and every consumer imports them together.
// Splitting them into three modules would put one operation's io across three lane-lease scopes while leaving
// that contract split across them — fragmenting a cohesive file to hit a number, which #2678's own ruling says
// cohesion outranks.
//
// WHAT THIS MARKER DOES NOT EXCUSE, stated so it is not read as a blank cheque: the size+collision composite is
// telling the truth about the CONTENTION — 6 queued items name this file, and they do serialize on it. The
// answer to that is #3118's question of where headless spawning finally lives, not a split of the io shell
// underneath it. Added by #3165, which grew the file from 792 to 826 code lines past the 800 line.

import { withSalvageHint } from '../lib/salvage-index.mjs';
import { execFileSync } from 'node:child_process';
import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';
// #4415 (round 2) — live incident 2026-09-29: `defaultCheckAlreadyDone`/`defaultCheckAlreadyDoneAsync`/
// `defaultListPrs` below all defaulted to a bare, unattributed `execFileSync`/`execFile` — never
// `execFileSyncThrottled` — exactly the same defect this card's first round fixed in `lease-reaper.mjs` and
// `lane-pool.mjs`. This time the caller is `dispatch-plan.mjs`'s already-done pass
// (`Promise.all(staleQueueRows.map((row) => defaultCheckAlreadyDoneAsync(row.num)))`, UNBOUNDED concurrency,
// one `gh pr list --search "<NNN> in:title" --state merged` call PER stale item): measured live, ~80-100 of
// these ran SIMULTANEOUSLY in a single `ps aux` snapshot, none logged anywhere, spending the shared `graphql`
// bucket (8943 points/hour that hour, 6365.2 UNATTRIBUTED — `gh-spend.mjs report --hours=1 --by=caller`).
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readBuildDelivery, defaultListBuildPrs, defaultReadCardStatus, defaultReadCardOpened } from '../conveyor/build-delivery-evidence.mjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normNum } from '../conveyor/queue-store.mjs';
import { laneRefItemNum, laneRefAttemptTag, sessionSlugAttemptTag } from '../conveyor/lease-reaper.mjs';
import { parseSessionSlug } from '../conveyor/session-slug.mjs';
import { classifyPr } from '../conveyor/pr-watch.mjs';
import { deleteCompletion } from './completion-store.mjs';
// #4174 — the WORKSPACE root (the shared parent of every primary checkout AND `.lanes/`), so a dispatched
// session's cwd can be computed as a sibling of the checkout rather than a path inside it. Imported from the
// guard rather than re-derived, for the SAME reason `explore-io.mjs#exploreScratchRoot` imports it: the region
// a dispatched agent may legitimately write into and the region this file computes must be one definition.
import { workspaceRootOf } from '../guard-lane.mjs';
// #4174 live-caught (2026-09-25) — a scratch cwd is a BRAND NEW directory `claude` has never seen, and `--bg`
// refuses to start there ("Workspace not trusted") exactly like an interactive session would. A LANE clone
// never hits this because `bootstrap-session.mjs`'s own `trustStatus`/`withTrustedDirs` pre-trusts the whole
// (bounded, reused) lane pool once at machine setup. A fresh per-session scratch dir cannot be pre-trusted the
// same way — there is a new one every dispatch — so this file grants it DYNAMICALLY. Only the PURE pieces are
// imported (`readJsonConfig`/`withTrustedDirs`/`TRUST_PATH`) — never `defaultIo()`'s real writer, which has no
// override hook: {@link grantDispatchTrust} does its own tiny, env-relocatable write below (mirroring that
// writer's own backup-first discipline) so a test/soak world can point it at a throwaway file instead of the
// operator's real `~/.claude.json`, the same reason `dispatchSessionCwd` itself is relocatable via
// {@link DISPATCH_CWD_ENV}.
import { readJsonConfig, withTrustedDirs, withoutTrustedDirs, TRUST_PATH } from '../bootstrap-session.mjs';
// #4188 (bornAs x5qketq, epic #4075) — the atomic (temp-file + rename), validated writer {@link
// revokeDispatchTrust} uses. See that function's own doc for why a plain `writeFileSync` (this file's own
// `grantDispatchTrust`, below, still uses that) is not enough for a REMOVAL: reads that raced a torn write
// would corrupt this same operator-wide file for every OTHER repo's trust state too, not just this one entry.
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
// #3637 — the POC-branch registry, so an item's `deliveryTarget:` resolves against DECLARED branches only.
import { readRegistry as readPocRegistry, validateDeliveryTarget } from '../lib/poc-branches.mjs';
import { briefTokensForRepo, repoKeyForScope, deliveryLocusForScope } from '../lib/repo-profile.mjs';
import { buildGhShimSettingsEnv, sanitizeSpawnEnv, ensureSettingsFilePermissions } from '../lib/gh-app-shim.mjs';
// #x9fbg1x — turns OFF Claude Code's own background-session worktree-isolation guard for THIS dispatch's
// scratch cwd only (never the primary checkout, never a lane clone shared across dispatches) — see that
// module's own header for the full incident (fix-2748/fix-2770, 2026-09-26) and why the repo-wide tracked
// `.claude/settings.json` entry this replaces never reached a session once #4174 moved its start cwd to scratch.
import { DISPATCH_WORKTREE_SETTINGS, isolateDispatchSession } from '../lib/dispatch-bg-isolation.mjs';
import { assertMainNotStale, behindFiles, gitRun, isCodePath } from '../lib/main-staleness.mjs';
// #xrv69j6 — the pool-dir basenames a lane lives under (`web-everything` / `webeverything`), so the ONE lane
// a dispatch will use can be resolved to an absolute path the same way `bootstrap-session.mjs#poolRoots`
// already probes it, without re-deriving that table.
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { inFlight, notApplied } from './effect-executor.mjs';
import { createFileRunStore } from './run-store.mjs';
import { workerTierFor, PROBATION_WORKERS } from '../lib/provider-routing.mjs';
import { dispatchStillHolds, DEFAULT_EXPECTED_WITHIN_MINUTES, DISPATCH_EFFECT, DISPATCH_LISTING_GRACE_MINUTES, LAUNCH_KINDS } from './dispatch-lane.mjs';
// #3383 — the spawned session is a WORKER; a hook-driven tick-once must never run in it (see session-role.mjs).
import { markWorkerEnv, workerMarkerSettingsEnv } from './session-role.mjs';
// #3902 — the blocking-spawn primitive `spawnAgentToCompletion` (below) is built on, for the same reason
// `codex-delivery-provider.mjs#spawnCodexToCompletion` is (see that file's own header).
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';
// #3717/#3906 — the ROUTING DECISION's inputs are read HERE (io) and handed to the pure router as data: the
// scorecards (the shared store, #4155), the checked-in size policy (#3843), the checked-in promotion record
// (#3784) and the supervision-enforcement switch (OFF by default; turning it on is #4180). The decision itself
// is `dispatch-contracts.mjs#decideDispatchRoute`; `dispatch-lane.mjs`'s pure `shapeDispatchRead` owns its
// consequences (refuse on no route, hold on a supervision hold).
import { supervisionEnforcementFrom, CLAUDE_NATIVE_MODEL_BY_TIER } from '../lib/dispatch-contracts.mjs';
import { readStore as readScorecardStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
// #3840 — the ONE per-item provider override: the card's own `deliveryAgent:` marker and its required reason.
import { readItemDeliveryAgentOverride } from './delivery-agent-marker.mjs';
// #3645/#3906 — WHICH LAUNCH KINDS HAVE A MECHANICAL PROVIDER. Every row lands OFF on main (`agent`), see the
// registry's own header; {@link routeDispatchProvider} below is its only reader here.
import { DISPATCH_PROVIDER_REGISTRY, dispatchModesFromEnv, dispatchProviderEntry } from './dispatch-provider-registry.mjs';
// agy-launcher-probation — the probation-worker launcher (Codex / Antigravity-Claude / Antigravity-Gemini) for an
// opened, non-critical ci-heal. See {@link routeDispatchProvider}.
import {
  PROBATION_LAUNCHABLE_KINDS, probationLaunchDecision, probationLaunchFromEnv, probationWorkerDetachedProvider,
} from './dispatch-providers/probation-worker.mjs';
// #3645/#4212 — the detached-wrapper handle primitives. `defaultIsPidAlive`/`detachedHandlePid` let a `pid:<n>`
// handle (a mechanical build's own PID, not a `claude` session id) answer its own liveness from the KERNEL
// rather than from `claude agents --json`, which never heard of it; `deliveryDispatchLogPath` names where its
// narration went for the observer's `unresolved` message. See {@link isDispatchHandleLive}.
import { DETACHED_HANDLE_PREFIX, defaultIsPidAlive, deliveryDispatchLogPath, detachedHandlePid } from './detached-dispatch.mjs';
import { describeDispatchFailure } from '../lib/describe-spawn-failure.mjs';

/**
 * The three native Claude model ids {@link ../lib/dispatch-contracts.mjs#CLAUDE_NATIVE_MODEL_BY_TIER} maps to
 * — the only values #3857's `table` wiring below ever trusts as a `--model` for a `claude --bg` spawn. A
 * `decideDispatchRoute` record's `model` names a GEMINI or CODEX model id when the router recommended an
 * external provider — `executed` still runs Claude for any dispatch with no honoured `deliveryAgent:` override,
 * so that id would be the WRONG flag for THIS spawn. Filtering on membership, rather than trusting
 * `routed`/`executed`, excludes it with no separate branch.
 */
const CLAUDE_NATIVE_MODEL_IDS = new Set(Object.values(CLAUDE_NATIVE_MODEL_BY_TIER));

/**
 * THE `--model` A CLAUDE WORKER IS SPAWNED WITH, per tier (#3906, operator 2026-09-26): the CLI's own ALIASES,
 * never a pinned id. A pinned id silently DOWNGRADES a worker the day a newer model ships (the routing record's
 * `claude-opus-5` would run an older Opus than the operator's own `opus` default, Opus 5.5 today). An alias
 * always resolves to the current model of that tier. `CLAUDE_NATIVE_MODEL_BY_TIER` keeps naming the routing
 * record's `model` (the trust key trials are measured under); only the spawn flag is an alias. Fable is never a
 * tier here, and {@link resolveWorkerModel} still refuses it as a hand-set override.
 */
export const CLAUDE_SPAWN_MODEL_BY_TIER = Object.freeze({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' });

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root, resolved by SCRIPT LOCATION and never by cwd — same reason `run-store.mjs` does it. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** The mechanized tick core — one call, the whole per-tick state machine (`{ decisions, nextState }`). */
export function tickCli(root = REPO_ROOT) {
  return join(root, 'scripts', 'conveyor', 'tick-core.mjs');
}
// THE AGENT-BRIEF TEMPLATE the declaration fills, PER KIND (#3165 wired the first three, #3332 the last two).
//
// All briefs were authored well before any of them but the delivery brief was reachable: `briefPath` took
// no kind at all until #3165, so `prepare-scope-agent-brief.md` (15.7 KB) and `prepare-decision-agent-brief.md`
// (18 KB) sat unrouted while the planner kept surfacing prepares nobody could dispatch — and even after #3165
// added a kind argument, `fix-agent-brief.md` and `fix-agent-ci-brief.md` stayed unrouted for the SAME reason,
// because #3165 was a three-kind card (`'build' | 'prepare' | 'prepare-decision'`) and never claimed the other
// two, and #3567 added `investigate` (`investigation-agent-brief.md`). This map is the whole connection,
// now for all six.
//
// ONE FILE PER KIND, declared as data rather than as a string built from the kind: a computed name silently
// resolves to a path that does not exist, and `readText` would then fail with `ENOENT` on a filename instead
// of naming the kind nobody wired.
const BRIEF_BY_KIND = Object.freeze({
  build: 'delivery-agent-brief.md',
  prepare: 'prepare-scope-agent-brief.md',
  'prepare-decision': 'prepare-decision-agent-brief.md',
  'prepare-item': 'prepare-item-agent-brief.md',
  // #3567 — the investigation dispatch's own brief, parallel to the two prepare briefs above.
  investigate: 'investigation-agent-brief.md',
  fix: 'fix-agent-brief.md',
  'ci-heal': 'fix-agent-ci-brief.md',
});

// UNKNOWN KIND THROWS; it does NOT fall back to the delivery brief. Handing a scope-prep agent the delivery
// mandate tells it to BUILD an item whose scope is exactly what it was dispatched to write — it would acquire
// a lane, read an empty scope and improvise. A loud refusal costs one dispatch; the silent fallback costs a
// lane and a wrong PR.
/**
 * @param {string} [root]
 * @param {'build'|'prepare'|'prepare-decision'|'investigate'|'fix'|'ci-heal'} [kind] - defaults to `build`, so every
 *   pre-#3165 caller resolves the same path it always did.
 * @returns {string}
 */
export function briefPath(root = REPO_ROOT, kind = 'build') {
  const file = Object.prototype.hasOwnProperty.call(BRIEF_BY_KIND, kind) ? BRIEF_BY_KIND[kind] : null;
  if (!file) {
    throw new Error(
      `dispatch-lane-io: no agent brief for kind ${JSON.stringify(kind)} — it must be one of `
      + `${LAUNCH_KINDS.join(', ')}. Refusing to fall back to the delivery brief.`,
    );
  }
  return join(root, 'skills-src', 'conveyor', file);
}

/**
 * How long after `startedAt` a dispatched session that is NOT yet listed still reads as `running`.
 *
 * `claude --bg` returns before its session is necessarily visible to `claude agents`, and the observer's
 * "absent" branch is TERMINAL — so without a grace window the first poll after a dispatch could close out a
 * build that had not finished starting. Two minutes is far below any real build and far above process startup.
 *
 * DERIVED, not a second literal: this is the observer's copy of `DISPATCH_LISTING_GRACE_MINUTES`, and two
 * numbers that must agree are two numbers that eventually will not.
 *
 * THE GUARD NO LONGER SHARES IT. This sentence used to read "the double-dispatch guard needs the same window
 * in the pure half" — it did, and it does not any more. `dispatch-lane.mjs#dispatchStillHolds` reads its own
 * larger `DISPATCH_GUARD_LISTING_GRACE_MINUTES` on purpose, because the observer's wrong answer writes nothing
 * while the guard's starts a second agent in an occupied lane. The derivation above is still the right shape
 * for the OBSERVER's two constants; it just no longer spans both readers.
 */
export const LISTING_GRACE_MS = DISPATCH_LISTING_GRACE_MINUTES * 60 * 1000;

/**
 * READ ONE TICK and select this item's row. The `readTick` the declaration is injected with.
 *
 * Reuses a valid caller-supplied tick or makes ONE `tick-core` call. Its STDIN is the caller's
 * session-ephemeral bookkeeping — read from `bookkeepingFile` when given, `{}` otherwise.
 * The file is the CALLER'S (the runner's `nextState`); this function neither
 * creates nor writes one, so no parallel state store comes into existence (#2612).
 *
 * @param {object} o
 * @param {string|number} o.num - the item to dispatch.
 * @param {string} [o.bookkeepingFile] - path to the caller's `{ bookkeeping, signals, config }` JSON.
 * @param {string} [o.tickFile] - optional `{ at, bookkeepingHash, tick }` handoff, valid for under five minutes.
 * @param {string} [o.root]
 * @param {Function} [o.runNode] - injectable `(argv, opts) => stdout`, so the reader is testable without a tick.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT `runNode` goes through. Separate from
 *   `runNode` on purpose: overriding `runNode` replaces the production path, while overriding `exec` EXERCISES
 *   it, which is the only way a test can assert the options (the timeout) it builds — see F5/F12 in the PR
 *   #1211 review, where a tested default reached by nothing was the whole defect.
 * @param {Function} [o.readText] - injectable file reader.
 * @param {Function} [o.loadItems] - injectable backlog loader.
 * @param {() => Date|number} [o.now] - injectable clock; stamps `observedAt`, which is how the pure declaration ages
 *   its double-dispatch guard out without reading a clock of its own.
 * @param {() => object[]} [o.listAgents] - injectable `claude agents --json` reader. The double-dispatch
 *   guard's PRIMARY axis is liveness, not age (PR #1211 round 2, G1), so the read asks the same question the
 *   observer asks and stamps the answer onto each in-flight row.
 * @param {(stamped: object) => object} [o.recordLiveness] - the write-back hook. Defaults to
 *   {@link persistLastSeenLive}, which stamps `lastSeenLiveAt` onto every entry this read just confirmed
 *   alive. A seam, not decoration: it is the one WRITE on an otherwise read-only path, and a test that wants
 *   the read without touching a run store overrides it with the identity.
 * @param {(pr: string|number) => (string|null)} [o.laneRefForPr] - injectable `gh pr view --json headRefName`
 *   reader (#3332). Defaults to {@link defaultLaneRefForPr}. Called ONLY for a `fix`/`ci-heal` launch that
 *   carries a `pr` — see the call site below for why it is this lazy.
 * @param {(num: string) => {done: boolean, pr: object|null, checked: boolean}} [o.checkAlreadyDone] -
 *   injectable ALREADY-DONE ground-truth reader (#3457/#3460). Defaults to {@link defaultCheckAlreadyDone}.
 *   Called ONLY when the core actually cleared this item for SOME launch — see the call site below for why.
 * @returns {{launch: object|null, launchKind: 'build'|'prepare'|'prepare-decision'|'investigate'|'fix'|'ci-heal', suppressed: object|null, resolvedNum: string, item: object|null, briefTemplate: string, nextState: object, statusLine: string, notes: object[], bookkeepingSource: string, observedAt: string, laneRef: (string|null), alreadyDone: {done: boolean, pr: object|null, checked: boolean}}}
 */
export function readTick({
  num,
  bookkeepingFile = '',
  tickFile = '',
  root = REPO_ROOT,
  // #4415 round 2 — this `exec` feeds `checkAlreadyDone`/`laneRefForPr`/`listAgents` below, ALL of which
  // shell `gh` (or `claude`) directly with whatever this default is; it must be `execFileSyncThrottled`, never
  // a bare `execFileSync`, or fixing those functions' OWN internal defaults is moot the moment `readTick`
  // passes an explicit `{ exec }` override into them (which it always does, right below).
  exec = execFileSyncThrottled,
  runNode = (argv, opts) => defaultRunNode(argv, opts, { exec }),
  readText = (path) => readFileSync(path, 'utf8'),
  loadItems = () => defaultLoadItems(root),
  listInFlightDispatches = (key) => inFlightDispatchesFor(key),
  listAgents = () => defaultListAgents({ exec }),
  // #3645/#4212 — see {@link isDispatchHandleLive}: a mechanical build's handle is a pid, not a `claude`
  // session id, so the double-dispatch guard's liveness read needs a kernel probe too, not only a listing.
  isPidAlive = defaultIsPidAlive,
  recordLiveness = (stamped) => { persistLastSeenLive(stamped, { now }); return stamped; },
  laneRefForPr = (pr) => defaultLaneRefForPr(pr, { exec }),
  checkAlreadyDone = (n) => defaultCheckAlreadyDone(n, { exec }),
  // xykwe0h — build only: an OPEN or MERGED build PR, or a resolved card, means the build must not run again.
  checkBuildDelivery = (n) => readBuildDelivery(n, { listPrs: (k) => defaultListBuildPrs(k, { exec, cwd: root }), readCardStatus: (k) => defaultReadCardStatus(k, { cwd: root }), readCardOpened: (k) => defaultReadCardOpened(k, { cwd: root }) }),
  // #3717 — THE ROUTER'S EVIDENCE. `selectProvider`/`selectSupervisionLevel` are pure and read their trial
  // history from their caller, so the scorecards are loaded at this io edge and handed across as data. A
  // missing or unreadable store reads as NO trials, which is the fail-closed direction: with no clean trials
  // the cascade can never find a non-Claude provider fit and resolves to Claude.
  readScorecards = () => defaultReadScorecards(),
  // #3843 (#3801 Fork 4 (b)) — the checked-in unsized-card size policy, read at this same io edge.
  readSizePolicy = () => defaultReadSizePolicy({ root, readText }),
  // #3784 (rule 6 of #3690) — the checked-in supervision-promotion record, read at this same io edge.
  readPromotions = () => defaultReadPromotions({ root, readText }),
  // #3717 step 3 — supervision is RECORDED, not enforced, unless `WE_DISPATCH_SUPERVISION_ENFORCE` says so.
  // Off by default on main; turning it on by default is #4180's own card.
  enforceSupervision = supervisionEnforcementFrom(process.env),
  // #3840 (Fork 5 of #3801) — THE ONE PROVIDER OVERRIDE: the item's own `deliveryAgent:` frontmatter marker and
  // its REQUIRED `deliveryAgentReason:`, read from the item's file. See `overrideHonoured` below for when it is
  // handed to the router.
  readDeliveryAgentOverride = (n) => readItemDeliveryAgentOverride(n, { root }),
  // #3906 — every registered kind's dispatch mode (`agent` unless its `modeEnv` says `mechanical`). Read here
  // only to decide whether a `deliveryAgent:` override CAN be honoured — see `overrideHonoured` below.
  dispatchModes = () => dispatchModesFromEnv(),
  now = () => new Date(),
  all = false,
  verbose,
} = {}) {
  const key = normNum(num);
  if (!all && !key) throw new TypeError(`dispatch-lane-io: \`num\` must be an item id, got ${JSON.stringify(num)}`);

  // THE CALLER'S BOOKKEEPING, or none. A missing file is a REFUSAL, not a silent fall back to `{}`: a caller
  // that named a file meant to dispatch under its live guards, and quietly dropping them is precisely the
  // double-dispatch the guards exist to prevent. Naming NO file is the honest guard-less mode, reported as
  // `bookkeepingSource: 'none'` all the way onto the verdict.
  let stdin = '{}';
  let bookkeepingSource = 'none';
  let droppedKeys = [];
  if (String(bookkeepingFile || '').trim()) {
    const forwarded = forwardableBookkeeping(readText(bookkeepingFile));
    stdin = forwarded.stdin;
    droppedKeys = forwarded.dropped;
    bookkeepingSource = 'file';
  }
  // Bind the handoff to the exact forwardable input, before diagnostic config changes it.
  const bookkeepingHash = createHash('sha256').update(stdin).digest('hex');

  // An explicit verbose setting bypasses tick-core's read-and-advance of the
  // persisted diagnostic window. Read-only reports must supply false.
  if (verbose != null) {
    const payload = JSON.parse(stdin);
    stdin = JSON.stringify({ ...payload, config: { ...payload.config, verbose } });
  }

  // Local run-store lookup precedes the full planner. Only probe agents when a row exists.
  // Re-read each invocation: terminal settlement invalidates this hold without a timer.
  const inFlight = all ? null : recordLiveness(stampLiveness(listInFlightDispatches(key), { listAgents, isPidAlive }));
  const observedAt = new Date(now()).toISOString();
  if (inFlight?.runs?.some(r => dispatchStillHolds(r, observedAt))) {
    return { resolvedNum: key, launch: null, suppressed: null, nextState: JSON.parse(stdin).bookkeeping ?? {},
      bookkeepingSource, droppedBookkeepingKeys: droppedKeys, inFlightDispatches: inFlight, observedAt };
  }
  let tick;
  if (tickFile && !all) {
    try {
      const file = JSON.parse(readText(tickFile));
      const age = Date.parse(observedAt) - Date.parse(file.at);
      if (age >= -60_000 && age < 5 * 60_000 && file.bookkeepingHash === bookkeepingHash
        && file.tick && typeof file.tick === 'object' && !Array.isArray(file.tick)) {
        tick = file.tick;
      }
    } catch { /* An unavailable or malformed handoff falls back to the planner. */ }
  }
  if (!tick) {
    try {
      tick = JSON.parse(String(runNode([tickCli(root)], { cwd: root, input: stdin })));
    } catch (e) {
      const msg = String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || 'tick-core failed';
      throw new Error(`dispatch-lane-io: could not read the conveyor tick — ${msg}`);
    }
  }
  const decisions = tick && typeof tick.decisions === 'object' && tick.decisions ? tick.decisions : {};
  if (all) {
    if (!tick?.decisions?.admission) {
      throw new Error('dispatch-lane-io: tick has no admission evidence for the whole queue');
    }
    const evidence = tick.decisions.admission;
    const keys = [...new Set([
      ...evidence.queue.filter((row) => row.buildQueued),
      ...(evidence.cleared ?? []), ...evidence.held, ...evidence.planned,
    ].map((row) => normNum(row.num)).filter(Boolean))];
    const items = loadItems();
    const observedAt = now();
    // #3906 — the routing inputs are read ONCE for the whole report, like the tick and the item corpus: every
    // row is routed against the same evidence.
    const once = (read) => { let done = false; let value; return () => { if (!done) { value = read(); done = true; } return value; }; };
    const scorecardsOnce = once(readScorecards);
    const sizePolicyOnce = once(readSizePolicy);
    const promotionsOnce = once(readPromotions);
    const modesOnce = once(dispatchModes);
    const tickJson = JSON.stringify(tick);
    const texts = new Map();
    if (String(bookkeepingFile || '').trim()) texts.set(bookkeepingFile, readText(bookkeepingFile));
    const cachedText = (path) => {
      if (!texts.has(path)) texts.set(path, readText(path));
      return texts.get(path);
    };
    let agentsRead = false;
    let agents;
    let agentsError;
    const cachedAgents = () => {
      if (!agentsRead) {
        agentsRead = true;
        try { agents = listAgents(); } catch (error) { agentsError = error; }
      }
      if (agentsError) throw agentsError;
      return agents;
    };
    // One tick and one item corpus for the entire report. Reuse the SAME selection and
    // guard reader for each id; never run a second scheduler or persist hypothetical guards.
    return keys.map((id) => readTick({
      num: id, root, exec, bookkeepingFile,
      runNode: () => tickJson, readText: cachedText, loadItems: () => items,
      listInFlightDispatches, listAgents: cachedAgents, isPidAlive, recordLiveness, laneRefForPr, checkAlreadyDone, checkBuildDelivery,
      readScorecards: scorecardsOnce, readSizePolicy: sizePolicyOnce, readPromotions: promotionsOnce,
      enforceSupervision, readDeliveryAgentOverride, dispatchModes: modesOnce,
      now: () => observedAt,
    }));
  }

  // `pr` is an OPTIONAL extra filter — every existing call site (the launch-list scan below, `suppressed`)
  // passes only `rows` and gets the original num-only match; `dispatchedGuard`'s fix/ci-heal branches are the
  // only callers that pass it (see the comment above that selection for why).
  const match = (rows, pr) => (Array.isArray(rows) ? rows : [])
    .find((r) => r && normNum(r.num) === key && (pr == null || Number(r.pr) === Number(pr))) || null;

  const item = findItem(key, loadItems);
  const nextState = tick && typeof tick.nextState === 'object' ? tick.nextState : null;
  // THE SELECTION happens here, with the tick's own normalizer — see the declaration's header for why it is
  // not in the pure half. SIX LISTS, not one (#3165 wired the first three; #3332 two more; #3567 the sixth): `planTick`
  // plans builds, both prepare kinds, AND fix/CI-heal repairs, and launching only a subset is why
  // `dispatch-lane --num=<an item planned for one of the unwired kinds>` did nothing at all while the
  // operator's status line kept promising it would.
  //
  // FIRST MATCH WINS, and no real tick makes that a decision — an item held as unscoped never reaches
  // `spawnBuilds`, a decision is never an unshaped build, and a fix/CI-heal repairs an existing PR a build
  // already opened, so the lists are disjoint by construction.
  const LAUNCH_LISTS = [
    ['build', decisions.spawnBuilds],
    ['prepare', decisions.spawnPrepareScope],
    ['prepare-decision', decisions.spawnPrepareDecision],
    ['prepare-item', decisions.spawnPrepareItems],
    ['investigate', decisions.spawnInvestigations],
    ['fix', decisions.spawnFixes],
    ['ci-heal', decisions.spawnCiHeals],
  ];
  let launch = null;
  let launchKind = 'build';
  for (const [kind, rows] of LAUNCH_LISTS) {
    const row = match(rows);
    if (row) { launch = row; launchKind = kind; break; }
  }

  // THIS launch's guard entry, picked out of the tick's guards with the same normalizer (#3332 extends the
  // #3165 lookup from two guard lists to four). The core records one per planned spawn: `buildGuards` for a
  // build, `prepareGuards` for either prepare kind (shared, so the match is keyed on `kind` too), and — new
  // here — `fixGuards` / `ciHealGuards`, each its OWN flat list rather than sharing one the way the two
  // prepare kinds do (`tick-core.mjs`'s `planFixSpawns`/`planCiHealSpawns` write `{ pr, num, lane, spawnedTick }`
  // rows straight onto `nextState.fixGuards` / `nextState.ciHealGuards`).
  //
  // FIX/CI-HEAL ALSO FILTER ON `pr`, and build/prepare deliberately do not. An item dispatches at MOST ONE
  // live build/prepare at a time, so `num` alone is never ambiguous there. But `fixGuards`/`ciHealGuards` are
  // flat lists that CAN legitimately hold two entries for the same item `num` against two DIFFERENT PRs — a
  // bounced item mid-build can leave a guard for an older PR sitting in the list while a newer PR gets its own
  // fix/ci-heal dispatched. Matching on `num` alone would pick whichever entry happens to be first, which is
  // not necessarily the one for `launch.pr` — the PR THIS dispatch is actually launching for. So these two
  // branches pass `launch?.pr` as `match`'s second argument to pin the match to that PR as well.
  const dispatchedGuard = launchKind === 'build'
    ? match(nextState?.buildGuards)
    : launchKind === 'fix'
      ? match(nextState?.fixGuards, launch?.pr)
      : launchKind === 'ci-heal'
        ? match(nextState?.ciHealGuards, launch?.pr)
        : (Array.isArray(nextState?.prepareGuards) ? nextState.prepareGuards : [])
          .find((g) => g && normNum(g.num) === key && (g.kind || 'prepare') === launchKind) || null;

  // THE PR's HEAD REF (`{{LANE_REF}}`), resolved ONLY when this launch is a `fix`/`ci-heal` AND actually carries
  // a `pr` (#3332). LAZY for the same cost-avoidance reason {@link inFlightDispatchesFor}'s own docblock states
  // for itself: a build/prepare/investigate dispatch — four launches out of six — pays no extra `gh pr view` subprocess for
  // a lookup it will never use, and this read sits synchronously inside a waker pass that promises to stay
  // fail-soft and fast per run.
  const laneRef = (launchKind === 'fix' || launchKind === 'ci-heal') && launch?.pr != null
    ? laneRefForPr(launch.pr)
    : null;

  // #3960 (multi-repo slice 4) — the repo-aware brief quintet (`{{REPO}}`/`{{LANE_REPO}}`/`{{GATE_COMMAND}}`/
  // `{{WE_ROOT}}`/`{{ATTRIBUTION}}`). Hardcoded to the `we` profile — this tick-core-driven launch list only
  // ever plans against the WE backlog/PR pool today (`tick-core.mjs#planFixSpawns`/`#planCiHealSpawns`/
  // `#planTick`'s other five spawn lists); a REAL per-repo selection here is multi-repo slice 5's job, not this
  // one's — this file stays correct for `we` now and has exactly one line to change once that lands.
  //
  // NO LONGER LAZY ON `launchKind` (#4174). Originally computed only for `fix`/`ci-heal`, because only THEIR
  // briefs referenced `{{WE_ROOT}}` — every OTHER kind's brief ran its one pre-lane command (`lane-pool.mjs
  // acquire`) with a RELATIVE path, which worked only because the sink spawned the session with `cwd: root`.
  // #4174 stopped doing that (a dispatched session's cwd is now a scratch directory outside `root`, so a stray
  // scratch file it writes before acquiring a lane can no longer dirty the dispatching checkout — see
  // `dispatchSessionCwd`'s own header) — so EVERY kind's brief now needs `{{WE_ROOT}}` for that one line, and
  // this read has to hand it to all six, not two. `briefTokensForRepo` is pure/fs-only (no subprocess), so
  // computing it unconditionally costs nothing worth gating.
  const repoTokens = briefTokensForRepo('we', { itemNum: key, prNum: launch?.pr ?? null });

  // #3457/#3460 — THE PRE-SPAWN GROUND-TRUTH CHECK, LAZY on the SAME reason `laneRef` above is: `launch` is
  // null on most reads (nothing cleared, or an in-flight guard already holds the item), and spending a `gh pr
  // list --search` call on a read that was never going to dispatch would violate the ratified cost discipline
  // ("one `gh pr list --search` call per dispatch ATTEMPT, not per tick" — Fork 2's bold default). ONE call per
  // `dispatch-lane --num=<N>` invocation THAT ACTUALLY HAS A LAUNCH TO CONSIDER is exactly that shape: every
  // invocation of this CLI already IS one dispatch attempt (it is never called on a tick cadence — see this
  // file's own header), so gating on `launch` alone (not also on `launchKind`) is deliberate: the motivating
  // `#3434` incident was a WASTED `prepare-decision` dispatch, not a build, so every launch kind needs the
  // check, not build/fix/ci-heal only.
  const alreadyDone = launch ? checkAlreadyDone(key) : { done: false, pr: null, checked: false };
  // xykwe0h — fail-soft: an unreadable delivery check never blocks a launch.
  let buildDelivery = null;
  if (launch && launchKind === 'build') { try { buildDelivery = checkBuildDelivery(key) ?? null; } catch { buildDelivery = null; } }

  // #3717/#3906 — THE ROUTING DECISION, computed only when something was cleared for launch (a read that will
  // not dispatch has nothing to route). Computed HERE rather than in the pure declaration: `decideDispatchRoute`
  // IS pure, but its import graph reaches `provider-routing.mjs` → `model-capability-ratings.mjs` → `node:fs`,
  // and `dispatch-lane.mjs` is asserted to reach nothing that can act. So the verdict crosses as DATA and the
  // pure half owns the consequence (`shapeDispatchRead` refuses a refused route and holds a supervision hold).
  //
  // THE `deliveryAgent:` OVERRIDE IS HONOURED ONLY WHERE IT CAN RUN (#3906 adaptation). The marker names a
  // non-Claude vendor (today every marker in the backlog says `codex`). Only a kind's MECHANICAL provider can
  // run that vendor (it passes `--provider=<marker>` to its wrapper); the `claude --bg` agent path cannot. Every
  // registry row lands in `agent` mode on main, so here the override is read and REPORTED
  // (`deliveryAgentOverride` below) but not handed to the router: routing it would record `executed: codex` for
  // a session Claude actually runs, and refuse the many markers that carry no reason, both of which would
  // change today's dispatch. Once a kind's row is `mechanical`, its markers route exactly as on the prototype.
  let routing = null;
  let deliveryAgentOverride = null;
  if (launch) {
    const override = readDeliveryAgentOverride(key);
    const overrideHonoured = Boolean(override) && dispatchModes()?.[launchKind] === 'mechanical';
    deliveryAgentOverride = override ? { ...override, honoured: overrideHonoured } : null;
    routing = decideDispatchRoute({
      kind: launchKind,
      // The tick has no CAUSE axis — `we:scripts/conveyor/reconcile-fix-dispatch.mjs` is the one dispatch path
      // that knows a bounce was conflict-caused, and it carries its own cause (#3717's table).
      cause: null,
      scopePaths: Array.isArray(item?.scope) ? item.scope : [],
      size: item?.size ?? null,
      designQuestion: item?.designQuestion, wellScoped: item?.wellScoped,
      risk: item?.risk ?? null,
      // #3857 — a `security` tag raises the worker to Opus; carried through `findItem` for this read.
      tags: Array.isArray(item?.tags) ? item.tags : [],
      taskKey: { storyRef: key, round: 1, taskId: launchKind },
      ...(overrideHonoured ? override : {}),
    }, {
      scorecards: readScorecards(),
      enforceSupervision: enforceSupervision === true,
      sizePolicy: readSizePolicy(),
      promotions: readPromotions(),
    });
  }

  return {
    resolvedNum: key,
    admission: tick.decisions?.admission ? {
      cleared: match(tick.decisions.admission.cleared),
      prepare: match(tick.decisions.admission.prepare),
      selection: match(tick.decisions.admission.selection)?.gates ?? [],
      queueRow: match(tick.decisions.admission.queue),
      held: match(tick.decisions.admission.held),
      planned: match(tick.decisions.admission.planned),
      gates: match(tick.decisions.admission.traces)?.gates ?? [],
    } : null,
    launch,
    // WHICH LIST IT CAME OUT OF. It picks the brief below, and the session slug and the lane scope in the
    // declaration — one answer, read three times, rather than three re-derivations that can disagree.
    launchKind,
    suppressed: match(decisions.suppressedBuilds),
    dispatchedGuard,
    item,
    briefTemplate: String(readText(briefPath(root, launchKind))),
    nextState,
    statusLine: String(decisions.statusLine || ''),
    notes: Array.isArray(decisions.notes) ? decisions.notes : [],
    // THE FIX/CI-HEAL LANE REF, or `null` for the three kinds that never need one — see above.
    laneRef,
    // #3960 / #4174 — the repo-aware brief quintet for EVERY kind now (`{{WE_ROOT}}` alone for the four
    // non-repair kinds; all five for fix/ci-heal) — or `null` when the `we` profile/gate could not be resolved
    // (fail-closed: `shapeDispatchRead` then has no value for `{{WE_ROOT}}` et al. and `fillBrief`'s own
    // required-value refusal stops the dispatch, exactly as a missing `laneRef` already does for `{{LANE_REF}}`).
    repoTokens,
    // #3457/#3460 — the ground-truth verdict, or the not-checked default when nothing was cleared for launch.
    alreadyDone,
    buildDelivery,
    // #3717/#3906 — the routing record (`decideDispatchRoute`'s answer), or `null` when nothing was cleared.
    routing,
    locus: launchKind === 'build' ? deliveryLocusForScope(item?.scope) : null,
    // #3840/#3906 — the item's `deliveryAgent:` override as read, with whether it was handed to the router.
    deliveryAgentOverride,
    // #3857/#3906 — the worker model the tier table plans for this dispatch (`{tier, model, reason}`), or
    // `null` when no `--model` would be injected. The sink applies the same table; a reasoned hand-set
    // `--model` in `WE_DISPATCH_AGENT_ARGS` can still replace it there (and is recorded as `source: override`).
    plannedWorkerModel: workerModelTable(routing),
    bookkeepingSource,
    droppedBookkeepingKeys: droppedKeys,
    // THIS OPERATION'S OWN in-flight dispatches for the item — see {@link inFlightDispatchesFor} — each row
    // carrying the live/gone/unknown answer {@link stampLiveness} got for its handle.
    // Recheck after planning as another dispatcher may have launched during that read.
    inFlightDispatches: recordLiveness(stampLiveness(listInFlightDispatches(key), { listAgents, isPidAlive })),
    // WHEN THIS READ WAS TAKEN. The declaration ages the double-dispatch guard out (`dispatchStillHolds`) and
    // is pure, so the clock has to arrive as DATA rather than be read there. Omitted or unparseable → nothing
    // ages out and every in-flight record holds, which is the fail-closed direction.
    observedAt: new Date(now()).toISOString(),
  };
}

/**
 * The default `node` runner for the tick read — a named export rather than an inline default so the OPTIONS it
 * passes are reachable by a test. They were not: every test overrode `runNode`, so the timeout below could be
 * deleted with the whole suite green (PR #1211 review, F5), and a fix no test asserts is a fix the next
 * refactor removes for free. Same reason for {@link defaultSpawnAgent}.
 *
 * @param {string[]} argv
 * @param {object} [opts] - merged last, so a caller can still override.
 * @param {{exec?: Function}} [io] - the `execFileSync`-shaped call, injected ONLY so the opts can be asserted.
 * @returns {string}
 */
export function defaultRunNode(argv, opts = {}, { exec = execFileSync } = {}) {
  return exec(process.execPath, argv, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: TICK_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts,
  });
}

/**
 * #3717 — THE SCORECARDS READ, as its own named export for the same reason {@link defaultRunNode} is: the
 * SOURCE it reads and the fail-closed shape of a bad read are the whole point.
 *
 * #3906 adaptation: the prototype read the tracked `scripts/conveyor/run-scorecards.json`; main moved the trial
 * history to ONE shared store outside every git tree (#4155), so this reads through that store's own reader
 * (`run-scorecard-store.mjs#readStore`, which never throws). Anything unusable yields `[]` — NO trials — which
 * is fail-closed here: with no clean verified trials the cascade can never find a non-Claude provider fit.
 *
 * READ-ONLY BY CONSTRUCTION: the store path is passed EXPLICITLY, which is what makes `readStore` skip its
 * one-time legacy migration (a WRITE). A dispatch read must never write the shared trial history.
 *
 * @param {{readStore?: () => {records?: unknown}}} [io]
 * @returns {Array<object>} the records, or `[]`.
 */
export function defaultReadScorecards({ readStore = () => readScorecardStore({ path: resolveScorecardStorePath() }) } = {}) {
  try {
    const records = readStore()?.records;
    return Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * #3843 (#3801 Fork 4 (b)) — THE CHECKED-IN SIZE POLICY, `we:scripts/lib/dispatch-size-policy.json`, read at
 * this io edge and handed across as data. A missing or unreadable file returns `null`, which
 * `decideDispatchRoute`'s `validateSizePolicy` resolves field by field to `DEFAULT_SIZE_POLICY` — so a broken
 * read is byte-identical to the defaults rather than a refused route.
 *
 * @param {{root?: string, readText?: (p: string) => string}} [io]
 * @returns {object|null} the parsed setting, or `null`.
 */
export function defaultReadSizePolicy({ root = REPO_ROOT, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const parsed = JSON.parse(String(readText(join(root, 'scripts', 'lib', 'dispatch-size-policy.json'))));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * #3784 (rule 6 of #3690) — THE CHECKED-IN PROMOTION RECORD, `we:scripts/lib/dispatch-supervision-promotions.json`,
 * read the same way {@link defaultReadSizePolicy} reads its own file. A missing or unreadable file returns
 * `null`, which `validatePromotions` treats as invalid and fails CLOSED to NO promotions (every computed
 * `spot-check` is recorded as `full`) rather than refusing the route.
 *
 * @param {{root?: string, readText?: (p: string) => string}} [io]
 * @returns {object|null} the parsed record, or `null`.
 */
export function defaultReadPromotions({ root = REPO_ROOT, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const parsed = JSON.parse(String(readText(join(root, 'scripts', 'lib', 'dispatch-supervision-promotions.json'))));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * EVERY RUN THIS OPERATION HAS LEFT IN FLIGHT for one item, read out of the run store.
 *
 * WHY THIS EXISTS, given the tick core already has an in-flight build guard. That guard lives in the CALLER'S
 * session bookkeeping, and `bookkeepingFile` defaults to empty — so the plain command-line invocation runs with
 * NO guards, and running it twice inside the spawn→claim window yields the same `spawnBuilds` row twice: two
 * agents in one lane clone, racing one working tree, both opening a PR. Neither run holds the lane, because the
 * AGENT leases it (the brief's first step), several seconds later.
 *
 * IT RE-DERIVES NOTHING. The tick core's guard is about the conveyor's session; this is about THIS operation's
 * own records, which are durable and which no tick has ever read. It answers one question — "did I already
 * start an agent for this item and never see it finish?" — from the only place that can answer it after a
 * restart.
 *
 * FAIL-SOFT PER RECORD, and the trade is stated: one unreadable run record is skipped rather than blocking
 * every dispatch (the store REFUSES a corrupt record, so one bad file would otherwise wedge the whole
 * operation), and the count of skipped records rides the result so a caller can see the guard was partial. It
 * rides it all the way onto the VERDICT as `unreadableRunRecords` — the first version of this sentence was a
 * claim wider than the code, because the count reached `shapeDispatchRead` and was dropped there (PR #1211
 * review, F4).
 *
 * `expectedBy` rides each row for the same kind of reason: the declaration ages a stale hold out
 * (`dispatchStillHolds`), and it cannot do that without the deadline the sink recorded.
 *
 * @param {string} key - the NORMALIZED item id.
 * @param {{store?: {list: Function, read: Function}}} [o]
 * @returns {{runs: Array<{runId: string, key: string, handle: (string|null), startedAt: (string|null), expectedBy: (string|null)}>, unreadable: number}}
 */
export function inFlightDispatchesFor(key, { store = createFileRunStore() } = {}) {
  const runs = [];
  let unreadable = 0;
  let ids;
  try { ids = store.list(); } catch { return { runs, unreadable: 0 }; }
  for (const id of Array.isArray(ids) ? ids : []) {
    let run;
    try { run = store.read(id); } catch { unreadable += 1; continue; }
    for (const e of (run && Array.isArray(run.effects) ? run.effects : [])) {
      if (e?.status !== 'in-flight' || e.type !== DISPATCH_EFFECT) continue;
      if (normNum(e.payload?.num) !== key) continue;
      runs.push({
        runId: String(run.id), key: String(e.key), handle: e.handle ?? null,
        startedAt: e.startedAt ?? null, expectedBy: e.expectedBy ?? null,
        // WHEN A LISTING LAST CONFIRMED THIS ONE ALIVE. `dispatchStillHolds` ages a `live: false` reading from
        // here rather than from `startedAt`, so it has to ride the row for the same reason `expectedBy` does:
        // the declaration is pure and can only use what it is handed. Absent on any entry never yet seen
        // alive, and the guard falls back to `startedAt` there.
        lastSeenLiveAt: e.lastSeenLiveAt ?? null,
      });
    }
  }
  return { runs, unreadable };
}

/**
 * ONE session-id comparison, shared by all three readers of `claude agents --json`.
 *
 * DRIFT-DEFENCE, NOT AN OBSERVED BUG. CLI **2.1.246** emits every `sessionId` as a lower-case v4 UUID — that
 * was measured, not assumed (14 rows, 14 lower-case, {@link file://./__fixtures__/claude-agents-payload.json}),
 * and the same shape was seen in the prepare's 19-row listing. So no case or whitespace mismatch has ever been
 * seen, and this normalization fixes nothing that is broken today. It is here because of what the CURRENT
 * exact match would cost if a later CLI ever echoed the id back in a different case: every handle would miss
 * its own row, every dispatch would read `live: false`, and the guard would hand the same lane to a SECOND
 * agent. A comparison whose failure mode is a double-dispatch is worth making shape-independent while it is
 * free (PR #1211 round-3 review, H1 case G).
 *
 * BOTH SIDES, ALWAYS. Normalizing only the listing would leave a stored handle's own case free to break it.
 *
 * @param {unknown} x
 * @returns {string} the comparable form, `''` when there is nothing usable to compare.
 */
export function normalizeHandle(x) {
  return String(x ?? '').trim().toLowerCase();
}

/**
 * THE USABLE SESSION IDS in a `claude agents --json` listing, normalized for comparison.
 *
 * The listing carries THREE element shapes in one response — measured, see the fixture: rows with
 * `cwd+id+kind+name+sessionId+startedAt+state`, rows that add `pid+status+waitingFor`, and rows carrying
 * neither `state` nor `status` nor `id` at all. `sessionId` is the ONE field present on every one of them.
 *
 * BOTH `sessionId` AND `id` ARE COLLECTED (#3331). Until this change only `sessionId` was, on the reasoning
 * that `id` "is absent from half the listing and is NOT reliably the `sessionId` prefix, so nothing should key
 * off it". The first half is true and harmless — an absent `id` simply contributes nothing — and the second
 * half is beside the point now, because nothing DERIVES an `id`: the short id a handle is compared against is
 * the one `claude --bg` PRINTED for that very session ({@link parseBackgroundedId}), not a prefix guessed off
 * a uuid. Collecting it is what makes a real, CLI-assigned handle findable at all; see {@link buildAgentArgv}
 * for why the handle can no longer be a minted uuid. Widening the set cannot produce a false `live: true` for
 * a minted uuid either — a 36-char uuid never equals an 8-char short id.
 *
 * An EMPTY result from a NON-EMPTY listing is the signal the callers act on: the response parsed, and not one
 * element yielded an id — which is a shape this code does not understand, not a machine with no agents on it.
 *
 * @param {unknown[]} sessions
 * @returns {Set<string>}
 */
export function listedSessionIds(sessions) {
  const ids = [];
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    for (const field of ['sessionId', 'id']) {
      const v = normalizeHandle(s?.[field]);
      if (v) ids.push(v);
    }
  }
  return new Set(ids);
}

/**
 * IS `handle` ONE OF THE SESSIONS IN THIS LISTING — the ONE comparison both {@link stampLiveness} and {@link
 * createDispatchObservers} used to inline separately. Extracted so the two readers cannot drift, and so {@link
 * isDispatchHandleLive} has a `claude`-listing question to compose with the pid one.
 *
 * @param {unknown} handle
 * @param {unknown[]} sessions
 * @returns {boolean}
 */
export function isHandleListed(handle, sessions) {
  const h = normalizeHandle(handle);
  if (!h) return false;
  return listedSessionIds(sessions).has(h);
}

/**
 * THE ONE LIVENESS QUESTION, for BOTH handle shapes — a `claude --bg` session id (asked of the agent listing via
 * {@link isHandleListed}, as before #3645) and a detached-wrapper `pid:<n>` handle (asked of the kernel via
 * {@link ../detached-dispatch.mjs#defaultIsPidAlive}). Every reader that used to compare a handle against a
 * listing directly now calls this instead, so the two shapes cannot drift out of an io-shell read that composes
 * a moved primitive (`detachedHandlePid`) with an io-shell read (`isHandleListed`, the `claude agents` listing).
 *
 * @param {unknown} handle
 * @param {unknown[]} sessions - a `claude agents --json` listing; IGNORED for a `pid:` handle.
 * @param {{isPidAlive?: (pid: number) => boolean}} [io]
 * @returns {boolean}
 */
export function isDispatchHandleLive(handle, sessions, { isPidAlive = defaultIsPidAlive } = {}) {
  const pid = detachedHandlePid(handle);
  if (pid !== null) return Boolean(isPidAlive(pid));
  return isHandleListed(handle, sessions);
}

/**
 * ASK `claude agents --json` WHETHER EACH IN-FLIGHT DISPATCH IS STILL ALIVE, and stamp the answer onto its row.
 *
 * WHY THE GUARD NEEDS THIS AT ALL (PR #1211 round 2, G1). The double-dispatch guard used to release a record
 * purely on wall-clock age, on the reasoning that an entry past its deadline "either finished or died". The
 * observer's other answer is `running`, and nothing bounds it — a background session stalled on a permission
 * prompt is alive, holds no lane lease and has claimed no item, so the tick core sees a clear row and the
 * clock-only guard hands out the same lane to a SECOND agent. Liveness is the axis that answers the question
 * the guard is actually asking; age is only the backstop for a record nothing can be observed about.
 *
 * THE THREE ANSWERS, and why an absent one is not silence:
 *   - `live: true` — the handle is in the listing. `dispatchStillHolds` holds it at any age.
 *   - `live: false` — the listing was read and this handle is not in it. Ages out once past the listing grace.
 *   - `live: null` — the row has no handle (an INDETERMINATE dispatch), or the listing could not be read at
 *     all. Falls to the clock backstop, and `livenessSource: 'unreadable'` rides the read onto the VERDICT so
 *     a weaker guard never looks like the strong one.
 *
 * ONE LISTING PER READ, and NONE when there is nothing in flight — the common case is an item with no open
 * dispatch, and shelling `claude` to ask about zero handles would put a subprocess on every dispatch path.
 *
 * IT NEVER THROWS. A `claude` that is missing, wedged or answering nonsense degrades the guard to its clock
 * backstop and says so; it must not take down a dispatch read, which is also the tick read.
 *
 * @param {{runs?: object[], unreadable?: number}} inFlight - what {@link inFlightDispatchesFor} returned.
 * @param {{listAgents?: () => object[], isPidAlive?: (pid: number) => boolean}} [o]
 * @returns {{runs: object[], unreadable: number, livenessSource: 'claude-agents'|'unreadable'|'not-needed'|'wrapper-pid'}}
 */
export function stampLiveness(inFlight, { listAgents, isPidAlive = defaultIsPidAlive } = {}) {
  const rows = Array.isArray(inFlight?.runs) ? inFlight.runs : [];
  const unreadable = Number(inFlight?.unreadable) > 0 ? Number(inFlight.unreadable) : 0;
  if (!rows.length) return { runs: [], unreadable, livenessSource: 'not-needed' };

  // #3645/#4212 — A MECHANICAL BUILD'S HANDLE IS A PID, AND THE KERNEL ANSWERS IT. When EVERY row in flight is
  // one of those, no `claude agents` listing is needed at all — and asking for one would mean an unreadable or
  // absent `claude` degraded a pid probe that cannot fail into `livenessSource: 'unreadable'`, i.e. the strong
  // answer reported as the weak one. Same reason the listing is skipped for zero rows above: do not shell
  // `claude` to ask about handles it has never heard of.
  if (rows.every((r) => !r.handle || detachedHandlePid(r.handle) !== null)) {
    return {
      runs: rows.map((r) => ({ ...r, live: r.handle ? isDispatchHandleLive(r.handle, [], { isPidAlive }) : null })),
      unreadable,
      livenessSource: 'wrapper-pid',
    };
  }

  let sessions = null;
  try {
    sessions = typeof listAgents === 'function' ? listAgents() : null;
  } catch {
    sessions = null;
  }
  if (!Array.isArray(sessions)) {
    return { runs: rows.map((r) => ({ ...r, live: null })), unreadable, livenessSource: 'unreadable' };
  }
  const listed = listedSessionIds(sessions);
  // A NON-EMPTY LISTING THAT YIELDED NOTHING MATCHABLE IS A READ THAT FAILED, not a world with no agents in
  // it. Falling through to the compare below would stamp `live: false` on EVERY row from a listing whose shape
  // this code did not understand — and `live: false` is the one answer that lets the guard release a lane, so
  // the weakest possible read would produce the most permissive possible verdict while still reporting
  // `livenessSource: 'claude-agents'`, the label for "checked against a real listing and found clear". Degrade
  // to the same `unreadable` answer the not-an-array branch gives (PR #1211 round-3 review, H1/H2).
  //
  // GATED ON `sessions.length`, and that gate is load-bearing. A genuinely EMPTY listing is a read that
  // SUCCEEDED and found nothing running — the ordinary state of an idle machine — and must still stamp
  // `live: false`. Only elements-in, ids-out is the shape nobody understands.
  if (sessions.length && !listed.size) {
    return { runs: rows.map((r) => ({ ...r, live: null })), unreadable, livenessSource: 'unreadable' };
  }
  return {
    // #3645/#4212 — through {@link isDispatchHandleLive}, so a MIXED set (an agent-path dispatch and a
    // mechanical one in flight at once) answers each row with the right question. A `pid:` row never consults
    // `sessions`.
    runs: rows.map((r) => ({ ...r, live: r.handle ? isDispatchHandleLive(r.handle, sessions, { isPidAlive }) : null })),
    unreadable,
    livenessSource: 'claude-agents',
  };
}

/**
 * STAMP `lastSeenLiveAt` BACK ONTO EVERY EFFECT ENTRY A LISTING READ JUST CONFIRMED ALIVE.
 *
 * WHY THIS HAS TO BE PERSISTED AT ALL. {@link stampLiveness}'s answer lives for one read. The guard that acts
 * on it (`dispatch-lane.mjs#dispatchStillHolds`) is pure and sees only what rides the row, so without a
 * durable record of "a real listing said `true` at this instant" the only age it can measure is the age of the
 * DISPATCH — and a build that has been running for an hour is then one bad read away from having its lane
 * released, because an hour is past any grace window. The confirmation is the thing worth remembering.
 *
 * IT IS `last`, NOT `first`. Every confirmation overwrites: the property being bought is *"a bad read arriving
 * right after a real seen-alive cannot release the item"*, and only the MOST RECENT confirmation can buy it.
 * Stamping once and never again would leave a long-lived agent anchored on a timestamp from its first minute,
 * which is the `startedAt` failure this replaces wearing a different field name.
 *
 * BEST-EFFORT, AND SILENT ON FAILURE — deliberately. This is a bookkeeping improvement on a READ path that is
 * also the dispatch path; a store that cannot be written must not take down the dispatch read. The cost of the
 * write not landing is the previous behaviour (the guard falls back to `startedAt`), which is fail-closed in
 * the direction that matters: a missing anchor makes the guard age from an EARLIER instant, so it releases
 * sooner, never later than before this change.
 *
 * ONLY `live === true` IS WRITTEN. `false` and `null` are the answers this field exists to survive; recording
 * them would defeat it.
 *
 * @param {{runs?: object[]}} stamped - what {@link stampLiveness} returned.
 * @param {{store?: {read: Function, write: Function}, now?: () => Date}} [o]
 * @returns {number} how many entries were stamped — for tests and for a caller that wants to say so.
 */
export function persistLastSeenLive(stamped, { store = createFileRunStore(), now = () => new Date() } = {}) {
  const rows = (Array.isArray(stamped?.runs) ? stamped.runs : []).filter((r) => r?.live === true && r.runId);
  if (!rows.length) return 0;
  const at = now().toISOString();
  let written = 0;
  for (const runId of new Set(rows.map((r) => String(r.runId)))) {
    const keys = new Set(rows.filter((r) => String(r.runId) === runId).map((r) => String(r.key)));
    try {
      const run = store.read(runId);
      const effects = run && Array.isArray(run.effects) ? run.effects : null;
      if (!effects) continue;
      let touched = false;
      for (const e of effects) {
        if (e?.status !== 'in-flight' || e.type !== DISPATCH_EFFECT || !keys.has(String(e.key))) continue;
        e.lastSeenLiveAt = at;
        touched = true;
        written += 1;
      }
      if (touched) store.write(run);
    } catch { /* see BEST-EFFORT above — a store that will not take the note is not a reason to fail the read. */ }
  }
  return written;
}

/**
 * NARROW the caller's bookkeeping to the part that may reach the tick core. Returns the STDIN text plus the
 * keys that were dropped.
 *
 * WHY ANYTHING IS DROPPED. `tick-core`'s shell reads four things off STDIN, and only one of them is
 * bookkeeping: `bookkeeping`, `signals`, `config` and `lastOperatorTurn`. `config` sets `buildTtlTicks`,
 * `fixRetryCap` and friends; `signals.returnedBuildNums` retires live build guards outright. So piping the file
 * through verbatim would let whoever writes it dial the very holds this operation exists to inherit — a file
 * carrying `{"config":{"buildTtlTicks":0}}` retires every build guard on the spot and clears a lane that
 * already has an agent on it. The declaration says a guard rule must not live in this file; forwarding a knob
 * that overrides one is the same defect wearing a different hat.
 *
 * DROPPING `signals` IS CONSERVATIVE; DROPPING `config` IS NOT, and the first version of this note claimed both
 * were. `signals.returnedBuildNums` only ever RETIRES guards, so losing it keeps them live longer and dispatches
 * less. `config` cuts both ways: a caller running `buildTtlTicks: 10` who names their file gets the shipped
 * default of 3 instead, so their guards expire SOONER here than in their own tick and this operation can
 * dispatch a lane they still consider held. Dropping it is still right — it is the knob an attacker or a
 * fat-fingered file would reach for — but it is a trade, not a free win, which is why the drops are REPORTED:
 * they ride the read all the way onto the verdict as `droppedBookkeeping`, so a caller sees which of their
 * settings this run did not honour.
 *
 * @param {string} text - the caller's bookkeeping file contents.
 * @returns {{stdin: string, dropped: string[]}}
 */
export function forwardableBookkeeping(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (e) {
    throw new Error(`dispatch-lane-io: the bookkeeping file is not parseable JSON (${String(e.message || e).split('\n')[0]})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('dispatch-lane-io: the bookkeeping file must hold a JSON object');
  }
  // A file may be either `{ bookkeeping: {...}, … }` (what the tick's shell reads) or the bare bookkeeping map
  // (what `nextState` is) — `tick-core` accepts both, so the same two shapes are accepted here.
  const wrapped = !!parsed.bookkeeping && typeof parsed.bookkeeping === 'object' && !Array.isArray(parsed.bookkeeping);
  const bookkeeping = wrapped ? parsed.bookkeeping : parsed;
  // FROM THE SAME PREDICATE the line above branches on. Deriving it independently made the report lie about a
  // malformed file (`{"bookkeeping": 3, "config": {…}}` nests `config` under `bookkeeping` and was still
  // reported as dropped) — a report that disagrees with what happened is worse than no report.
  const dropped = wrapped ? Object.keys(parsed).filter((k) => k !== 'bookkeeping') : [];
  return { stdin: JSON.stringify({ bookkeeping }), dropped };
}

/**
 * The canonical backlog loader — the SAME one `dispatch-plan.mjs` enriches its queue rows from, so the scope
 * this operation puts in the brief is the scope the dispatcher arbitrated on.
 *
 * Exported (#3438) so a caller outside this file's own `readTick` — `we:scripts/conveyor/reconcile-fix-dispatch.mjs`,
 * which resolves an item from a PR's head ref rather than from `planTick`'s own launch lists — reuses the SAME
 * loader instead of a second copy that could drift from it.
 */
export function defaultLoadItems(root) {
  const require = createRequire(import.meta.url);
  const load = require(join(root, 'src', '_data', 'backlog.js'));
  return typeof load === 'function' ? load() : [];
}

/** One item's spec path + repo-qualified scope, or null when the loader cannot see it. Exported (#3438) for the
 *  same reason as {@link defaultLoadItems} just above.
 *
 *  CARRIES `openBlockers` THROUGH (#3462). The loader (`we:src/_data/backlog.js`) already computes it — the
 *  same field `dispatch-plan.mjs` enriches its queue rows from for the automatic sweep's `hasOpenBlockers`
 *  hold — but this function used to narrow the record down to `num`/`slug`/`specPath`/`scope` and drop it,
 *  which is why the manual `--num=<N>` path had no `blockedBy` awareness at all: the data was computed, never
 *  read here. See `shapeDispatchRead`'s blocked-item refusal, which is what actually reads this field. */
export function findItem(key, loadItems, pocRegistry = null) {
  let items = [];
  try { items = loadItems() || []; } catch { return null; }
  const list = Array.isArray(items) ? items : [];
  // #xdx3ifb multi-repo slice 3 — FALL BACK TO `bornAs` when `num` doesn't match. The drain JIT-numbers a
  // card (`xHASH → NNNN`, #2288) the moment its WE half lands, but a still-open impl-repo branch keeps the
  // name it was cut under (`lane/xHASH-…`) — it has no way to learn the new number after the fact. Without
  // this fallback that branch's PR looks up a `key` (the hash) no item's `num` will ever equal again, and
  // every consumer of `findItem` (fix dispatch, CI-heal, reconcile) treats a real, still-open item as
  // unresolvable forever. `bornAs` is the durable link (#2392/#2288: the drain stamps it on the numbered
  // card at land, and it never changes again), so trying it SECOND — only once the direct `num` match
  // misses — recovers exactly this population with no change to the (unambiguous) common case.
  const it = list.find((x) => normNum(x?.num) === key) ?? list.find((x) => normNum(x?.bornAs) === key);
  if (!it || !it.slug) return null;
  const rawTarget = typeof it.deliveryTarget === 'string' && it.deliveryTarget.trim() ? it.deliveryTarget.trim() : null;
  return {
    num: String(it.num),
    status: it.status ?? null,
    deliveryAgent: it.deliveryAgent ?? null,
    slug: String(it.slug),
    specPath: `backlog/${it.num}-${it.slug}.md`,
    // Already repo-qualified by the loader (`we:scripts/...`), which is the form the brief's `--scope` wants.
    scope: Array.isArray(it.scope) ? it.scope.map(String) : [],
    // The still-open `blockedBy` targets (#3462), or `[]` when every edge resolved or the item names none.
    openBlockers: Array.isArray(it.openBlockers) ? it.openBlockers.map(String) : [],
    // #3717 — the card's own `size:` frontmatter, narrowed through for the SAME reason `openBlockers` is: the
    // routing decision (`dispatch-contracts.mjs#decideDispatchRoute`) turns it into the estimated LOC the
    // router's proven envelopes are measured in. SPREAD, not a `null` key: "this card declares no `size:`" is
    // the ABSENCE of the field, and it keeps the resolved-item shape byte-identical for every unsized card.
    ...(it.size == null || it.size === '' ? {} : { size: it.size }),
    ...(it.risk == null ? {} : { risk: it.risk }),
    ...(typeof it.designQuestion === 'boolean' ? { designQuestion: it.designQuestion } : {}),
    ...(typeof it.wellScoped === 'boolean' ? { wellScoped: it.wellScoped } : {}),
    // #3857/#3906 — the card's `tags:`, for the tier table's `security` row. Spread for the same reason.
    ...(Array.isArray(it.tags) && it.tags.length ? { tags: it.tags.map(String) } : {}),
    // #3637 — WHICH BRANCH this item delivers to. Absent ⇒ `main` ⇒ today's behaviour, byte-identical. The
    // loader spreads unknown frontmatter through (`...data`), so this arrives with no loader change; it is
    // narrowed here for the same reason `openBlockers` is — a field that is computed but never carried through
    // this function is a field the dispatch path cannot see.
    //
    // RESOLVED AND VALIDATED HERE, in the io shell, not in the declaration. `we:scripts/operations/
    // dispatch-lane.mjs` is asserted (by its own suite) to reach nothing that can act — no `node:` specifier
    // anywhere in its import graph — and the registry lives in a file, so the read belongs on this side. The
    // declaration only reads the resolved `deliveryBase` string.
    deliveryTarget: rawTarget || null,
    deliveryBase: resolveDeliveryBase(rawTarget, it.num, pocRegistry),
  };
}

/** #3637 — the delivery target for one item, validated against the POC-branch registry. An UNREGISTERED
 *  branch THROWS: doctrine rule 10(c) says a POC branch must be DECLARED, and a dispatch aimed at an
 *  undeclared ref would fork a lane from a ref that may not exist and then have nowhere to land it. The same
 *  predicate runs as a LINT at filing time (`we:scripts/check-backlog-item.mjs`), so the normal way to satisfy
 *  this is never to reach it with a bad value. `registry` is injected for tests. */
export function resolveDeliveryBase(target, num, registry) {
  const reg = registry ?? readPocRegistry();
  const verdict = validateDeliveryTarget(reg, target);
  if (!verdict.ok) throw new Error(`dispatch-lane.read: #${num} — ${verdict.error}`);
  return verdict.target;
}

/** `readTick` bound to one root — the shape the declaration wants. */
export function createTickReader(bindings = {}) {
  return ({ num, bookkeepingFile, tickFile, all = false, verbose = bindings.verbose }) => readTick({ ...bindings, num, bookkeepingFile, tickFile, all, verbose });
}

/**
 * How long `claude --bg` gets to return. It is documented to return IMMEDIATELY, so anything near this is a
 * hang, and a hang here is synchronous inside the executor — it would stall the CLI or the whole waker pass.
 * A timeout kills it and the entry lands INDETERMINATE (`in-flight`, no handle), which is the truthful state:
 * a session may or may not have been started.
 */
export const SPAWN_TIMEOUT_MS = 60 * 1000;

/** How long `claude agents --json` gets. A read this cheap that blocks is a broken environment, not slow work. */
export const LIST_TIMEOUT_MS = 15 * 1000;

/** The env var that overrides {@link LIST_TIMEOUT_MS}. `0` means UNBOUNDED. See {@link listTimeoutMs}. */
export const LIST_TIMEOUT_ENV = 'WE_DISPATCH_LIST_TIMEOUT_MS';

/**
 * How long `gh pr list` gets. Longer than the agent listing because it is a NETWORK read against GitHub rather
 * than a local daemon, and shorter than the tick because it fetches one bounded page and nothing else. Same
 * reason for bounding it at all: it sits synchronously inside a waker pass that promises to be fail-soft per
 * run, so a wedged `gh` must not stall every OTHER parked run in the pass.
 */
export const PR_LIST_TIMEOUT_MS = 30 * 1000;

/** The env var that overrides {@link PR_LIST_TIMEOUT_MS}. `0` means UNBOUNDED. See {@link prListTimeoutMs}. */
export const PR_LIST_TIMEOUT_ENV = 'WE_DISPATCH_PR_LIST_TIMEOUT_MS';

/** How many PRs one discovery page carries. Matches the lease reaper's `--pr-limit` default. */
export const PR_LIST_LIMIT = 400;

/** The `--json` fields the discovery query MUST ask for. See {@link defaultListPrs} for why each one is here. */
export const PR_LIST_JSON_FIELDS = 'number,state,mergedAt,labels,headRefName';

/**
 * The listing timeout for THIS process — {@link LIST_TIMEOUT_MS} unless the environment overrides it.
 *
 * WHY THE KNOB EXISTS, and it is a test-determinism fix before it is an operator one (PR #1211 round 2, G3).
 * `wake-cli.test.mjs` drives the real waker CLI in a child process whose `claude` is a two-line `sh` stub. On
 * the required gate that child competes with the whole shard's worker pool for CPU, and roughly one run in
 * five the stub's own spawn did not complete inside the 15-second bound: `execFileSync` SIGKILLed it, the
 * observer reported an error instead of `running`, and one assertion failed. A flaky test on the required
 * check teaches everyone to re-run instead of read, and this one's job is to prove a blocker fix.
 *
 * The test sets this to `0`, which Node's `child_process` reads as NO TIMEOUT — so the assertion no longer
 * races a wall clock at all, rather than racing a bigger one. The production default is untouched and is
 * asserted with its literal in `dispatch-lane-defaults.test.mjs`.
 *
 * REFUSES a malformed value rather than silently falling back: an operator who set a bound that never applied
 * is in exactly the position this module's `WE_DISPATCH_AGENT_ARGS` refusal exists to prevent.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} milliseconds; `0` = unbounded.
 */
export function listTimeoutMs(env = process.env) {
  return timeoutFromEnv(env, LIST_TIMEOUT_ENV, LIST_TIMEOUT_MS);
}

/**
 * The `gh pr list` bound for THIS process — {@link PR_LIST_TIMEOUT_MS} unless the environment overrides it.
 * Its own knob rather than a share of {@link LIST_TIMEOUT_ENV}: the two reads have different costs (a local
 * daemon versus a network round-trip), so one number for both would be wrong for one of them, and an operator
 * lengthening the network bound must not silently lengthen the liveness bound too.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} milliseconds; `0` = unbounded.
 */
export function prListTimeoutMs(env = process.env) {
  return timeoutFromEnv(env, PR_LIST_TIMEOUT_ENV, PR_LIST_TIMEOUT_MS);
}

/**
 * One env-overridable millisecond bound. REFUSES a malformed value rather than silently falling back — an
 * operator who set a bound that never applied is in exactly the position this module's `WE_DISPATCH_AGENT_ARGS`
 * refusal exists to prevent.
 */
function timeoutFromEnv(env, name, fallback) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new TypeError(
      `operations: ${name} must be a non-negative number of milliseconds (0 = unbounded), got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * How long the whole tick read gets. It is the only NETWORK-bound path in this file — `tick-core` shells
 * `conveyor-state`, `dispatch-plan`, the free-lane picker and one `gh pr view` per bounced PR — so it is the
 * one most able to hang, and it runs synchronously inside the CLI. Generous, because a real read against a
 * live queue takes tens of seconds; bounded, because a wedged `gh` must not hang a caller forever.
 */
export const TICK_TIMEOUT_MS = 5 * 60 * 1000;

/** The env var an operator sets to pass extra `claude` flags (a JSON array) to every dispatched agent. */
export const AGENT_ARGS_ENV = 'WE_DISPATCH_AGENT_ARGS';

/**
 * Extra `claude` flags from the environment, or `[]`. REFUSES a malformed value rather than dispatching with
 * flags the operator thinks are set and are not — a silently-ignored `--permission-mode` is exactly the kind of
 * thing nobody notices until an agent stalls on a prompt.
 */
export function agentArgsFromEnv(env = process.env) {
  const raw = String(env[AGENT_ARGS_ENV] || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== 'string')) {
    throw new TypeError(`operations: ${AGENT_ARGS_ENV} must be a JSON array of strings, e.g. '["--model","sonnet"]'`);
  }
  return parsed;
}

/**
 * REFUSE to dispatch from inside a lane clone.
 *
 * The agent's very first instruction is to acquire a lane of its own, and it runs it in the cwd it was started
 * in. Started inside `lane-N`, it would acquire a SECOND lane from within one — a nested checkout whose lease,
 * scope and eventual PR all belong to a lane nobody assigned it.
 *
 * WHAT IT ACTUALLY CHECKS, said plainly: the root's BASENAME matches `lane-<digits>`. `REPO_ROOT` is resolved by
 * script location rather than cwd, so it is the checkout the operation was invoked from — but the earlier
 * wording ("fires exactly when the operation was invoked from a lane clone") was wider than the test in both
 * directions, and the review was right to say so (PR #1211, F9): a primary checkout that happens to be named
 * `lane-2` is refused, and a lane-shaped worktree named anything else is not. The name is the convention
 * `we:scripts/lane-pool.mjs` creates, and a stricter check would need to read the pool's registry from a file
 * this module deliberately does not touch.
 *
 * IT THROWS `notApplied`, so the entry lands `failed` — and the executor retries `failed` with no cap. The
 * condition is PERMANENT (a checkout does not rename itself), so such a run re-attempts an impossible dispatch
 * on every waker pass until a person closes it out. It is bounded in the only way that matters — nothing is
 * ever spawned — and capped retry is #3083, which is unruled; recorded here so the next reader does not think
 * the retry was considered and blessed.
 */
export function assertNotALaneCheckout(root) {
  if (/^lane-\d+$/.test(String(root).split('/').filter(Boolean).pop() || '')) {
    throw notApplied(
      `dispatch-lane: refusing to start a delivery agent from the lane checkout ${root} — the brief's first step `
      + 'acquires a lane, and acquiring one from inside another nests two checkouts. Run this from the control clone '
        + '(<workspace>/wev-control, we:scripts/lib/automation-home.mjs), never the operator\'s primary checkout.',
    );
  }
}

/**
 * build-path-codex-isolation — REFUSE TO DISPATCH FROM STALE CODE. `review-dispatch`, `reconcile-fix-dispatch`
 * and `ci-heal-pr-dispatch` have all run {@link assertMainNotStale} (#3439/#3474) since before this card;
 * `run.mjs dispatch-lane` — the BUILD path — never did.
 *
 * THE LIVE CASE (2026-09-27, #3604): `WE_BUILD_DISPATCH_MODE=mechanical node scripts/operations/run.mjs
 * dispatch-lane --num=3604` was run from the primary checkout, a DETACHED HEAD 449 commits behind origin/main.
 * That checkout predated the provider registry (#3645/#3906), the Codex build wrapper (#2753) and the
 * bg-isolation override (#2779). So `WE_BUILD_DISPATCH_MODE` was an env var nothing read, the codex-marked card
 * went to `claude --bg`, and that session stalled on "Call EnterWorktree first". Both blockers were one cause:
 * the dispatcher ran code origin/main had long replaced, and nothing said so.
 *
 * Two checks, in order:
 *   1. {@link assertMainNotStale} — the shared chokepoint guard (fetch, clean fast-forward + self re-exec for an
 *      armed CLI, managed-clone and last-known-good rules). It measures the LOCAL `main` branch.
 *   2. When HEAD is NOT on `main` (detached, or another branch), step 1 never looked at the code this process
 *      actually loaded. So: if origin/main changed any CODE file since HEAD's merge-base with it, refuse. A
 *      branch that is only AHEAD of origin/main (a clone of an unmerged fix) passes; a stale detached HEAD does not.
 *
 * Throws a plain Error (the CLI prints it and exits non-zero) BEFORE any run record exists — it is called from
 * `run.mjs`'s CLI block, never from inside the sink, because a re-exec or refusal after the executor has written
 * `in-flight` would leave an indeterminate entry.
 *
 * @param {string} [root]
 * @param {{assertNotStale?: (root: string) => unknown, headBranch?: (root: string) => (string|null),
 *   behindCodeFiles?: (root: string) => (string[]|null)}} [io]
 * @returns {{ok: true}}
 */
export function assertDispatcherFresh(root = REPO_ROOT, {
  assertNotStale = (r) => assertMainNotStale(r, undefined, { label: 'dispatch-lane' }),
  headBranch = (r) => {
    const h = gitRun(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: r });
    return h.status === 0 ? h.stdout.trim() || null : null;
  },
  behindCodeFiles = (r) => {
    const files = behindFiles(r, 'main');
    return Array.isArray(files) ? files.filter(isCodePath) : null;
  },
} = {}) {
  assertNotStale(root);
  const branch = headBranch(root);
  if (branch === 'main') return { ok: true };
  const code = behindCodeFiles(root);
  // `null` = the diff could not be read (e.g. no origin/main ref). Step 1 already treated an unreachable remote
  // as fail-soft; this step follows it rather than blocking every offline dispatch.
  if (Array.isArray(code) && code.length > 0) {
    throw new Error(
      `dispatch-lane: refusing to dispatch — HEAD of ${root} is ${branch ? `on branch ${branch}` : 'DETACHED'} and `
      + `origin/main has changed ${code.length} code file(s) since it (e.g. ${code.slice(0, 3).join(', ')}), so this `
      + 'process would route and spawn with STALE code (a dispatch mode it cannot read, a provider it does not '
      + 'have, a session setting it never writes). Run dispatch-lane from a checkout on main that is current with '
      + 'origin/main (a daemon clone, or a fresh clone), not from this one.',
    );
  }
  return { ok: true };
}

/**
 * Errors that PROVE no agent started. Matching one marks the entry `failed` (retried on the next pass) instead
 * of the default INDETERMINATE — and the list is deliberately tiny, because the default is the safe one: a
 * `claude` invocation that failed for any reason we do not recognise may still have started a session, and
 * guessing otherwise is how a lane gets two agents.
 */
const PRE_SPAWN_REFUSALS = Object.freeze(['ENOENT', 'EACCES']);

/** Is this spawn failure one we can PROVE happened before any agent existed? */
export function isPreSpawnRefusal(error) {
  const code = String(error?.code || '');
  return PRE_SPAWN_REFUSALS.includes(code);
}

/**
 * #4174 follow-up (live-caught 2026-09-27, 17 occurrences over `#4238`'s own dispatch path —
 * PRs #2766/#2767/#2800/#2803/#2822 all refused `dispatch-failed` with this exact text) — `claude --bg`'s OWN
 * refusal text for a cwd its trust check does not recognise: *"Workspace not trusted. Run \`claude\` in <dir>
 * once and accept the trust prompt, then retry."* This is PRE-SPAWN PROOF exactly like ENOENT/EACCES above — the
 * CLI prints this and exits before a single tool call, let alone an agent turn, has happened — but it carries no
 * `.code` `isPreSpawnRefusal` recognises, so before this it fell all the way through to the INDETERMINATE branch
 * and every one of those 17 refusals was logged "whether an agent started is UNKNOWN" even though the CLI's own
 * stderr proves the answer is "no". Matched against `error.stderr` ONLY — the CLI's own output stream, which is
 * where this text lives. NEVER `error.message`: `execFileSync` builds it as `Command failed: claude <argv…>\n
 * <stderr>`, and the argv carries the dispatch PROMPT (PR/card text), so an unrelated failure whose prompt merely
 * mentions the phrase would be retried and reclassified out of the INDETERMINATE bucket (PR #2824 review).
 *
 * WHY THIS KEEPS HAPPENING despite `grantDispatchTrust` already granting trust right before every spawn
 * ({@link ensureDispatchSessionCwd}, #4174, plus the `withFileLock` hardening of #4188): the lock only
 * serializes THIS module's own two writers (grant vs. {@link revokeDispatchTrust}) against each other. It does
 * nothing against a concurrent, uncooperative writer — a DIFFERENT already-running `claude` process (another
 * dispatched session, or an interactive one) doing its OWN unrelated, unlocked read-modify-write of the same
 * `~/.claude.json` for its own bookkeeping. If that external write's read snapshot predates our grant and its
 * write lands after, our just-added trust entry is silently clobbered — a lost update our lock cannot see,
 * because the other side never takes it. Several daemon ticks running as separate OS processes concurrently
 * (the `Mac:<pid>` markers in the daemon's own log) make that window real, not theoretical, and it is exactly
 * why the refusal is INTERMITTENT rather than constant: it only bites when another `claude` process's write
 * straddles the grant-to-spawn gap for this one session's fresh, never-reused scratch cwd.
 * @param {{stderr?: string}} error
 */
const TRUST_REFUSAL_PATTERN = /Workspace not trusted/;
export function isTrustRefusal(error) {
  return TRUST_REFUSAL_PATTERN.test(String(error?.stderr ?? ''));
}

/**
 * THE SINK — the one thing in this repo that starts a delivery agent.
 *
 * THE HANDLE IS THE ONE THE CLI PRINTS BACK — NOT A MINTED ONE. CORRECTED 2026-09-11 (#3331); this paragraph
 * used to read *"THE HANDLE IS MINTED, NOT DISCOVERED, and that is the load-bearing detail … `claude
 * --session-id <uuid>` removes the race outright: the dispatcher CHOOSES the id"*, and that was the discarded
 * assumption stated as the design's load-bearing detail. `claude --bg` IGNORES `--session-id` (measured 3/3 at
 * CLI 2.1.246 by #3331's probe, re-measured 2/2 at 2.1.269 with the real dispatch argv; the CLI says so itself
 * on stderr), so every "minted" handle addressed a session that never existed.
 *
 * What IS true from the #3030 spike still stands: a session id is the durable handle and `pid` must never be
 * one (the OS reuses it). What replaces the mint is neither a mint nor the spike's before/after listing diff —
 * both of which the spike rightly called racy — but the id `claude --bg` PRINTS on its own stdout for the
 * session it just started (`backgrounded · <id> · <name>`, {@link parseBackgroundedId}). That is
 * race-free by construction: it is this spawn's own output, attributable to no other session, available
 * synchronously, and it is the listing's `id` field on a background row. See {@link buildAgentArgv} and
 * {@link defaultClaudeProvider}.
 *
 * WHAT IS STILL NOT COVERED, stated rather than papered over: a sink killed between `claude --bg` returning and
 * this function returning loses the handle, and the executor then refuses the entry on replay (it is
 * `in-flight` with a null handle — `inFlightEntries().unknown`). That window is a few milliseconds wide and the
 * failure is VISIBLE and closable with `resolveInFlight`, which is the whole reason #3073 wrote `in-flight`
 * before the sink rather than after.
 *
 * NO PERMISSION FLAGS ARE BAKED IN — but the knob is REACHABLE. `extraArgs` (model, effort, permission mode)
 * defaults to empty, because a dispatcher that hard-coded `--dangerously-skip-permissions` would silently widen
 * every agent it ever launches; that is a decision for whoever runs the conveyor. It is read from
 * {@link AGENT_ARGS_ENV} at the `run.mjs` binding so an operator can actually set it, rather than being a
 * parameter only a test can reach.
 *
 * PROVEN AGAINST A PROCESS *AND*, SINCE #3331, AGAINST THE REAL CLI ON THE ONE POINT THAT MATTERED.
 * `./__tests__/dispatch-spawn-live.test.mjs` starts a `claude` executable — a fake first on `PATH` that parses
 * options the way a commander-style CLI does — and asserts this argv is ACCEPTED and that `--bg` returns
 * instead of blocking. A FAKE CANNOT SETTLE WHO OWNS THE ID, which is precisely how the discarded
 * `--session-id` survived: the fake obligingly echoed back whatever it was handed, so the round-trip test was
 * green against an assumption the real CLI had never honoured. That question is now answered live (CLI 2.1.269,
 * 2026-09-11) and the answer is in {@link buildAgentArgv}'s header. What is STILL not proven by a test: a
 * background session's permission mode and the isolation default; #xaibmeu, which routes the conveyor through
 * this operation, is where those settle.
 *
 * ── THE PROVIDER PORT (#3579) ───────────────────────────────────────────────────────────────────────────────
 *
 * `provider` is the seam between "an item is ready to dispatch" and "some CLI's argv/stdout" — the boundary
 * this item (#3579) names, mirroring #3370's judge-seam extraction. Its shape is deliberately independent of
 * any one CLI:
 *
 *   request:  {sessionId, cwd, prompt, sessionSlug, num, extraArgs, systemPromptFile}
 *             — a session/item identity, the FILLED brief text, and an expected-duration hint (read by the
 *             caller from `payload.expectedWithinMinutes`, not part of the request itself).
 *   returns:  a durable handle string (or a Promise of one) usable for LATER liveness polling — never a raw
 *             stdout blob or a CLI-shaped result.
 *
 * `defaultClaudeProvider` is ONE implementation of this port, not the port itself: it composes
 * {@link buildAgentArgv} (Claude's argv construction) with the injected `spawnAgent` (the CLI-shaped seam that
 * already existed) and answers with the id `claude --bg` PRINTED — read by {@link parseBackgroundedId} off the
 * spawn's own stdout. It used to answer with the minted `sessionId`; #3331 measured that the CLI discards that
 * value outright, so the port was handing every caller a handle no listing could ever match. The stdout parse
 * is no longer only the resume-detection path's (`resumeSucceeded`); it is where a usable handle comes from.
 *
 * @param {object} [o]
 * @param {string} [o.root] - THIS DISPATCHER'S OWN checkout — never the agent's cwd any more (#4174). Still what
 *   `assertNotALaneCheckout` checks and what the agent's brief is filled with an absolute path to (`{{WE_ROOT}}`),
 *   so it can `lane-pool acquire` before it has a checkout of its own; see {@link dispatchSessionCwd}.
 * @param {Function} [o.spawnAgent] - injectable `(argv, opts) => stdout`; the default shells `claude`. Feeds
 *   the DEFAULT `provider` below; a caller supplying its own `provider` need not touch this at all.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT `spawnAgent` goes through. See
 *   {@link readTick} for why this is a second seam and not the same one.
 * @param {(request: object) => (string|Promise<string>)} [o.provider] - the PORT (see above). Defaults to
 *   {@link defaultClaudeProvider} closed over `spawnAgent`.
 * @param {() => string} [o.mintSessionId] - injectable UUID minter.
 * @param {() => Date} [o.now] - injectable clock, for `expectedBy`.
 * @param {string[]} [o.extraArgs]
 * @param {(sessionId: string) => string} [o.sessionCwdFor] - #4174 — computes the cwd THIS session actually
 *   starts in. Defaults to {@link dispatchSessionCwd} closed over `root` — a workspace-level scratch directory,
 *   NEVER `root` itself. Injectable so a test can pin it back to a fixed path without touching the filesystem.
 * @param {(dir: string) => string} [o.ensureSessionCwd] - makes that directory exist. Defaults to
 *   {@link ensureDispatchSessionCwd} (never throws). Injectable for the same reason as `sessionCwdFor`.
 * @returns {Record<string, Function>} effect type → `async (payload, ctx) => result`.
 */
export function createDispatchSinks({
  root = REPO_ROOT,
  exec = execFileSync,
  spawnAgent = (argv, opts) => defaultSpawnAgent(argv, opts, { exec }),
  // #3645/#3906 — EVERY REGISTERED KIND'S MODE, read from the environment ONCE, here, at sink-construction
  // time rather than per dispatch, so one tick cannot straddle two modes. Every row defaults to `agent` on main
  // (see `dispatch-provider-registry.mjs`), so an unset environment keeps every kind on `claude --bg`.
  modes = dispatchModesFromEnv(),
  // #3645 — the provider table itself, injectable so the default path can be exercised without a process.
  registry = DISPATCH_PROVIDER_REGISTRY,
  // #3906 — does a mechanical row's `runScript` exist in this checkout? See {@link routeDispatchProvider}.
  scriptExists = (path) => existsSync(path),
  // #3645/#3906 — THE DEFAULT PROVIDER IS THE ROUTER: a kind whose registry row is `mechanical` runs that row's
  // provider; every other kind takes the unchanged `claude --bg` path. A caller supplying its own `provider`
  // bypasses the routing entirely, exactly as before.
  // agy-launcher-probation — `on`/`off`, read ONCE here like `modes` (see `probationLaunchFromEnv`).
  probationLaunch = probationLaunchFromEnv(),
  providerAvailable = dispatchProviderAvailable,
  provider = (request) => routeDispatchProvider(request, {
    modes, registry, scriptExists, providerAvailable, agent: (r) => defaultClaudeProvider(r, { spawnAgent }), probationLaunch,
  }),
  mintSessionId = () => randomUUID(),
  now = () => new Date(),
  extraArgs = [],
  // #x8mpubm — resolved ONCE per dispatch, here at the sink (the one place real fs/env effects belong in this
  // file), never inside `defaultClaudeProvider`/`buildAgentArgv` themselves, both of which stay side-effect-free
  // by default so every OTHER existing test of either keeps working unchanged. `resolveGhShimSettingsEnv`
  // itself never throws and is a no-op (fs untouched) on any host that has not opted into App auth — see
  // `we:scripts/lib/gh-app-shim.mjs`'s own header.
  // #x36vidg — plus the Bash timeouts (`resolveDispatchSettingsEnv`), so every dispatch carries `--settings`.
  resolveSettingsEnv = resolveDispatchSettingsEnv,
  // #4174 — see the two @param entries above. `sessionCwdFor` is the PURE path calculation, `ensureSessionCwd`
  // the (never-throwing) side effect that makes it real; split the same way `resolveSettingsEnv` is its own
  // seam rather than folded into the provider call.
  sessionCwdFor = (sessionId) => dispatchSessionCwd(sessionId, { root }),
  ensureSessionCwd = ensureDispatchSessionCwd,
  // #xrv69j6 — the ONE lane this dispatch will use (or, defensively, every lanes-pool root — see
  // {@link dispatchLaneGrant}'s own header), pre-granted as an additional directory + Edit/Write allow rule
  // in the session's own `<cwd>/.claude/settings.local.json`, so its FIRST Edit (the brief's `lane-pool.mjs
  // acquire` step, seconds after the session starts) lands inside a directory the CLI has already approved
  // rather than an unattended `--bg` session sitting on an unanswerable permission prompt (live case:
  // `fix-2735`, 36+ min blocked, #2735 stalled). Two seams, mirroring `resolveSettingsEnv`/`sessionCwdFor`
  // above: `resolveLaneGrant` is the PURE computation, `grantLanePermission` the never-throwing side effect.
  resolveLaneGrant = (payload) => dispatchLaneGrant(payload, { root }),
  grantLanePermission = (cwd, grant) => ensureSettingsFilePermissions({ cwd, ...grant }),
  // #x9fbg1x — every dispatched session gets the SAME worktree-isolation override, unconditionally (unlike
  // `resolveSettingsEnv`'s gh-shim half, this is never opt-in — every dispatched session already runs inside
  // an isolated lane clone once it acquires one, so the CLI's own guard is redundant for ALL of them, not just
  // hosts that configured something). `resolveWorktreeIsolation` is the PURE value; `ensureWorktreeIsolation`
  // the never-throwing durable write into this dispatch's OWN scratch cwd — two seams, mirroring every other
  // pair in this sink, so a test can assert either independently of the real filesystem.
  // build-path-codex-isolation — both defaults are the ONE shared helper every dispatch path now calls
  // (`isolateDispatchSession`); the two seams stay so existing tests can assert each half independently.
  resolveWorktreeIsolation = () => DISPATCH_WORKTREE_SETTINGS.worktree,
  ensureWorktreeIsolation = (cwd) => isolateDispatchSession(cwd).write,
} = {}) {
  return {
    // #4349 — `ctx` (`{key, runId, ...}`, from `effect-executor.mjs#applyPendingEffects`'s per-sink call) was
    // already documented on this function's own `@returns` above, but never actually accepted — the sink took
    // only `payload`. A detached `build` dispatch needs its OWN run id + effect key to settle itself later
    // (`deliver-item-wrapper.mjs#deliverItem`'s `finish()`); every OTHER launch kind's provider simply ignores
    // the two new `request` fields below, so this is additive-only.
    [DISPATCH_EFFECT]: async (payload, ctx = {}) => {
      assertNotALaneCheckout(root);
      // #3168 — the loudest point in the whole path: right before the agent is actually spawned into the
      // fail-open lane, printed to THIS process's own stderr rather than left to surface only in the eventual
      // agent's own `acquire` stdout (which nobody here is watching). `payload.occupancyWarning` is `null` for
      // every kind whose brief self-adopts (`build`/`investigate` — see `dispatch-lane.mjs`'s
      // `KIND_DECLARES_OCCUPANCY_ON_DISPATCH`), so this is a no-op on the common path.
      if (payload?.occupancyWarning) {
        console.error(`dispatch-lane: ${payload.occupancyWarning}`);
      }
      const sessionId = String(mintSessionId());
      // #4174 — THE FIX: the session's cwd is a scratch directory OUTSIDE this checkout, never `root` itself.
      // See `dispatchSessionCwd`'s own header for why this location and not, say, an `os.tmpdir()` mkdtemp.
      const sessionCwd = ensureSessionCwd(sessionCwdFor(sessionId));
      // #xrv69j6 — grant the lane BEFORE the agent is spawned into this cwd, so the settings file already
      // carries the grant by the time the session's own first Bash/Edit tool call reads it. Best-effort (the
      // function itself never throws) — a grant failure must never block the dispatch it is here to unblock.
      grantLanePermission(sessionCwd, resolveLaneGrant(payload));
      // #x9fbg1x — same "write into the scratch cwd BEFORE the agent starts" timing as the lane grant above,
      // so the guard is already off by the time the session's own first Edit runs. Best-effort (the function
      // itself never throws) — a write failure here must never block the dispatch it exists to unblock.
      ensureWorktreeIsolation(sessionCwd);
      const worktreeSettings = resolveWorktreeIsolation();
      // #3857 — the model-tier table's answer for this dispatch, read straight off `payload.routing`
      // (`decideDispatchRoute`'s record, computed upstream by the read step). Without a routed
      // model, `buildAgentArgv` uses the launch kind’s tier and refuses an unresolved model.
      const table = workerModelTable(payload?.routing);
      const modelReason = payload?.modelReason ?? null;
      // build-path-codex-isolation — WHAT ACTUALLY RAN IT, reported by the provider that started it (see
      // `dispatchExecutorFor`). `null` until a provider reports; the fallback below covers one that does not.
      let reportedExecutor = null;
      let reportedModel = null;
      let reportedEffort = null;
      let attemptId = null;
      let handle;
      try {
        handle = await provider({
          reportAttempt: (id) => { attemptId = id; },
          headRefOid: payload?.headRefOid,
          claimOwner: payload?.claimOwner,
          claimRoot: payload?.claimRoot,
          reportExecutor: (v) => { reportedExecutor = v == null ? null : String(v); },
          reportModel: (v) => { reportedModel = v; },
          reportEffort: (v) => { reportedEffort = v; },
          policyRoute: payload?.routing?.policyRoute ?? null,
          sessionId,
          cwd: sessionCwd,
          // Salvaged earlier work for this card/PR (see `we:scripts/lib/salvage-index.mjs`): one pointer line.
          prompt: withSalvageHint(payload?.prompt, { cards: [payload?.num], prs: [payload?.pr] }),
          sessionSlug: payload?.sessionSlug,
          num: payload?.num,
          // #4349 — the SAME identifiers the executor just handed this sink in `ctx`, forwarded onto the
          // request so a MECHANICAL provider (a wrapper, not an agent reading a brief) can settle its own
          // effect once it knows its outcome. Build and probation prepare providers consume these fields;
          // callers without executor context omit the flags rather than guessing an attempt identity.
          runId: ctx?.runId,
          effectKey: ctx?.key,
          // #3645/#3640 — WHICH KIND, WHICH LANE UNDER WHAT SCOPE, and (repairs) WHICH PR AND WHY. Already on
          // the effect payload; part of the port's request because a MECHANICAL provider (a wrapper, not an
          // agent reading a brief) needs them as data. The `claude --bg` path ignores all five.
          launchKind: payload?.launchKind,
          lane: payload?.lane,
          scope: payload?.scope,
          pr: payload?.pr,
          reason: payload?.reason,
          // agy-launcher-probation — the router's probation pick (a ci-heal dispatch carries it directly; a tick
          // dispatch carries it on its routing record) and the target repo, for `routeDispatchProvider`.
          probationWorker: payload?.probationWorker ?? payload?.routing?.probationWorker ?? null,
          repo: payload?.repo,
          extraArgs,
          systemPromptFile: DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
          // #3857 — see `table` above; `modelReason` is `dispatch-lane.mjs`'s own input, riding the payload.
          table,
          modelReason,
          // #x8mpubm follow-up (#4174) — written into `<sessionCwd>/.claude/settings.local.json`, the cwd the
          // session ACTUALLY starts in now, not `root`'s. Writing it to `root` would (a) no longer be where the
          // session looks for it, and (b) be one more write into the dispatching checkout this whole card exists
          // to stop.
          settingsEnv: resolveSettingsEnv(sessionCwd),
          // #x9fbg1x — folds `{"worktree":{"bgIsolation":"none"}}` into the SAME `--settings` argument, and
          // (via `ensureWorktreeIsolation` above) the same durable settings.local.json this dispatch's cwd
          // already carries the gh-shim env/lane-grant overrides in.
          worktreeSettings,
        });
      } catch (e) {
        // A validation failure `buildAgentArgv` already proved happened before any process existed (e.g. an
        // empty prompt) carries `.notApplied` — rethrow it as-is rather than reclassifying it as indeterminate.
        if (e && e.notApplied) throw e;
        if (isPreSpawnRefusal(e)) {
          throw notApplied(`claude could not be started (${String(e.code)}) — no agent exists`, { sessionId });
        }
        // #4174 follow-up — see {@link isTrustRefusal}'s own header. `defaultSpawnAgent` already retried once
        // with a fresh grant before this catch is ever reached (see there), so an error that STILL carries this
        // text proves the retry also lost the race (or trust genuinely could not be granted, e.g. an unreadable
        // `~/.claude.json`) — either way the CLI's own stderr proves no agent started, exactly like ENOENT/EACCES
        // above, and this is definite-not-started/retryable, never the UNKNOWN bucket a human has to close out.
        if (isTrustRefusal(e)) {
          throw notApplied(
            `claude could not be started (workspace not trusted for ${sessionCwd}) — no agent exists`,
            { sessionId },
          );
        }
        // INDETERMINATE. The entry stays `in-flight` with a NULL handle: something may be running and cannot be
        // observed. The replay guard refuses it and `inFlightEntries` reports it under `unknown`, which is
        // exactly right — a person finds out what happened and closes it out.
        throw new Error(
          `claude --bg failed and whether an agent started is UNKNOWN: ${describeDispatchFailure(e)}`,
        );
      }
      const minutes = Number(payload.expectedWithinMinutes) > 0
        ? Number(payload.expectedWithinMinutes)
        : DEFAULT_EXPECTED_WITHIN_MINUTES;
      const handleText = handle != null ? String(handle) : sessionId;
      const route = handleText.startsWith(DETACHED_HANDLE_PREFIX) ? 'detached' : 'claude-bg';
      // #3857 — the model the spawn ACTUALLY got: the same `resolveWorkerModel` decision `buildAgentArgv`
      // applied (it already refused a bad combination before any process, so a refusal cannot reach here).
      // `null` for a `detached` route (a wrapper never passes through `buildAgentArgv`) or with no `table`.
      const modelDecision = table && route === 'claude-bg'
        ? resolveWorkerModel({ extraArgs, table, modelReason })
        : null;
      const executor = dispatchExecutorFor({ route, reported: reportedExecutor });
      // ONE line on stderr naming what runs this dispatch — the dispatch LOG half of the same fact the record
      // carries below, so an operator reading the CLI output never has to reconcile two provider fields.
      console.error(`dispatch-lane: #${payload?.num ?? '?'} ${payload?.launchKind ?? 'build'} → model=${reportedModel ?? modelDecision?.model ?? 'unknown'} executor=${executor} (${route}, handle ${handleText})`);
      return inFlight({
        handle: handleText,
        expectedBy: new Date(now().getTime() + minutes * 60 * 1000).toISOString(),
        // #3717/#3848/#3857 — THE ROUTE ON THE DURABLE RECORD. build-path-codex-isolation: `executor` is the
        // ONE field that says what actually runs this dispatch (reported by the provider that started it — see
        // `dispatchExecutorFor`). The old `routedProvider`/`executedProvider` pair is gone: `routed` was the
        // criteria's recommendation printed beside the executor under a name that read like a second answer
        // (live: the build-daemon dry run printed `routed=claude executed=codex` for #3604, and the operator
        // could not tell which one ran). The recommendation survives as `criteriaRecommendation`, named as one.
        dispatch: {
          ...(attemptId ? { attemptId } : {}),
          launchKind: payload?.launchKind ?? 'build',
          route,
          executor,
          effort: reportedEffort ?? payload?.routing?.effort ?? table?.effort ?? null,
          supervisorModel: reportedModel ?? modelDecision?.model ?? extractModelFlag(extraArgs.map(String)).value,
          workerModel: reportedModel && payload?.routing?.policyRoute
            ? { name: reportedModel, tier: null, source: 'routing-policy', tableTier: table?.tier ?? null, reason: 'resolved launch model' }
            : modelDecision && !modelDecision.refusal
            ? { name: modelDecision.model, tier: modelDecision.tier, source: modelDecision.source, tableTier: modelDecision.tableTier, reason: modelDecision.reason }
            : null,
          criteriaRecommendation: payload?.routing?.routed ?? null,
          routedTaskType: payload?.routing?.taskType ?? null,
          supervisionLevel: payload?.routing?.supervision ?? null,
          supervisionEnforced: payload?.routing?.supervisionEnforced === true,
          providerOverride: payload?.routing?.override ?? null,
        },
      });
    },
  };
}

/**
 * #3857/#3906 — THE MODEL-TIER TABLE'S ANSWER for one dispatch, as the `table` {@link buildAgentArgv} takes:
 * `{tier, model, reason}`, or `null` (the argv builder must resolve a launch-kind default).
 *
 *   - A ROUTED record whose `model` is a native Claude id → its tier's spawn ALIAS (`sonnet`/`opus`). The
 *     prototype passed the pinned id; #3906 passes the alias so a worker is never an older model.
 *   - A ROLE record (`prepare`, `prepare-decision`, `investigate`) with a `tier` → that tier's alias.
 *     ADAPTED from the prototype, which injected no model for a role dispatch (its record's `model` is always
 *     `null`). #3857's table rates `prepare-decision` Opus and the other roles Sonnet, and `dispatch-task`
 *     already applies that table to the same kinds, so `dispatch-lane` does too rather than leaving role
 *     dispatches on whatever the operator's own default model is.
 *   - Anything else (a refused record, an external route whose `model` is a Codex/Gemini id) → `null`.
 *
 * @param {object|null|undefined} routing
 * @returns {{tier: string|null, model: string, reason: string|null}|null}
 */
export function workerModelTable(routing) {
  if (!routing || typeof routing !== 'object') return null;
  if (routing.policyRoute?.provider === 'claude') return { tier: routing.tier, model: routing.policyRoute.model, effort: routing.policyRoute.effort, reason: 'routing-policy' };
  const tier = routing.tier ?? null;
  const claudeRoute = CLAUDE_NATIVE_MODEL_IDS.has(routing.model) || routing.outcome === 'role';
  if (!claudeRoute || !tier || !Object.hasOwn(CLAUDE_SPAWN_MODEL_BY_TIER, tier)) return null;
  // The spawn flag is the tier's ALIAS (see CLAUDE_SPAWN_MODEL_BY_TIER), so a worker always gets the current model.
  return { tier, model: CLAUDE_SPAWN_MODEL_BY_TIER[tier], reason: routingTierReason(routing) };
}

/**
 * BEST-EFFORT reasoning text for a `decideDispatchRoute` record's tier, read off its own `auditTrail` (#3857):
 * `claude-tier` for a routed task-type dispatch, `story-kind-tier`/`build-supervisor-tier` for a story-stage
 * one, or `role-path` for a role dispatch. `null` when no matching entry exists.
 * @param {object} routing
 * @returns {string|null}
 */
function routingTierReason(routing) {
  const entry = (Array.isArray(routing?.auditTrail) ? routing.auditTrail : [])
    .find((a) => ['claude-tier', 'story-kind-tier', 'build-supervisor-tier', 'role-path'].includes(a?.criterion));
  return entry ? String(entry.reasoning ?? '') || null : null;
}

/**
 * build-path-codex-isolation — THE ONE ANSWER to "what runs this dispatch", for the run record's
 * `dispatch.executor` and the dispatch log line. PURE.
 *
 * The provider that actually started the work reports it (`request.reportExecutor`): `defaultClaudeProvider`
 * says `claude`; the detached build/fix/ci-heal providers say the vendor they handed their wrapper
 * (`--provider=<marker>` → `codex`, no marker → `claude`). A provider that reports nothing falls back by route: a
 * `claude-bg` spawn is Claude by construction; a `detached` wrapper that stayed silent is `unknown`, never a guess.
 *
 * @param {{route: 'claude-bg'|'detached', reported?: string|null}} o
 * @returns {string}
 */
export function dispatchExecutorFor({ route, reported = null }) {
  if (reported) return String(reported);
  return route === 'claude-bg' ? 'claude' : 'unknown';
}

/**
 * THE ROUTER (#3645, landed off by #3906) — the default `provider` {@link createDispatchSinks} installs. It has
 * NO per-kind knowledge: it asks {@link ./dispatch-provider-registry.mjs#dispatchProviderEntry} whether this
 * launch kind has a mechanical provider and dispatches to it only when `modes` says `mechanical` for that kind.
 * Every other case — an unregistered kind, or a registered one in `agent` mode (every row's default on main) —
 * takes `agent`, the unchanged `claude --bg` spawn.
 *
 * #3906 adaptation: a `mechanical` row whose `runScript` is NOT in this checkout is REFUSED (`notApplied`,
 * before any process exists) rather than started. Each wrapper script graduates with its own card, and a
 * detached `node` pointed at a missing file would exit at once while the run record said a dispatch was in
 * flight.
 *
 * @param {object} request - the #3579 port request.
 * @param {{modes?: Record<string, string>, registry?: Record<string, object>, agent: Function, scriptExists?: (p: string) => boolean, probationLaunch?: string, probation?: Function}} io
 */
export function routeDispatchProvider(request, {
  modes = {},
  registry = DISPATCH_PROVIDER_REGISTRY,
  agent,
  scriptExists = (path) => existsSync(path),
  // agy-launcher-probation — `off` unless the sink says otherwise, so a direct caller never launches by accident.
  probationLaunch = 'off',
  probation = probationWorkerDetachedProvider,
  providerAvailable = () => true,
} = {}) {
  const kind = String(request?.launchKind || 'build');
  if (request.policyRoute) {
    // Launchability is checked BEFORE starting anything. A failed/indeterminate worker is never retried here.
    const candidates = [request.policyRoute, ...request.policyRoute.fallback];
    const workerFor = route => {
      if (!request.probationWorker || route.provider === 'claude') return null;
      const id = route.provider === 'codex' ? 'codex' : route.model.startsWith('claude-') ? 'antigravity-claude' : 'antigravity-gemini';
      return { ...PROBATION_WORKERS[id], taskType: request.probationWorker.taskType, model: route.model, effort: route.effort };
    };
    const pinnedModel = Boolean(String(request.modelReason ?? '').trim()) && extractModelFlag(request.extraArgs ?? []).found;
    const chosen = candidates.find(route => (!pinnedModel || route.provider === 'claude') && providerAvailable(route.provider) && (route.provider === 'claude'
      || (probationLaunchDecision({ ...request, probationWorker: workerFor(route) }, probationLaunch).launch
        && scriptExists(PROBATION_LAUNCHABLE_KINDS[kind].runScript))
      || (route.provider === 'codex' && registry[kind]?.runScript && scriptExists(registry[kind].runScript))));
    if (!chosen) throw notApplied(`routing policy: ${kind} has no available launch adapter in its fallback chain`);
    request = { ...request, policyRoute: { ...chosen, fallback: [] }, probationWorker: workerFor(chosen) };
    request.reportModel?.(chosen.model);
    request.reportEffort?.(chosen.effort);
    if (chosen !== candidates[0]) console.error(`routing-policy-fallback: ${kind} → ${chosen.provider}/${chosen.model} (primary adapter unavailable)`);
    if (chosen.provider === 'claude') {
      request = { ...request, probationWorker: null, table: { model: chosen.model, effort: chosen.effort, tier: Object.entries(CLAUDE_NATIVE_MODEL_BY_TIER).find(([, id]) => id === chosen.model)?.[0] ?? null, reason: 'routing-policy' } };
      return agent(request);
    }
    // An explicit Codex route whose probation launch is unavailable (probation off, or a task type the probation
    // launcher does not run) still goes to the mechanical build wrapper, never on to the Claude agent below.
    if (!probationLaunchDecision(request, probationLaunch).launch && registry[kind]) return registry[kind].provider({ ...request, probationWorker: null });
  }
  // agy-launcher-probation — FIRST: an opened, non-critical ci-heal the router gave a probation worker runs on that
  // worker (see `dispatch-providers/probation-worker.mjs#probationLaunchDecision` for every condition).
  if (probationLaunchDecision(request, probationLaunch).launch) {
    const runScript = PROBATION_LAUNCHABLE_KINDS[kind].runScript;
    if (!scriptExists(runScript)) {
      throw notApplied(`dispatch-lane: the probation launcher ${runScript} is not in this checkout — refusing before any process starts`);
    }
    return probation(request);
  }
  const entry = dispatchProviderEntry(kind, registry);
  if (entry && modes?.[kind] === 'mechanical') {
    if (entry.runScript && !scriptExists(entry.runScript)) {
      throw notApplied(
        `dispatch-lane: ${entry.modeEnv ?? 'the registry'} selects the mechanical ${kind} provider, but its wrapper `
        + `script ${entry.runScript} is not in this checkout — refusing before any process starts`,
      );
    }
    return entry.provider(request);
  }
  request.reportModel?.(request.table?.model ?? null);
  return agent(request);
}

/**
 * THE DEFAULT provider port implementation (#3579) — Claude's own. Translates the port's CLI-independent
 * request into {@link buildAgentArgv}'s payload shape, hands the resulting argv to `spawnAgent`, and answers
 * with THE ID THE CLI ITSELF PRINTED (#3331) rather than the pre-minted `sessionId` the CLI discards.
 *
 * THE FALLBACK IS `request.sessionId`, DELIBERATELY, and it is exactly the pre-#3331 behaviour: when stdout
 * cannot be parsed (a CLI whose banner changes shape, a `spawnAgent` that returns nothing) there is no better
 * handle to be had, and the sink must still record SOMETHING `in-flight` — recording `null` instead would push
 * every such dispatch into the executor's `unknown` bucket, which only a person can close out. So an
 * unparseable spawn degrades to the old, unmatchable handle; it never gets worse than before.
 *
 * @param {{sessionId:string, cwd:string, prompt:string, sessionSlug?:string, num?:string, extraArgs?:string[], systemPromptFile?:string|null, settingsEnv?:Record<string,string>|null}} request
 * @param {{spawnAgent?: Function}} [io]
 * @returns {string}
 */
export function defaultClaudeProvider(request, { spawnAgent = (argv, opts) => defaultSpawnAgent(argv, opts) } = {}) {
  // #x2psfwz — a PR_KIND session name (`review-`/`fix-`/`ci-heal-`/`inspect-<PR>`) carries NO attempt suffix
  // (session-slug.mjs's `mintSessionSlug` forbids one for these kinds), so a round-2 dispatch for the SAME PR
  // reuses the EXACT name round 1 used. Round 1's own agent brief wrote a completion record under that name
  // (`we:scripts/operations/completion-cli.mjs`, `status: done` at whichever exit it took) — a fact about ROUND
  // 1, not round 2. Left in place, any reader of that record (session-reaper.mjs's proposed completion-record
  // axis, #3721; a human `completion-cli.mjs show`) would read round 2 as already finished before it has even
  // started, purely because it inherited round 1's name. Deleting any existing record for this exact name HERE
  // — at the moment this new round is actually spawned, not relying on round 2's own agent brief to get around
  // to overwriting it (a crash before that first action would leave round 1's stale `done` in place the whole
  // time) — closes the window at its source. Best-effort: a delete failure must never block a real dispatch.
  if (typeof request.sessionSlug === 'string' && request.sessionSlug) {
    const parsed = parseSessionSlug(request.sessionSlug);
    if (parsed && !parsed.itemKind) {
      try { deleteCompletion(request.sessionSlug); } catch { /* best-effort — see comment above */ }
    }
  }
  // build-path-codex-isolation — this port implementation always runs Claude; say so on the record.
  request.reportExecutor?.('claude');
  const argv = buildAgentArgv({
    sessionId: request.sessionId,
    payload: { prompt: request.prompt, sessionSlug: request.sessionSlug, num: request.num, launchKind: request.launchKind },
    extraArgs: request.extraArgs,
    systemPromptFile: request.systemPromptFile,
    // #x8mpubm — resolved once by the SINK (`createDispatchSinks`), not here: this function never reaches
    // for `process.env`/real fs on its own (`request.settingsEnv` defaults to nothing, i.e. `null`), so every
    // existing caller/test of this port that never mentions it sees byte-identical behaviour.
    settingsEnv: request.settingsEnv ?? null,
    // #x9fbg1x — same "opt-in via the request, byte-identical when absent" contract as `settingsEnv` above.
    worktreeSettings: request.worktreeSettings ?? null,
    // #3857 — the model-tier table's decision and the required override reason, when the caller has one
    // (`request.table` null keeps this call byte-identical for any caller that computes no routing decision).
    table: request.table ?? null,
    modelReason: request.modelReason ?? null,
  });
  const launchedModel = extractModelFlag(argv).value;
  let reportedModel = launchedModel;
  try { if (request.policyRoute) reportedModel = resolvePolicyModel('claude', launchedModel); } catch { /* Explicit reasoned pins may name models outside the policy catalogue. */ }
  request.reportModel?.(reportedModel);
  request.reportEffort?.(argv.find(arg => arg.startsWith('--effort='))?.slice(9) ?? argv[argv.indexOf('--effort') + 1]);
  const stdout = String(spawnAgent(argv, { cwd: request.cwd }) ?? '');
  return parseBackgroundedId(stdout) || request.sessionId;
}

/**
 * The default `claude --bg` spawner — named and exported for the same reason as {@link defaultRunNode}: the
 * TIMEOUT it sets is the whole point of the option bag, and while it lived inside a default parameter that
 * every test overrode, deleting it left the suite green (PR #1211 review, F5).
 *
 * #4174 follow-up (live-caught 2026-09-27, see {@link isTrustRefusal}'s own header for the full race) — VERIFY
 * AND RE-GRANT RIGHT HERE, at the one moment closest to the actual spawn, rather than only back at
 * {@link ensureDispatchSessionCwd} (seconds earlier, across several more synchronous fs writes —
 * `grantLanePermission`, `ensureWorktreeIsolation` — any of which is another window for a concurrent `claude`
 * process to clobber the grant). On a trust refusal specifically: re-grant `opts.cwd` (closing the race for
 * THIS retry — a concurrent writer would have to lose the race twice in a row) and retry the exact same spawn
 * exactly once. `grantTrust`/`retryDelayMs` are injectable so a test can assert the retry happened without
 * touching the real filesystem or a real clock. NEVER retries for any OTHER failure — a real ENOENT/EACCES or a
 * genuine CLI error is unrelated to trust and re-granting cannot fix it; retrying it would only double a
 * failure that already proves nothing started, or worse, double a request that might already be in flight.
 * If the retry ALSO throws a trust refusal, that final error still carries the same text — `isTrustRefusal`
 * classifies it at the call site as definite-not-started/retryable, never as UNKNOWN.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {{exec?: Function, grantTrust?: (dir: string) => void}} [io] - injected ONLY so the opts (and the
 *   retry) can be asserted.
 * @returns {string}
 */
export function defaultSpawnAgent(argv, opts = {}, { exec = execFileSync, grantTrust = grantDispatchTrust } = {}) {
  const execOpts = {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL',
    // #x8mpubm follow-up (live-caught 2026-09-24) — this call inherits `process.env` unless told otherwise,
    // and this DAEMON's own process may carry a `GH_TOKEN` `github-app-auth-env.mjs` set for ITS OWN gh/git
    // calls. Left alone, that snapshot leaks into the spawned `claude` front-end and, transitively, into
    // anything its background-daemon infra bootstraps from it (a pre-warmed spare pool that then outlives
    // this one dispatch) — a token that never refreshes and eventually expires, exactly what the shim exists
    // to prevent. Strip it here so an App-authenticated `gh` call only ever happens behind the shim.
    // Spread `opts` FIRST and sanitize whatever env it carries — a caller-supplied `opts.env` (e.g.
    // deliver-item-wrapper's `{...process.env, ...deliveryEnv}`) must never replace the stripped env (PR #2600).
    ...opts,
    // #3383 — the spawned session is a WORKER; a hook-driven tick-once must never run in it (see
    // session-role.mjs). Composed with `sanitizeSpawnEnv` (PR #2600) rather than replacing it: the stripped-
    // GH_TOKEN env `sanitizeSpawnEnv` returns is what gets marked, so neither guard undoes the other's work.
    env: markWorkerEnv(sanitizeSpawnEnv(opts.env || process.env)),
  };
  try {
    return exec('claude', argv, execOpts);
  } catch (e) {
    if (!opts.cwd || !isTrustRefusal(e)) throw e;
    try { grantTrust(opts.cwd); } catch { /* grantDispatchTrust itself never throws; belt-and-suspenders */ }
    return exec('claude', argv, execOpts);
  }
}

/**
 * #3383 follow-up (the harder, per-agent-CPU half) — the ASYNC counterpart to {@link defaultSpawnAgent}, built
 * for a dispatch wrapper's own full-turn BLOCKING agent spawn, NOT for `defaultClaudeProvider`'s fire-and-forget
 * `--bg` dispatch (which stays on `defaultSpawnAgent`/`execFileSync` — it returns almost instantly once the CLI
 * backgrounds the session, so an async child-rusage read has nothing to offer there).
 *
 * WHY THIS EXISTS: `execFileSync` is a SYNCHRONOUS call that blocks the whole event loop for the entire agent
 * turn. This function still inherits `spawnToCompletion`'s full execFileSync-equivalence contract (stdout/
 * stderr capture, exit-code/signal/timeout/maxBuffer handling) unchanged.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {{spawnFn?: Function}} [io] - injected ONLY so a test can assert the spawn without a real `claude`.
 * @returns {Promise<{stdout: string, stderr: string, resourceUsage: object|null}>}
 */
export function spawnAgentToCompletion(argv, opts = {}, io = {}) {
  return spawnToCompletion('claude', argv, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts,
    env: markWorkerEnv(sanitizeSpawnEnv(opts.env || process.env)),
  }, io);
}

/** The dispatched agent's own standing identity, appended as a system prompt (#xqyyoje) — see the file's own
 *  header for why it is kept separate from the per-item prompt, not folded into `delivery-agent-brief.md`. */
export const DISPATCHED_AGENT_SYSTEM_PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills-src', 'conveyor', 'dispatched-agent-system-prompt.md');

/**
 * The `claude` argv for one dispatch. PURE and exported, because the argv IS the contract with the CLI and a
 * test that asserts it is the only thing standing between a flag rename and a silent non-dispatch.
 *
 * `--bg` starts the session and returns immediately; `-n` names the session so `claude agents` is legible to
 * an operator watching the pool.
 *
 * `--session-id` IS NOT EMITTED, AND THAT IS THE #3331 FIX — not an omission. Until this change this argv
 * carried `'--session-id', String(sessionId)` and the whole file treated that minted uuid as the spawned
 * session's real identity. It never was. `claude --bg` DISCARDS it and assigns its own id, printing
 * `warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing
 * session)` on stderr — measured 3/3 by #3331's own probe at CLI 2.1.246 (see that card's table) and
 * re-measured 2/2 at CLI **2.1.269** on 2026-09-11 with THIS exact argv, review brief and deny list included.
 * The cost was never a crash: the session starts fine and does its work (live-verified — `review-2129` ran to
 * a full accept verdict under an id nothing in this repo knew). The cost is that the dispatcher could not
 * ADDRESS what it started — `claude agents --json | grep <minted uuid>` is empty, no transcript exists under
 * that name, so every operator who looked concluded the dispatch had silently failed, and
 * {@link stampLiveness} read `live: false` for every in-flight dispatch, permanently, degrading the
 * double-dispatch guard to its clock backstop.
 *
 * WHERE THE HANDLE COMES FROM NOW: the id `claude --bg` PRINTS on stdout (`backgrounded · <id> · <name>`),
 * read by {@link parseBackgroundedId} and returned as the handle by {@link defaultClaudeProvider}. That short
 * id is the listing's own `id` field on a background row (measured: `fe8b4df8` ↔
 * `fe8b4df8-f682-46e4-a3a8-e7a2b772e88c`), which {@link listedSessionIds} now collects — so liveness matches
 * again. Reading the FULL `sessionId` back out of a post-spawn listing was considered and rejected for the
 * reason {@link resumeSucceeded}'s own docblock measured: a fresh session can take 26+ seconds to appear in
 * `claude agents --json`, which no synchronous spawn path here can afford to wait for.
 *
 * `sessionId` STAYS IN THE SIGNATURE. It is still minted by every caller and still ends up on the run entry as
 * the FALLBACK handle when stdout could not be parsed (see `createDispatchSinks`) — the same not-worse-than-
 * before behaviour — and `#xu2krte`'s resume path addresses a session by an id it learned elsewhere. What it
 * is no longer is a request to the CLI that the CLI ignores.
 *
 * `--append-system-prompt-file` (#xqyyoje), when `systemPromptFile` is given, adds the dispatched agent's
 * standing identity ahead of `extraArgs` and the prompt — a real CLI flag (`claude --help`), unused before this,
 * that gives a dispatched agent a way to tell "who am I, always" apart from "what am I doing right now" instead
 * of both arriving folded into one prompt string. Optional and defaulted to nothing (not
 * {@link DISPATCHED_AGENT_SYSTEM_PROMPT_FILE}) so this function stays PURE — no fs, no implicit path — the
 * caller resolves the real path and decides whether to pass it.
 *
 * THE PROMPT'S POSITION GUARANTEES NOTHING, which the first cut of this comment got wrong. `claude` parses with
 * commander, and commander accepts options intermixed with operands — a last positional beginning with `-` is
 * still read as a flag. Rather than bet on `--` being handled the way this file hopes (untested against the
 * real CLI, and a wrong bet turns into a dispatch with a mangled prompt), the dash is REFUSED outright. Every
 * legitimate brief starts with markdown, so the refusal costs nothing and proves what the position could not.
 *
 * `resumeSessionId` (`#xu2krte`) — OPT-IN, and it changes the WHOLE argv shape, not just one flag. A live
 * build-time probe (CLI 2.1.263, 2026-09-06; see
 * `docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted`) found `claude --bg --resume
 * <id>` genuinely continues the named session with NEW work injected — a real resume, not a re-attach to old
 * output — but ONLY when `--resume` is the ONLY flag passed alongside `--bg`. Adding `-n`, `--model`,
 * `--append-system-prompt-file`, or any other flag makes the CLI silently fork an unrelated copy under a FRESH
 * id instead (observed 3/3 tries, regardless of whether the original session was still live). So this branch
 * emits nothing else — no `-n`, no system-prompt file, no `extraArgs` — and the caller
 * (`we:scripts/conveyor/reconcile-fix-dispatch.mjs#dispatchFix`) is responsible for detecting a fork (the id the
 * CLI actually resumed under does not match `resumeSessionId`) via {@link parseBackgroundedId} /
 * {@link resumeSucceeded} and falling back to a fresh, full dispatch (this same function, `resumeSessionId`
 * omitted) when it does.
 */
/**
 * #x8mpubm — THE ONE PLACE a dispatch resolves whether (and how) to route a dispatched session's own `gh`
 * calls through the App-token shim (`we:scripts/lib/gh-app-shim.mjs`). NEVER throws: any failure (no real
 * `gh` on `PATH`, App auth not configured on this host, a read-only shim dir) resolves to `null`, meaning the
 * caller omits `--settings` entirely and the dispatch proceeds exactly as it would have before this existed.
 * A thin wrapper, not re-exported logic — `gh-app-shim.mjs` owns every real decision; this only guarantees
 * the "never blocks a dispatch" contract every sink in this file already holds itself to.
 *
 * `cwd` (#x8mpubm follow-up, live-caught 2026-09-24) — the checkout the dispatched session actually starts
 * in (`createDispatchSinks`' own `root`). Forwarded to `buildGhShimSettingsEnv` so it can ALSO write the same
 * PATH override into `<cwd>/.claude/settings.local.json`, the durable delivery path proven to reach a session
 * even when the CLI's own background-daemon pool serves the dispatch from an already-running "spare" and
 * silently drops `--settings`'s env (see `gh-app-shim.mjs`'s module header for the live evidence).
 * @param {string} [cwd]
 * @returns {Record<string,string>|null}
 */
export function resolveGhShimSettingsEnv(cwd) {
  try { return buildGhShimSettingsEnv({ cwd }); } catch { return null; }
}

/**
 * #x36vidg — the Bash-tool timeouts every dispatched session starts with. Claude Code's Bash tool MOVES a
 * command to the background once it passes its timeout (default `BASH_DEFAULT_TIMEOUT_MS` = 120000), and a
 * worker whose gate/pr-land/review loop got moved then hand-rolls a `sleep` poll over its own
 * `tasks/<id>.output` — measured at ~7h of idle in one day. Raising the DEFAULT to the documented 10-minute
 * ceiling (`BASH_MAX_TIMEOUT_MS`, also pinned here) removes that 2-minute trigger at its source: a long gate
 * simply runs to completion in the foreground. Names and semantics per code.claude.com/docs/en/env-vars;
 * settings-`env` values are read by Claude Code itself ("Claude Code reads them directly from the file").
 */
export const DISPATCH_BASH_TIMEOUT_ENV = Object.freeze({ BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '600000' });

/** The dispatched session's `--settings` env: the gh-App shim override (when this host opted in) plus the
 *  #x36vidg Bash timeouts (always). Never throws. */
export function resolveDispatchSettingsEnv(cwd) {
  return { ...(resolveGhShimSettingsEnv(cwd) || {}), ...DISPATCH_BASH_TIMEOUT_ENV };
}

/** Test/override hook for {@link dispatchSessionCwd} — mirrors `explore-io.mjs`'s `REPORT_DIR_ENV`. */
export const DISPATCH_CWD_ENV = 'WE_DISPATCH_CWD_ROOT';

/**
 * #4174 — WHERE A DISPATCHED SESSION'S CWD LIVES: `<workspace>/.operations/dispatch/<sessionId>`, a sibling of
 * `.lanes/` and of `explore-io.mjs#exploreScratchRoot`'s own scratch root — NEVER `root` itself (the checkout
 * that is dispatching this session).
 *
 * THE BUG THIS CLOSES. `createDispatchSinks` used to spawn every session with `cwd: root` — "the cwd the agent
 * starts in" before its brief's own first step acquires a lane clone of its own. A session that writes a
 * scratch/log file by a RELATIVE path in that window (a real one did, live, 2026-09-25) leaves an untracked
 * file in the DAEMON'S OWN clone. Self-sync then refuses the dirty clone, the clone falls behind `main`, and
 * every dispatch after that refuses as stale-main — measured at 125 invariant violations over 50 soak ticks
 * from ONE junk file (card #4174 / `we:backlog/xm5i1xm`, epic #4075).
 *
 * WHY A WORKSPACE-LEVEL DIRECTORY, not e.g. an ad-hoc `os.tmpdir()` mkdtemp per dispatch: `we:scripts/
 * guard-lane.mjs` denies an `Edit`/`Write` whose real path is inside a primary checkout or a lane clone it does
 * not occupy, and a report/scratch directory OUTSIDE every checkout is exactly the region clause 1 of
 * [#state-lives-where-its-nature-dictates](../../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates)
 * already puts session scratch in — the SAME region `explore-io.mjs` already uses for a panelist's report, for
 * the identical reason (see that file's own header). Reusing `workspaceRootOf` rather than re-deriving it means
 * "the region a dispatched agent may write to" and "the region this computes" stay one definition.
 *
 * PER-SESSION, not one shared directory: two sessions dispatched close together must never collide on the same
 * filename before either has acquired its own lane.
 *
 * NEVER CLEANED UP HERE. Whatever a session drops before it moves into its lane is harmless clutter (outside
 * every checkout, never read by anything), not a live daemon hazard for #4174's OWN proof — reclaiming it was
 * left to whoever owns `.operations/` scratch generally. UPDATE (#4188, bornAs `x5qketq`, epic #4075): that
 * owner now exists — `we:scripts/conveyor/session-reaper.mjs`'s dispatch-scratch sweep removes a finished
 * session's own folder here (plus the trust entry {@link grantDispatchTrust} granted it, via
 * {@link revokeDispatchTrust}) once it is old enough — this function's OWN root computation is what that sweep
 * enumerates, so the two can never disagree about where a dispatch's scratch cwd lives.
 *
 * @param {object} [o]
 * @param {string} [o.root] - this repo's checkout root (the dispatcher's own).
 * @param {Record<string, string|undefined>} [o.env]
 * @returns {string} the directory EVERY session's own scratch cwd is a child of — never a session-specific path.
 */
export function dispatchScratchRoot({ root = REPO_ROOT, env = process.env } = {}) {
  const override = String(env[DISPATCH_CWD_ENV] ?? '').trim();
  return override ? resolve(override) : join(workspaceRootOf(root), '.operations', 'dispatch');
}

/**
 * @param {string} sessionId - the same id {@link createDispatchSinks} mints for this dispatch; the path segment.
 * @param {object} [o]
 * @param {string} [o.root] - this repo's checkout root (the dispatcher's own).
 * @param {Record<string, string|undefined>} [o.env]
 * @returns {string}
 */
export function dispatchSessionCwd(sessionId, opts = {}) {
  return join(dispatchScratchRoot(opts), String(sessionId));
}

/**
 * EVERY POOL DIRECTORY a given repo's lanes could live under — `<workspace>/.lanes/<one of that repo's own
 * `dirs`>`, mirroring `bootstrap-session.mjs#poolRoots`'s own two-basename probe (`CONSTELLATION_REPOS.we.dirs`)
 * rather than re-deriving which basename this host actually uses. `repoKey` DEFAULTS to `'we'` — byte-identical
 * to every call site that predates xftsbsg and never passes one — but is no longer hardcoded: `we`/`frontierui`/
 * `plateau-app` each number their own lanes from 1 (all three exist simultaneously on a real host), so a caller
 * that KNOWS which repo a lane number belongs to (see {@link dispatchLaneGrant}) must say so, or this would
 * resolve a `frontierui`/`plateau-app` lane number to WE's own unrelated same-numbered lane — the xftsbsg defect.
 * PURE.
 * @param {string} [root]
 * @param {string} [repoKey]
 * @returns {string[]}
 */
function laneWorkspacePoolDirs(root = REPO_ROOT, repoKey = 'we') {
  const workspace = workspaceRootOf(root);
  const dirs = CONSTELLATION_REPOS[repoKey]?.dirs ?? CONSTELLATION_REPOS.we.dirs;
  return dirs.map((d) => join(workspace, '.lanes', d));
}

/**
 * #xrv69j6 (epic #4075) — THE ABSOLUTE DIRECTORY a given lane NUMBER resolves to, on THIS host, right now.
 *
 * WHY THIS IS KNOWABLE AT DISPATCH TIME, NOT ONLY AFTER `lane-pool.mjs acquire` RUNS INSIDE THE SESSION:
 * `we:scripts/operations/dispatch-lane.mjs`'s own `assigned-lane` guard THROWS before a dispatch is ever
 * cleared if `launch.lane` is null/empty, for every one of the six launch kinds (build/prepare/
 * prepare-decision/investigate/fix/ci-heal) — so by the time {@link createDispatchSinks}'s effect payload
 * reaches this function, a lane NUMBER already exists; only its absolute PATH does not yet.
 *
 * EXISTS-FILTERED, THEN FIRST CANDIDATE, same pattern as `bootstrap-session.mjs#primaryCheckout`'s own
 * basename probe: a real host has exactly one of the two pool-dir basenames provisioned, and probing for
 * whichever exists is more robust than hardcoding one. Falling back to the first candidate when NEITHER
 * exists yet (a lane number the pool has not grown to) still returns a real, deterministic path — better than
 * refusing to grant anything, and harmless: granting a not-yet-existing directory changes nothing the CLI
 * would otherwise refuse differently.
 *
 * `repoKey` (xftsbsg, default `'we'`, unchanged for every pre-existing caller) selects WHICH repo's pool to
 * probe — see {@link laneWorkspacePoolDirs}'s own header for why this can no longer be hardcoded.
 * @param {string|number} laneNum
 * @param {{root?:string, exists?:Function, repoKey?:string}} [o]
 * @returns {string}
 */
export function laneDirFor(laneNum, { root = REPO_ROOT, exists = existsSync, repoKey = 'we' } = {}) {
  const candidates = laneWorkspacePoolDirs(root, repoKey).map((poolDir) => join(poolDir, `lane-${laneNum}`));
  return candidates.find((p) => exists(p)) ?? candidates[0];
}

/**
 * THE DEFENSIVE FALLBACK's grant surface — every pool root that actually exists on this host, never a
 * primary checkout. Reached only when a dispatch payload carries no lane number at all, which the
 * `assigned-lane` guard above means should not happen through the normal `dispatch-lane` CLI path; kept so a
 * caller that invokes {@link createDispatchSinks}'s sink directly, bypassing that guard, still grants SOME
 * scoped directory rather than nothing. PURE over `exists`. `repoKey` — see {@link laneDirFor}'s own header.
 * @param {string} [root]
 * @param {Function} [exists]
 * @param {string} [repoKey]
 * @returns {string[]}
 */
export function laneRootsFor(root = REPO_ROOT, exists = existsSync, repoKey = 'we') {
  return laneWorkspacePoolDirs(root, repoKey).filter((p) => exists(p));
}

/**
 * #xrv69j6 — THE PERMISSION GRANT for one dispatch, given its effect payload. A lane number
 * (`payload.lane`) resolves to exactly that lane's directory (the common, expected case — see
 * {@link laneDirFor}'s own header for why this is always available today); its absence falls back to every
 * existing lanes-pool root ({@link laneRootsFor}) rather than refusing to grant anything. NEVER a primary
 * checkout either way. PURE over `exists`.
 *
 * xftsbsg — WHICH REPO'S POOL to resolve the lane number against is read off `payload.scope` (the same
 * repo-qualified scope {@link ../lib/repo-profile.mjs#repoKeyForScope} already knows how to read — every
 * mechanical build/fix/ci-heal payload carries one; see `we:scripts/operations/dispatch-lane-io.mjs#findItem`).
 * An empty/unrecognized scope falls back to `'we'` — byte-identical to this function's behavior before
 * xftsbsg, which is exactly right for the pre-existing (WE-only) callers whose own scope already reads `we:`.
 * @param {{lane?:string|number|null, scope?:string|string[]|null}} payload
 * @param {{root?:string, exists?:Function}} [o]
 * @returns {{additionalDirectories:string[], allow:string[]}}
 */
export function dispatchLaneGrant(payload, { root = REPO_ROOT, exists = existsSync } = {}) {
  const lane = payload?.lane;
  const repoKey = repoKeyForScope(payload?.scope) ?? 'we';
  const dirs = (lane != null && String(lane).trim() !== '')
    ? [laneDirFor(lane, { root, exists, repoKey })]
    : laneRootsFor(root, exists, repoKey);
  const rules = dirs.flatMap((d) => [`Edit(${d}/**)`, `Write(${d}/**)`]);
  if (['fix', 'ci-heal'].includes(payload?.launchKind)) rules.push(...conflictHelperAllowRules(root));
  return { additionalDirectories: dirs, allow: rules };
}

/**
 * #3850 (live-caught 2026-10-04, 151 "Workspace not trusted" refusals in the fix-dispatch log) — the policy
 * switch for TRUSTING THE SCRATCH ROOT. Default ON: a dispatch into `<root>/<uuid>` trusts `<root>` once, and
 * every later session dir under it is trusted by inheritance (the CLI walks a non-git cwd's ancestors for a
 * trusted entry — proven live, see the PR). `off`/`0`/`false`/`no` restores the old per-session-dir grant.
 */
export const DISPATCH_TRUST_ROOT_ENV = 'WE_DISPATCH_TRUST_ROOT';

/**
 * #3850 — the lock {@link grantDispatchTrust}/{@link revokeDispatchTrust} serialize on. ROOT CAUSE of the live
 * refusals: these two used `<trustPath>.lock`, which for `~/.claude.json` is the SAME path Claude Code's own
 * config lock uses — and Claude's is a DIRECTORY (mkdir-style lock). While any `claude` process held it, our
 * `open(…, 'wx')` hit EEXIST, waited out its 5s timeout, and the grant was silently swallowed, so the spawn ran
 * untrusted (and the one retry re-granted into the same wall). When the dir aged past 30s we "stole" it instead —
 * renaming a live CLI process's lock away (360 `~/.claude.json.lock.stolen.*` dirs on the host). Our own lock
 * now has its own name, so it never collides with, nor steals, the CLI's.
 * @param {string} trustPath
 */
export function dispatchTrustLockPath(trustPath) {
  return `${trustPath}.we-dispatch-trust.lock`;
}

/**
 * True when `dir` or any ancestor carries `hasTrustDialogAccepted: true` in `config.projects` — the same walk
 * the CLI does for a cwd outside a git repo (a dispatch scratch dir is never a repo). PURE.
 * @param {object|null} config
 * @param {string} dir
 */
export function isTrustedIn(config, dir) {
  const projects = config?.projects ?? {};
  let cur = resolve(String(dir));
  for (;;) {
    if (projects[cur]?.hasTrustDialogAccepted === true) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/**
 * #3850 — WHICH directory to trust for a dispatch cwd. A cwd under the dispatch scratch root resolves to the ROOT
 * (trusted once, inherited by every session dir after it); anything else (a lane, a test path) to itself, exactly
 * as before. {@link DISPATCH_TRUST_ROOT_ENV}=off restores the per-dir grant. PURE apart from the env read.
 * The root is collapsed to ONLY when it is the dispatcher-owned `…/.operations/dispatch` directory. A broader
 * `WE_DISPATCH_CWD` override (e.g. `$HOME/work`) would make the persistent trust cover every repo ever cloned under
 * it (hooks, MCP servers, project settings) and nothing revokes a root entry — those fall back to the per-dir grant.
 * @param {string} dir
 * @param {{env?: Record<string, string|undefined>, scratchRoot?: string}} [o]
 * @returns {string[]}
 */
export function dispatchTrustTargets(dir, { env = process.env, scratchRoot = dispatchScratchRoot({ env }) } = {}) {
  const d = resolve(String(dir));
  if (/^(0|off|false|no)$/i.test(String(env?.[DISPATCH_TRUST_ROOT_ENV] ?? '').trim())) return [d];
  const r = resolve(String(scratchRoot));
  if (!r.endsWith(`${sep}.operations${sep}dispatch`)) return [d];
  return d === r || d.startsWith(`${r}/`) ? [r] : [d];
}

/** How many times {@link grantDispatchTrust} re-reads and re-applies a grant a concurrent writer clobbered. */
export const DISPATCH_TRUST_GRANT_ATTEMPTS = 3;

/** Test/override hook for {@link grantDispatchTrust}'s trust file — mirrors {@link DISPATCH_CWD_ENV}. A
 *  soak/sim world points this at a throwaway file under its own root, so the REAL production mechanism runs
 *  unstubbed without ever touching the operator's actual `~/.claude.json`. */
export const DISPATCH_TRUST_PATH_ENV = 'WE_DISPATCH_TRUST_PATH';

function resolveDispatchTrustPath(env = process.env) {
  const override = String(env[DISPATCH_TRUST_PATH_ENV] ?? '').trim();
  return override ? resolve(override) : TRUST_PATH;
}

/**
 * #4174 live-caught — GRANT THE CLI'S OWN WORKSPACE TRUST for a freshly minted scratch cwd, in `~/.claude.json`
 * (or {@link DISPATCH_TRUST_PATH_ENV}'s override). NEVER THROWS. Reuses `bootstrap-session.mjs`'s PURE trust
 * logic (`readJsonConfig`, `withTrustedDirs`) rather than re-deriving it — but writes through its OWN small,
 * relocatable writer rather than that file's `defaultIo().writeTrust`, which is hardcoded to the real
 * `TRUST_PATH` with no override hook. The ONLY difference from `bootstrap-session.mjs`'s own use of the same
 * pieces is WHEN this runs: a lane pool is a small, bounded, REUSED set of directories, so trusting it once at
 * bootstrap covers every future dispatch into it forever. A dispatch scratch dir is a brand-new, never-reused
 * directory EVERY time (its own session id is the path segment), so there is no "once" to trust ahead of
 * time — this grants it at the one moment it is knowable: right before the spawn that needs it.
 *
 * LIVE EVIDENCE THIS IS NEEDED (2026-09-25): the very first real dispatch into a scratch cwd failed with
 * `claude --bg`'s own refusal — *"Workspace not trusted. Run \`claude\` in <dir> once and accept the trust
 * prompt, then retry."* — proving `--bg` enforces the SAME per-directory trust an interactive session does,
 * for a directory nothing had ever trusted before. Without this, EVERY dispatch into a fresh scratch dir would
 * fail this same way — the exact regression this whole card exists to prevent, reintroduced one layer up.
 *
 * FAIL-SOFT ON PURPOSE, same as `resolveGhShimSettingsEnv`: an unreadable/unparseable trust file writes
 * nothing (never rebuilds an operator's whole per-project CLI state from `{}`), and any other failure (no
 * permission, a lock-acquire timeout) is swallowed — the spawn still gets attempted, and if trust genuinely
 * could not be granted, the CLI's own refusal surfaces exactly as it did before this existed, visibly, rather
 * than this function pretending to have fixed it.
 *
 * LOCK-SAFE (#4188 follow-up, live-caught 2026-09-26) — the read-modify-write below now runs inside
 * {@link withFileLock}, the SAME lock {@link revokeDispatchTrust} takes on this identical file. Live evidence
 * this matters: a real dispatch-scratch revoke pass on this machine reported entries removed, but a fresh read
 * of `~/.claude.json` moments later still had every one of them — THIS function, running concurrently and
 * unlocked, had read a stale pre-revoke snapshot and written it straight back. Two callers of the SAME
 * unlocked read-modify-write can always silently undo each other; the lock is what makes "revoked" and
 * "granted" answers durable against each other, not just individually non-corrupting.
 * @param {string} dir
 * @param {{trustPath?: string}} [o] - injectable ONLY so a test can point it at a throwaway file instead of
 *   overriding process.env — the same seam `exec`/`spawnAgent` already are on this sink.
 */
export function grantDispatchTrust(dir, { trustPath = resolveDispatchTrustPath(), env = process.env, scratchRoot, afterWrite } = {}) {
  try {
    const targets = dispatchTrustTargets(dir, { env, ...(scratchRoot ? { scratchRoot } : {}) });
    // #3850 — the CLI's own `~/.claude.json` writes do NOT take our lock (they use `<trust>.lock`, which we must
    // never contend for or steal), so a CLI write can land between our read and our rename and drop the grant.
    // Atomic rename + a re-read that re-applies a lost grant (bounded) is what we can do without owning its lock.
    for (let attempt = 0; attempt <= DISPATCH_TRUST_GRANT_ATTEMPTS; attempt += 1) {
      const done = withFileLock(dispatchTrustLockPath(trustPath), () => {
        const before = readJsonConfig(trustPath);
        // `null` = present but unparseable (bootstrap-session.mjs's own `readJsonConfig` contract) — write
        // nothing, exactly as bootstrap-session.mjs's own trust step refuses to in that case.
        if (before === null) return true;
        // #3850 — already trusted: write NOTHING. A scratch ROOT target is trusted by the CLI's ancestor walk
        // (a dispatch scratch dir is never a git repo); any other target (a lane — a git worktree) needs its OWN
        // entry, since the CLI does not necessarily inherit an ancestor's trust there.
        const alreadyTrusted = (t) => (t !== resolve(String(dir))
          ? isTrustedIn(before, t) : before?.projects?.[t]?.hasTrustDialogAccepted === true);
        if (targets.every(alreadyTrusted)) return true;
        if (attempt === DISPATCH_TRUST_GRANT_ATTEMPTS) return true; // out of retries — never loop forever
        const next = withTrustedDirs(before, targets);
        // Backup-first, exactly matching bootstrap-session.mjs's own `writeTrust` discipline for this same file —
        // it holds the operator's whole per-project CLI state, not just this one directory's trust flag.
        const exists = existsSync(trustPath);
        if (exists) copyFileSync(trustPath, `${trustPath}.bak`);
        writeJsonAtomic(trustPath, next, exists ? { mode: statSync(trustPath).mode & 0o777 } : {});
        return false; // written — loop once more to confirm it survived
      });
      if (done) break;
      if (typeof afterWrite === 'function') afterWrite(attempt);
    }
  } catch { /* see docblock — never blocks a dispatch */ }
}

/**
 * #4188 (bornAs `x5qketq`, epic #4075) — {@link grantDispatchTrust}'s counterpart: REVOKE the trust entries a
 * finished, already-deleted dispatch-scratch cwd no longer needs. Called ONLY by the session reaper's
 * dispatch-scratch sweep (`we:scripts/conveyor/session-reaper.mjs`), and only ever with EXACT directory paths
 * that sweep just removed from disk itself — never a probed/derived list, never a lane or a primary checkout
 * (see {@link ../bootstrap-session.mjs#withoutTrustedDirs}'s own doc for why THAT distinction is what makes
 * this safe where the bootstrap step's own `withTrustedDirs` deliberately refuses to ever remove anything).
 *
 * WHY ATOMIC *AND* LOCKED, unlike {@link grantDispatchTrust}'s own plain `writeFileSync` (BEFORE this same
 * card also put it behind the identical lock — see that function's own doc): this file grows one entry per
 * dispatch forever (the whole reason #4188 exists), so a REMOVAL sweep runs unattended, on a schedule, against
 * the SAME `~/.claude.json` every other repo's trust state lives in. {@link writeJsonAtomic} (temp file +
 * rename, validated twice) makes a partial write structurally impossible; {@link withFileLock} (the SAME lock
 * `grantDispatchTrust` now takes) makes a LOST UPDATE impossible too. LIVE EVIDENCE THIS SECOND GUARANTEE IS
 * NEEDED, not merely defensive: before the lock existed, a real pass on this machine reported 81 entries
 * revoked, and a re-read of `~/.claude.json` moments later still had every one of them — a concurrent,
 * still-unlocked `grantDispatchTrust` call had clobbered the atomic write with its own stale snapshot. Atomicity
 * alone never protected against that; only mutual exclusion between the two writers does.
 *
 * FAIL-SOFT ON PURPOSE, same convention as `grantDispatchTrust`: an absent file, an unparseable one, or any
 * write failure (no permission, a lock-acquire timeout) all answer `{ revoked: [] }` rather than throwing — the
 * caller (the reaper) already deleted the scratch folder itself by the time this runs, so a trust-revoke
 * failure is a harmless stale entry, never a reason to treat the whole sweep as failed.
 * @param {string[]} dirs - exact directory paths to remove from `~/.claude.json`'s `projects` map.
 * @param {{trustPath?: string}} [o]
 * @returns {{revoked: string[]}}
 */
export function revokeDispatchTrust(dirs, { trustPath = resolveDispatchTrustPath() } = {}) {
  const list = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d) : [];
  if (!list.length) return { revoked: [] };
  // Unlike `grantDispatchTrust` (which legitimately creates the file fresh the first time anything is
  // trusted), a REVOKE has nothing to do if the file was never there — there is nothing to remove, and
  // creating an operator's `~/.claude.json` from scratch just to say "empty" would be a pointless, asymmetric
  // side effect a cleanup pass should never have.
  if (!existsSync(trustPath)) return { revoked: [] };
  try {
    return withFileLock(dispatchTrustLockPath(trustPath), () => {
      const before = readJsonConfig(trustPath);
      // `null` = present but unparseable — write nothing, same refusal `grantDispatchTrust` makes.
      if (before === null) return { revoked: [] };
      const next = withoutTrustedDirs(before, list);
      if (existsSync(trustPath)) copyFileSync(trustPath, `${trustPath}.bak`);
      writeJsonAtomic(trustPath, next);
      return { revoked: list };
    });
  } catch {
    return { revoked: [] }; // see docblock — never blocks the reaper's own sweep
  }
}

/**
 * ENSURE the directory a dispatched session's cwd is about to become actually exists AND is trusted. NEVER
 * THROWS — the same contract {@link resolveGhShimSettingsEnv} already holds itself to: a failure here (no
 * permission, a read-only workspace root, a stale non-directory at that path) must not itself block a
 * dispatch. A `cwd` that could not be created surfaces on its own, loudly, the moment the real spawn tries to
 * start a process in it — which `isPreSpawnRefusal` already classifies correctly (ENOENT/EACCES) rather than
 * this function papering over it one layer earlier.
 *
 * TRUST IS GRANTED ONLY WHEN `mkdir` ACTUALLY SUCCEEDED. Trusting a directory that was never created is
 * meaningless (the spawn into it fails regardless), and — the reason this is stated rather than merely
 * implied — it is what keeps this function inert against every FAKE root a unit test passes (`/primary/…`,
 * `/repo`, …): `mkdirSync` genuinely fails there (no permission to create a directory under `/`), so no test
 * that never overrides `mkdir` ever reaches the trust write at all, real filesystem or not.
 * @param {string} dir
 * @param {{mkdir?: (d: string) => void, grantTrust?: (d: string) => void}} [io] - injectable ONLY so a test can
 *   assert it without touching the real filesystem/`~/.claude.json` — the same seam `exec`/`spawnAgent`
 *   already are on this sink.
 * @returns {string} `dir`, unconditionally — the caller always gets a path back, made or not.
 */
export function ensureDispatchSessionCwd(dir, {
  mkdir = (d) => mkdirSync(d, { recursive: true }),
  grantTrust = (d) => grantDispatchTrust(d),
} = {}) {
  let made = false;
  try { mkdir(dir); made = true; } catch { /* see docblock — never blocks a dispatch */ }
  if (made) grantTrust(dir);
  return dir;
}

export function buildAgentArgv({
  sessionId, payload, extraArgs = [], systemPromptFile = null, resumeSessionId = null, settingsEnv = null,
  // #x9fbg1x — an OPT-IN `worktree` patch folded into the SAME `--settings` JSON `settingsEnv` already rides
  // in. `null` (every existing caller/test that never mentions it) keeps this function's argv byte-identical
  // to before this param existed — only `createDispatchSinks`' own resolver ever supplies a real value.
  worktreeSettings = null,
  // #3857 — `table` is the checked-in model-tier table's answer for THIS dispatch ({tier, model, reason} — see
  // `../lib/provider-routing.mjs#workerTierFor` and {@link workerModelTable}). Explicit routing takes
  // precedence; with no `table`, the launch kind's own tier is used, and a spawn with no resolvable model is
  // refused (operator rule 2026-09-29: every fresh Claude launch passes an explicit --model).
  table = null, modelReason = null,
}) {
  const prompt = String(payload?.prompt || '');
  if (!prompt.trim()) throw notApplied('dispatch-lane: refusing to start an agent with an empty prompt');
  if (prompt.trimStart().startsWith('-')) {
    throw notApplied('dispatch-lane: refusing a brief that begins with `-` — an argument parser can read it as a flag');
  }
  // `settingsEnv` (#x8mpubm) is DELIBERATELY NEVER EMITTED HERE — the resume branch's own docblock (above)
  // measured live that adding ANY flag beside `--resume` makes the CLI silently fork a fresh copy instead of
  // truly resuming. A resumed session does not need it anyway: it is the SAME still-running process its first,
  // fresh dispatch already gave a `--settings` PATH override to (see the non-resume branch below), and the
  // shim that override points at re-reads the shared token cache fresh on every `gh` call regardless of how
  // long the session has been running — so nothing is lost by never re-asserting it on resume.
  if (resumeSessionId) return ['--bg', '--resume', String(resumeSessionId), prompt];
  if (!table && payload?.launchKind) {
    const policy = readRoutingPolicy();
    const configured = resolveOperationRoute({ operation: payload.launchKind, available: ['claude'], gateClosed: policy.criticalWorkGate.kinds.includes(payload.launchKind), policy });
    if (configured) table = { model: configured.model, effort: configured.effort, reason: 'routing-policy' };
  }
  // NO `--session-id` — see this function's own header. `sessionId` is deliberately unreferenced here.
  void sessionId;
  // xgqz204 — the worker marker ALWAYS rides in `--settings`' env: `claude --bg` drops the spawner's ambient
  // env, so `markWorkerEnv` on the spawn call never reaches the session, and the #x36vidg wait-poll guard read
  // every dispatched session as the operator's own. See `workerMarkerSettingsEnv`.
  const sessionEnv = workerMarkerSettingsEnv(settingsEnv);
  // #3857 — the decided model goes FIRST as exactly one `--model <id>`; a hand-set one in `extraArgs` is
  // honoured only with a reason (see {@link resolveWorkerModel}), and never left riding alongside.
  let args = extraArgs.map(String);
  const modelArgs = [];
  const effortArgs = [];
  let explicitEffort;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--effort') explicitEffort = args[++i] ?? '';
    else if (args[i].startsWith('--effort=')) explicitEffort = args[i].slice(9);
  }
  const effort = explicitEffort ?? table?.effort ?? resolveOperationEffort(payload?.launchKind ?? 'build', 'claude');
  try { resolvePolicyEffort('claude', effort); } catch (error) { throw notApplied(error.message); }
  if (explicitEffort === undefined) effortArgs.push('--effort', effort);
  if (table) {
    const decision = resolveWorkerModel({ extraArgs: args, table, modelReason });
    if (decision.refusal) throw notApplied(`dispatch-lane: ${decision.refusal}`);
    args = decision.cleanArgs;
    if (decision.model) modelArgs.push('--model', claudeSpawnAlias(String(decision.model)));
  } else {
    const explicit = extractModelFlag(args);
    const kind = payload?.launchKind ?? 'build';
    const tier = [...LAUNCH_KINDS, 'review', 'inspect'].includes(kind)
      ? workerTierFor({ kind }).tier : null;
    const model = explicit.found ? explicit.value : CLAUDE_SPAWN_MODEL_BY_TIER[tier];
    args = explicit.rest;
    if (model) modelArgs.push('--model', model);
  }
  // Operator rule 2026-09-29: a fresh session must never inherit the CLI default.
  // Resume returns above and retains the existing session's model.
  if (typeof modelArgs[1] !== 'string' || !modelArgs[1].trim() || modelArgs[1].startsWith('-')) {
    throw notApplied('dispatch-lane: refusing to start an agent without a resolvable --model');
  }
  return [
    '--bg',
    '-n', String(payload.sessionSlug || `conveyor-${payload.num}`),
    // #x8mpubm — a `PATH` (or other) override, folded into `--settings '{"env":{...}}'`. THIS is how a
    // dispatched session's own `gh` calls end up authenticating as the App installation: `claude --bg` does
    // NOT inherit the spawning process's ambient env (live-confirmed — see gh-app-shim.mjs's own header), but
    // DOES apply `--settings`'s `env` to the session's own Bash-tool subprocess environment (also
    // live-confirmed). Omitted entirely when `settingsEnv` is `null`/empty — a caller that never resolves one
    // (or a host with App auth unconfigured) gets a `--bg` argv byte-identical to before this existed.
    // xgqz204: never omitted any more — it always carries at least the worker marker (see above).
    // #x9fbg1x — `worktree` rides in the SAME object, never a second `--settings` flag (the CLI would only
    // honour the last one anyway).
    '--settings', JSON.stringify(worktreeSettings ? { env: sessionEnv, worktree: worktreeSettings } : { env: sessionEnv }),
    ...(systemPromptFile ? ['--append-system-prompt-file', String(systemPromptFile)] : []),
    ...(table ? [...effortArgs, ...modelArgs] : []),
    ...args,
    ...(!table ? [...effortArgs, ...modelArgs] : []),
    prompt,
  ];
}

/**
 * Extract a hand-set `--model`/`-m`/`--model=` flag from an argv-shaped list. PURE. Returns the flag's value
 * (the LAST occurrence wins, matching the CLI's own repeated-flag rule) and the list with every occurrence
 * removed, so a caller never has to re-scan for what it just found.
 *
 * @param {string[]} args
 * @returns {{found: boolean, value: string|null, rest: string[]}}
 */
function extractModelFlag(args) {
  let value = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--model' || a === '-m') { value = args[i + 1] != null ? String(args[i + 1]) : ''; i += 1; continue; }
    if (a.startsWith('--model=')) { value = a.slice(8); continue; }
    rest.push(a);
  }
  return { found: value !== null, value, rest };
}

/** A model name that names Fable — never a worker model, even with a recorded reason (operator rule, #3857). */
function namesFable(model) {
  return /fable/i.test(String(model ?? ''));
}

/**
 * THE MODEL DECISION for one dispatch's spawn (#3857) — resolves the worker's Claude model from the checked-in
 * model-tier table ({@link ../lib/provider-routing.mjs#workerTierFor}, reached through
 * {@link ../lib/dispatch-contracts.mjs#decideDispatchRoute}) UNLESS the caller hand-set one in `extraArgs`
 * ({@link AGENT_ARGS_ENV}) WITH a recorded `modelReason` — the one sanctioned per-dispatch OVERRIDE (mirrors
 * #3840's `deliveryAgent:`/`deliveryAgentReason:` shape for the provider axis).
 *
 * PURE and NEVER THROWS: a disallowed combination comes back as a named `refusal` for the caller to refuse
 * BEFORE any process exists. `cleanArgs` is `extraArgs` with every `--model`/`-m`/`--model=` token removed, so
 * a caller that injects the DECIDED model can never also leave the hand-set one riding alongside it.
 *
 * @param {{extraArgs?: string[], table: {tier: string, model: string, reason?: string|null}, modelReason?: string|null}} o
 * @returns {{model: string|null, tier: string|null, source: 'table'|'override', tableTier: string|null, reason: string|null, cleanArgs: string[], refusal: string|null}}
 */
export function resolveWorkerModel({ extraArgs = [], table, modelReason = null } = {}) {
  const handSet = extractModelFlag(extraArgs.map(String));
  const reason = modelReason == null ? '' : String(modelReason).trim();
  const tableTier = table?.tier ?? null;
  const asTable = { model: table?.model ?? null, tier: tableTier, source: 'table', tableTier, reason: table?.reason ?? null, cleanArgs: handSet.rest };
  if (handSet.found && !reason) {
    return {
      ...asTable,
      refusal: `a hand-set --model in ${AGENT_ARGS_ENV} with no --modelReason is refused — #3857's model-tier `
        + 'table decides the worker\'s tier; give --modelReason=<text> naming why this dispatch departs from it',
    };
  }
  if (!handSet.found && reason) {
    return { ...asTable, refusal: '--modelReason was given but no --model was set in extraArgs to explain — refusing a reason for nothing' };
  }
  if (handSet.found && reason) {
    if (namesFable(handSet.value)) {
      return { ...asTable, refusal: `refusing model ${JSON.stringify(handSet.value)} — Fable is never a worker model, even with a reason` };
    }
    return { model: handSet.value, tier: tableTier, source: 'override', tableTier, reason, cleanArgs: handSet.rest, refusal: null };
  }
  return { ...asTable, refusal: null };
}

/**
 * we:scripts/operations/dispatch-lane-io.mjs#parseBackgroundedId — PURE: read the short handle `claude --bg`
 * prints back on stdout (`backgrounded · <id>` or `backgrounded · <id> · <name>`), whichever of the two shapes
 * the CLI used in the live probe above. Returns `null` when the text does not match — a caller must treat that
 * as "outcome unknown", never as "resume failed" (see {@link resumeSucceeded}).
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseBackgroundedId(stdout) {
  const m = /backgrounded\s*(?:·|-)\s*([0-9a-zA-Z-]{6,36})/.exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

/**
 * we:scripts/operations/dispatch-lane-io.mjs#resumeSucceeded — PURE: did a `buildAgentArgv({resumeSessionId})`
 * dispatch genuinely continue the requested session, or did the CLI fork a copy under a fresh id?
 *
 * DELIBERATELY NOT A STRING-PREFIX COMPARISON. `claude agents --json`'s own `id` field is not reliably a
 * derived prefix of `sessionId` for every listing shape (see {@link listedSessionIds}'s own docblock) — so
 * rather than assume `id === sessionId.split('-')[0]`, this cross-references the printed handle against a REAL
 * post-spawn listing (`claude agents --json --all`, read fresh by the caller) by exact `id` match, then compares
 * THAT row's own `sessionId` against the id requested. Both sides run through {@link normalizeHandle}, matching
 * every other session-id comparison in this file.
 *
 * `id` ON A `background` ROW, MEASURED, TWICE (`#3541`, follow-up from PR #1966's independent review): a live
 * `claude agents --json --all` read (CLI 2.1.263, 2026-09-06) found 259/259 `kind:'background'` rows carrying
 * `id` and 0/4 `kind:'interactive'` rows carrying it — the same split `we:scripts/conveyor/session-reaper.mjs`'s
 * own header measured for its domain on 2026-09-03 (204/204 vs 0/4). So the scenario this function's own
 * `#x3gdu12` origin story worried about — a `background` row for a genuinely-resumed session silently missing
 * `id` — has never once been observed; `listedSessionIds`'s "absent from roughly half the listing" is entirely
 * the `interactive` half.
 *
 * NO POSITIVE FALLBACK — TWO WERE TRIED, TWO WERE FOUND UNSAFE, AND THE SECOND FAILURE MEASURED WHY THE FIRST
 * COULD NEVER BE PATCHED INTO SAFETY. This item's own build history:
 *   1. A `sessionId`-only fallback (no `id` needed): "no new session appeared anywhere since `agentsBefore`" ⇒
 *      resumed. An independent review round found this could resolve `true` on the FIRST post-resume read, on
 *      the strength of a fork whose row simply had not propagated into the listing yet — the identical lag
 *      `dispatchFix`'s own Hardening 2 retry loop exists to absorb for the id-match path.
 *   2. Gated the same fallback on `isFinalAttempt` (only trust the absence-of-evidence once the retry loop's
 *      last attempt is reached). A SECOND independent review round found this only bounds the wait to
 *      `RESUME_CONFIRM_MAX_ATTEMPTS × RESUME_CONFIRM_WAIT_MS` (~600ms) — and a fork's row can take far longer
 *      than that to appear. MEASURED, not assumed: a live probe (2026-09-07) spawned a fresh `claude --bg`
 *      session and polled `claude agents --json --all` for it every ~700ms — it had STILL not appeared after
 *      26+ seconds, on this same machine, under its ordinary background-session load. No fixed short retry
 *      budget can outrun a lag of that shape, and `dispatchFix` cannot afford to block tens of seconds per
 *      resume attempt either (it "sits synchronously inside a waker pass that promises to stay fail-soft and
 *      fast per run" — see this file's own `TICK_TIMEOUT_MS`/`SPAWN_TIMEOUT_MS` budgets for the same
 *      discipline elsewhere).
 * Both designs answer "no new session — therefore resumed" from ABSENCE of evidence, and absence read against
 * an unbounded-latency listing can never be trusted at any fixed budget. A REJECTED FIX from the item's own
 * origin story, restated because it fails for the identical underlying reason: "is `requestedSessionId` still
 * listed at all" cannot disambiguate either, since the pre-resume session stays listed under EITHER outcome.
 *
 * THE CONCLUSION, stated plainly rather than papered over with a third attempt: there is no way to positively
 * confirm a resume from the listing alone within a budget `dispatchFix` can afford, when the id-match itself
 * comes back empty. So this function does NOT try — on a missing `id`, it answers `resumed:false`, exactly the
 * pre-#3541 behavior, and the caller's existing `stop(printedId)` cleans up (correctly, for an actual fork; a
 * wasted-but-recoverable attempt, for the never-yet-observed missing-`id` shape). This is the safe DIRECTION,
 * argued once and applied consistently: a false stop costs a wasted resume attempt plus a redundant fresh
 * dispatch, and the fix still lands; a false resume reports success while the real work silently never happens
 * (the untouched candidate never sees the new prompt) and leaves an unmanaged forked session running unstopped.
 * Between a residual that has NEVER been observed (missing `id`) and one just MEASURED to be real and immediate
 * (unbounded listing lag), the honest choice is to not trade the second for a hedge against the first.
 *
 * THE ONE THING ADDED: an `anomaly` DIAGNOSTIC, never a verdict input. When the id-match fails but
 * `requestedSessionId` is still listed under a row that carries no `id` at all, that IS the never-observed
 * shape this item was filed to worry about — worth a name on the record for whoever reads the run later, even
 * though it changes nothing about the (safe) `resumed:false` answer.
 * @param {{printedId:string|null, requestedSessionId:string, agentsAfter:Array<object>}} o
 * @returns {{resumed:boolean, actualSessionId:string|null, actualShortId:string|null, anomaly?:string}}
 */
export function resumeSucceeded({ printedId, requestedSessionId, agentsAfter }) {
  if (!printedId) return { resumed: false, actualSessionId: null, actualShortId: null };
  const norm = normalizeHandle(printedId);
  const after = Array.isArray(agentsAfter) ? agentsAfter : [];
  const row = after.find((a) => normalizeHandle(a?.id) === norm);
  if (row) {
    const actualSessionId = normalizeHandle(row.sessionId) || null;
    return {
      resumed: Boolean(actualSessionId) && actualSessionId === normalizeHandle(requestedSessionId),
      actualSessionId,
      actualShortId: printedId,
    };
  }

  // THE DIAGNOSTIC ONLY — see the docblock above. `sessionId` is present on every row regardless of shape
  // (unlike `id`), so this can tell "the requested session is listed but its row has no `id`" apart from
  // "nothing named it at all" without needing a pre-resume snapshot. It NEVER flips `resumed`.
  const reqNorm = normalizeHandle(requestedSessionId);
  const requestedRow = after.find((a) => normalizeHandle(a?.sessionId) === reqNorm);
  const anomaly = requestedRow && !requestedRow.id ? 'requested-session-listed-without-id' : null;
  return {
    resumed: false, actualSessionId: null, actualShortId: printedId,
    ...(anomaly ? { anomaly } : {}),
  };
}

/**
 * THE OBSERVER — the #3084 half that asks how a dispatched build is going, on TWO axes (#x9ylkp7).
 *
 * WHY LIVENESS ALONE COULD NEVER ANSWER `succeeded`. `claude agents --json` reports LIVENESS: a session is in
 * the list or it is not. It carries no exit status, no outcome, and (measured on 2.1.220, with `--all`) no
 * terminal record for a completed session at all. So "the session is gone" collapses *finished cleanly* and
 * *died* into one observation, and the vocabulary has exactly one honest word for that: `unresolved` —
 * terminal for the observer, actionable by a person, WRITES NOTHING. Answering `succeeded` on liveness alone
 * would record `applied` for a build that may have crashed, and the run would advance past the step that
 * exists to react to it. That has not changed and must not.
 *
 * THIS IS WHY `--all` IS NOT PASSED. It also lists COMPLETED sessions, so a finished build would keep reading
 * as `running` forever — the one mistake that makes an observer worse than none.
 *
 * THE REAL COMPLETION SIGNAL IS THE PR, AND IT IS NOW READ. A delivery agent's outcome exists somewhere the
 * agent listing cannot see: the pull request it opened, which `we:scripts/conveyor/pr-watch.mjs` already
 * classifies to a terminal state. {@link classifyDispatchPr} finds this entry's PR by ITEM ID over the head
 * refs and hands it to that same `classifyPr`, so exactly ONE classification — `merged` — reaches `succeeded`.
 * `closed` (abandoned unmerged, or a manual close) and `parked` (mid-review, not failed) are AMBIGUOUS for this
 * purpose and still answer `unresolved`; `pending` means "no verdict from the PR axis" and falls through to the
 * liveness logic below, unchanged. Conflating *terminal* with *succeeded* is the exact bug this axis exists to
 * close, so it is not enough that a PR reached an end state.
 *
 * THE PR AXIS RUNS FIRST, deliberately. A merged PR with a still-listed session is a real and expected shape —
 * the agent's last act is `pr-land`, and it exits some seconds later — and that build IS done. Ordering
 * liveness first would report it `running` for as long as the session lingered, i.e. the axis would be a
 * fallback that the common case never reaches.
 *
 * WHAT IT REFUSES TO RESOLVE ON: a STALE PR. Re-dispatch of one item is a designed path (the executor mints a
 * fresh handle per retry and keeps `supersededHandles`; `dispatch-lane.mjs#dispatchStillHolds` ages a hold out
 * so a second attempt can start at all), and under id-matching a PREDECESSOR's merged PR matches the new entry
 * just as well as its own would. Resolving on it would mark a build that has barely begun `applied` on the
 * strength of an earlier attempt — the same conflation arriving through the back door. So a merge is only this
 * entry's if it happened at or after the entry's `startedAt`; anything else answers `unresolved`.
 *
 * WHAT THE MANUAL PATH STILL COSTS. Nothing here removes `wake.mjs`'s `closeOutEntry`
 * (`--resolve=<runId> --key=<effectKey> --status=applied|failed`): the two coexist, and the manual one remains
 * the answer for every genuinely ambiguous entry — which is still every dispatch that never reaches a PR.
 *
 * ONE LISTING PER PASS, PER AXIS. Both reads are built once per pass and MEMOIZED, so a run with several
 * in-flight entries — or several parked runs in one pass — costs one subprocess each, not one per entry. Build
 * a fresh table for a fresh pass; the CLI at the bottom of `we:scripts/operations/wake.mjs` does exactly that.
 *
 * @param {object} [o]
 * @param {() => object[]} [o.listAgents] - injectable `claude agents --json` reader.
 * @param {() => object[]} [o.listPrs] - injectable `gh pr list` reader. Same seam, same reason: the whole PR
 *   axis is testable with no network and no `gh`.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT readers go through. See
 *   {@link readTick} for why this is a second seam and not the same one. Defaults to
 *   {@link execFileSyncThrottled} (#4415 round 2) — never a bare `execFileSync`.
 * @param {() => Date} [o.now]
 * @param {(pid: number) => boolean} [o.isPidAlive] - #3645/#4212: the liveness probe for a DETACHED
 *   delivery-wrapper handle (`pid:<n>`). Injectable for the same reason `listAgents`/`listPrs` are: the whole
 *   axis must be testable with no real process to signal.
 * @returns {Record<string, Function>} effect type → `async (entry, ctx) => {status, result?, error?}`.
 */
export function createDispatchObservers({
  exec = execFileSyncThrottled,
  observeHeal = observeHealAttempt,
  listAgents = () => defaultListAgents({ exec }),
  listPrs = () => defaultListPrs({ exec }),
  isPidAlive = defaultIsPidAlive,
  now = () => new Date(),
} = {}) {
  // `undefined` is the not-yet-read sentinel, NOT `null`: a reader that returns `null` (or anything else the
  // check below refuses) must still be memoized, or every entry re-shells it — the exact per-entry cost this
  // memo removes. A THROW is not memoized, so a transient failure is retried rather than poisoning the pass.
  let listed;
  let prList;
  return {
    [DISPATCH_EFFECT]: async (entry, ctx) => {
      const handle = String(ctx?.handle ?? entry?.handle ?? '');
      if (entry?.payload?.launchKind === 'ci-heal' && entry?.dispatch?.attemptId) {
        return observeHeal(entry.dispatch.attemptId, { handle, pr: entry.payload.pr, repo: entry.payload.repo ?? 'we', ...(isPidAlive === defaultIsPidAlive ? {} : { isPidAlive }), now });
      }

      // ── AXIS 1: THE PR. The only axis that can ever say `succeeded`. ─────────────────────────────────────
      //
      // LAZY, so an entry the axis cannot use (no item id on its payload) spends no subprocess, and a pass
      // with nothing to look up shells no `gh` at all.
      //
      // A READ THAT FAILS IS NOT A VERDICT. `gh` missing, unauthenticated, rate-limited or wedged degrades
      // this axis to OFF and falls through to liveness — exactly today's behaviour — rather than taking down
      // an observer whose other axis still works. The lease reaper makes the same trade for the same reason
      // (`fetchPrStates`: "any gh failure disables the axis"). It is the fail-SAFE direction: the cost is a
      // completed build still needing a person, which is the status quo this item improves on, never a
      // running build resolved on no evidence.
      const num = entry?.payload?.num ?? null;
      if (normNum(num)) {
        if (prList === undefined) {
          try { prList = listPrs(); } catch { prList = null; }
        }
        // #3110 — this entry's own attempt identity, off the SAME sessionSlug already persisted on its
        // payload (no new field, no new IO): `''` for a first attempt, a letter for a retry, `null` for a
        // legacy payload with no sessionSlug at all (degrades to the tag-blind behaviour).
        const attempt = sessionSlugAttemptTag(entry?.payload?.sessionSlug ?? null);
        const { verdict, pr } = classifyDispatchPr({ num, startedAt: entry?.startedAt, prs: prList, attempt });
        if (verdict === 'merged') {
          // THE ONE PLACE `succeeded` BECOMES REACHABLE. `resolveInFlight` records `applied` and the run
          // advances — which is correct precisely because a merged PR is a CLEAN outcome, the one thing no
          // later step needs to react to. The result names the evidence, so the record says WHY it resolved.
          return {
            status: 'succeeded',
            result: {
              resolvedBy: 'pr-merged',
              pr: pr?.number ?? null,
              headRefName: pr?.headRefName ?? null,
              mergedAt: pr?.mergedAt ?? null,
            },
          };
        }
        if (verdict !== 'pending') {
          return { status: 'unresolved', error: unresolvedPrReason(verdict, pr, entry) };
        }
      }

      // ── AXIS 2: LIVENESS. What answers while no PR exists yet, which is every dispatch for most of its
      //    life, and the dominant case until real dispatch lands.
      //
      // #3645/#4212 — A MECHANICAL BUILD IS ANSWERED BY THE KERNEL, BEFORE ANY `claude agents` CALL. The
      // delivery wrapper runs in its own detached process and was never a `--bg` session, so it is not in that
      // listing and never will be; asking anyway would read "gone" for a delivery that is an hour into its
      // build. The grace-window and `unresolved` branches below are shared verbatim — only the liveness
      // QUESTION differs, not what is done with its answer.
      const detachedPid = detachedHandlePid(handle);
      if (detachedPid !== null) {
        if (isPidAlive(detachedPid)) return { status: 'running', result: null };
        const startedDetached = entry?.startedAt ? Date.parse(entry.startedAt) : NaN;
        if (!Number.isNaN(startedDetached) && now().getTime() - startedDetached < LISTING_GRACE_MS) {
          return { status: 'running', result: null };
        }
        return {
          status: 'unresolved',
          error: `the delivery wrapper process ${handle} has exited, which reports liveness and not outcome, and no `
            + 'MERGED PR for this item can be attributed to this dispatch — whether the build finished cleanly cannot '
            + `be told from here. Read its log (\`${deliveryDispatchLogPath(entry?.payload?.sessionSlug ?? '')}\`) and `
            + 'its delivery report, then close the entry out.',
        };
      }

      if (listed === undefined) listed = listAgents();
      const sessions = listed;
      if (!Array.isArray(sessions)) {
        throw new TypeError('dispatch-lane-io: `claude agents --json` did not return an array');
      }
      // PARSED FINE, YIELDED NOTHING MATCHABLE — the same refusal as not-an-array, and for the same reason.
      // A listing with elements in it but no usable `sessionId` on any of them is a shape this reader does not
      // understand. Falling through would put the entry into the `unresolved` branch below on the strength of
      // a read that told us nothing, so it raises instead and the observer's caller sees the read failed
      // (PR #1211 round-3 review, H1/H2).
      const listedIds = listedSessionIds(sessions);
      if (sessions.length && !listedIds.size) {
        throw new TypeError(
          'dispatch-lane-io: `claude agents --json` returned '
          + `${sessions.length} element(s) but not one carried a usable \`sessionId\` — the listing was read and `
          + 'not understood, which is not evidence that any session ended',
        );
      }
      // #3645/#4212 — through {@link isHandleListed}, so this reader and {@link stampLiveness}'s own listing
      // compare cannot drift.
      const live = isHandleListed(handle, sessions);
      if (live) return { status: 'running', result: null };

      // NOT-YET-LISTED IS NOT GONE. `--bg` returns before the session is necessarily visible, so a poll inside
      // the grace window still reads as running rather than closing out a build that is still starting.
      const started = entry?.startedAt ? Date.parse(entry.startedAt) : NaN;
      if (!Number.isNaN(started) && now().getTime() - started < LISTING_GRACE_MS) {
        return { status: 'running', result: null };
      }
      return {
        status: 'unresolved',
        error: `session ${handle} is no longer listed by \`claude agents\`, which reports liveness and not outcome, `
          + 'and no MERGED PR for this item can be attributed to this dispatch — whether the build finished cleanly '
          + 'cannot be told from here. Check its PR, then close the entry out.',
      };
    },
  };
}

/** The operator-facing reason one ambiguous PR verdict is NOT a resolution. Pure; never a status. */
function unresolvedPrReason(verdict, pr, entry) {
  const at = pr?.number ? `PR #${pr.number} (${pr.headRefName})` : 'its PR';
  if (verdict === 'stale') {
    return `every PR matching this item is a PREVIOUS attempt's — terminal before this dispatch started `
      + `(${entry?.startedAt ?? 'unknown start'}) — so none of them says anything about THIS build. Resolving on one `
      + 'would mark a build that may have barely begun `applied`. Check the item, then close the entry out.';
  }
  if (verdict === 'parked') {
    return `${at} is PARKED for review, which is mid-flight rather than an outcome — the build may still be `
      + 'corrected and re-landed. Land or close the PR, then close the entry out.';
  }
  return `${at} is CLOSED UNMERGED, which is terminal but is NOT success — an abandoned build and a manual close `
    + 'look identical from here. Check what happened, then close the entry out.';
}

/**
 * THE PR AXIS, PURE. Which verdict this entry's own PR supports, given one bounded `gh pr list` page.
 *
 * DISCOVERY IS BY ITEM ID OVER THE HEAD REFS, not by branch name — the fork this item ruled (approach 1). A
 * dispatch entry carries NO PR reference and cannot: the payload holds `num`, `lane`, `sessionSlug`,
 * `itemSpecPath`, `scope`, `prompt`, `expectedWithinMinutes`, and the head ref is minted LATER by the agent
 * itself (`pr-land --ref=lane/{{ITEM_NUM}}-<slug>`, with the slug invented at that moment). So the exact ref is
 * unknowable at observe time and `gh pr list --head` could only ever return empty. The repo already solved
 * this: {@link laneRefItemNum} — pure, unit-tested, shared with the lease reaper — is the matcher, so the two
 * can never disagree about which ref belongs to which item.
 *
 * THE STALE GUARD CATCHES A MERGE BEFORE MY START; THE ATTEMPT-TAG GUARD (#3110) CATCHES ONE AFTER IT. Ids
 * match a predecessor's PR as well as this build's, so on their own they answer only WHEN a merge happened,
 * never WHOSE attempt it belongs to. `startedMs` answers the first question (a merge before `startedAt`
 * belongs to a previous attempt); `attempt` answers the second, independently — the two are ANDed, not merged
 * into one check, so neither can quietly redefine what "belongs to this entry" means for the other (the
 * residual this function's own review once flagged: two guards on one function must agree on that, not each
 * invent an answer). A MISSING or unparseable `startedAt` fails CLOSED on the first axis (verdict `stale`); a
 * PR whose OWN attempt tag is resolvable but does not match `attempt` fails closed on the second (excluded
 * from `mine` entirely, before the stale filter even runs — it is not this entry's PR at all, not merely late).
 *
 * `attempt`/a candidate's tag is `''` for an unsuffixed first attempt, `'b'`/`'c'`/… for a retry, or `null` when
 * unresolvable (a legacy dispatch, from before this session slug / branch name ever carried one). `null` on
 * EITHER side degrades to today's tag-blind behaviour (only `startedAt` decides) — so nothing already in
 * flight when this shipped, and no future entry whose slug happens not to parse, loses its existing coverage.
 * The one case this still does not close, per #3110's own filing: an entry resolved and closed OUT before a
 * later retry began (its in-flight record is gone, so it no longer holds a comparable tag) whose PR somehow
 * merges long after — see `we:scripts/operations/dispatch-lane.mjs`'s attempt-count comment for why that
 * residual is bounded to an already-resolved, already-closed-out entry, not a still-open one.
 *
 * VERDICT PRIORITY among the PRs that survive the stale filter: `merged` > `pending` > `parked` > `closed`.
 * `pending` outranks the two ambiguous terminals on purpose — an item with an abandoned PR AND a live open one
 * must keep waiting on the live one, the same "open wins" safety the reaper's `prStatesFromList` applies for
 * the same reason (the #2267 data-loss case, from the other side).
 *
 * @param {object} o
 * @param {string|number|null} o.num - the item id off the entry's payload.
 * @param {string|null} [o.startedAt] - when THIS dispatch attempt started.
 * @param {object[]|null} [o.prs] - a parsed `gh pr list --state all --json …` page; `null` = the read failed.
 * @param {string|null} [o.attempt] - THIS entry's own attempt tag (see {@link sessionSlugAttemptTag}), or
 *   `null`/omitted to skip the attempt-tag axis entirely (today's tag-blind behaviour).
 * @returns {{verdict: 'merged'|'pending'|'parked'|'closed'|'stale', pr: object|null}}
 */
export function classifyDispatchPr({ num, startedAt = null, prs = null, attempt = null } = {}) {
  const key = normNum(num);
  // NO ITEM ID, or NO LISTING (the read failed / returned junk) → no verdict. `pending` is the word for "this
  // axis has nothing to say", and it is indistinguishable from "no PR yet" ON PURPOSE: both mean fall through.
  if (!key || !Array.isArray(prs)) return { verdict: 'pending', pr: null };

  // #3110 — a candidate whose OWN tag is resolvable and DIFFERS from `attempt` belongs to a sibling attempt
  // structurally, not merely by timing coincidence: exclude it before the stale filter ever sees it. A
  // candidate with no resolvable tag (a legacy ref), or when this entry itself carries no tag (`attempt ===
  // null`), is left for the timing filter alone to judge — unresolvable on this axis means silent, not refused.
  const mine = prs.filter((p) => {
    if (laneRefItemNum(p?.headRefName) !== key) return false;
    if (attempt === null) return true;
    const theirs = laneRefAttemptTag(p?.headRefName);
    return theirs === null || theirs === attempt;
  });
  if (!mine.length) return { verdict: 'pending', pr: null }; // no PR yet — exactly today's behaviour

  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  // A MERGE BEFORE THIS ATTEMPT BEGAN belongs to a previous one. Non-merged PRs are kept as they are: they
  // carry no merge instant to compare, and the verdicts they produce (`pending` / `parked` / `closed`) resolve
  // nothing anyway. A PR that reads `merged` with no PARSEABLE `mergedAt` is dropped for the same reason a
  // missing `startedAt` is — there is no instant, so nothing can be attributed, and fail-closed is the only
  // safe direction.
  const attributable = mine.filter((p) => {
    if (classifyPr(p) !== 'merged') return true;
    const mergedMs = p?.mergedAt ? Date.parse(p.mergedAt) : NaN;
    return !Number.isNaN(mergedMs) && !Number.isNaN(startedMs) && mergedMs >= startedMs;
  });
  if (!attributable.length) return { verdict: 'stale', pr: mine[0] };

  const RANK = { merged: 4, pending: 3, parked: 2, closed: 1 };
  let best = null;
  for (const p of attributable) {
    const verdict = classifyPr(p);
    if (!best || RANK[verdict] > RANK[best.verdict]) best = { verdict, pr: p };
  }
  return best;
}

/**
 * `gh pr list --state all` — ONE bounded page of this repo's PRs, in the shape {@link classifyDispatchPr} and
 * `pr-watch.mjs`'s `classifyPr` read.
 *
 * TWO PARTS OF THE QUERY ARE LOAD-BEARING, and both fail SILENTLY when wrong — an empty listing is by design
 * indistinguishable from "no PR yet", so a query that matches nothing looks exactly like a fleet with no PRs
 * open. Nothing reddens, the waker keeps escalating at 6h, and the feature reads as delivered. That is why
 * `dispatch-lane-defaults.test.mjs` pins this argv rather than merely exercising the path:
 *   - `--state all` — bare `gh pr list` defaults to OPEN only, which hides every MERGED PR, i.e. the single
 *     classification this observer resolves on. Without it the whole axis is a no-op.
 *   - `headRefName` in `--json` — the field the item match is made on. Without it every PR reads as belonging
 *     to no item.
 * `state`, `mergedAt` and `labels` are what `classifyPr` itself reads; `number` is for the record's evidence.
 *
 * SAME BOUNDED PAGE AS THE LEASE REAPER (`lease-reaper.mjs#fetchPrStates`): 400 is well past any plausible
 * backlog of open+recent PRs, and a bound is what keeps one wedged read from being unbounded.
 *
 * @param {{exec?: Function, env?: object}} [io] - injected ONLY so the argv and opts can be asserted.
 *   Defaults to {@link execFileSyncThrottled} (#4415 round 2), never a bare `execFileSync` — this is a
 *   `gh pr list` PR-listing read, the exact shape `gh-throttle.mjs` attributes and paces.
 */
export function defaultListPrs({ exec = execFileSyncThrottled, env = process.env } = {}) {
  const out = exec('gh', ['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_JSON_FIELDS], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: prListTimeoutMs(env),
    killSignal: 'SIGKILL',
  });
  return JSON.parse(String(out || '[]'));
}

/**
 * How many merged PRs the ALREADY-DONE ground-truth search (#3457/#3460) asks `gh` for. Deliberately far
 * smaller than {@link PR_LIST_LIMIT} (400): that constant bounds a `--state all` DISCOVERY page meant to cover
 * every open-or-recent PR in the repo, while this query is server-side SCOPED already (`--search "<NNN>
 * in:title" --state merged`) and only ever needs to know "does at least one match exist, and if so the most
 * recent" — {@link filterAlreadyDoneCandidates} sorts and returns the winner. #3457's own ratified sketch used
 * `limit: 5`; kept as the literal here rather than re-derived, so a test can pin the argv exactly the way
 * `dispatch-lane-defaults.test.mjs` already pins {@link PR_LIST_LIMIT}.
 */
export const ALREADY_DONE_SEARCH_LIMIT = 5;

/** The `--json` fields the already-done search needs. `headRefName` is what {@link filterAlreadyDoneCandidates}
 *  excludes prepare-scope/prepare-decision authoring PRs on; `title`/`url`/`mergedAt` are the evidence a refusal
 *  quotes back at the operator (Done-when 1a/1b: "names the merged PR's URL"). `body`/`files` (#3473) feed the
 *  two ADDITIONAL guards below — a small, already-bounded page ({@link ALREADY_DONE_SEARCH_LIMIT} = 5), so no
 *  meaningful cost increase. */
export const ALREADY_DONE_JSON_FIELDS = 'number,title,url,mergedAt,headRefName,body,files';

/**
 * The head-ref SHAPE that means "this merged PR only authored the item's `scope:` or prepared its DECISION —
 * it never implemented the item" (#3457/#3460's own live false-positive check, run against this repo's real
 * convention). Every prepare-scope dispatch mints `lane/{{ITEM_NUM}}-scope-<slug>`
 * (`we:skills-src/conveyor/prepare-scope-agent-brief.md:159`) and every prepare-decision dispatch mints
 * `lane/{{ITEM_NUM}}-prepare-<slug>` (`we:skills-src/conveyor/prepare-decision-agent-brief.md:176`) — a REAL
 * build/fix/ci-heal PR's ref is always `lane/{{ITEM_NUM}}{{ATTEMPT_TAG}}-<slug>` with NEITHER literal token
 * (`we:skills-src/conveyor/delivery-agent-brief.md:250`).
 *
 * WHY THIS EXCLUSION IS NOT OPTIONAL, proven against live data while authoring this check: EVERY item that ever
 * reaches a BUILD dispatch already has a MERGED prepare-scope PR behind it — `shapeDispatchRead` refuses to
 * dispatch a build with no `scope:`, and `scope:` is authored by exactly that PR (see
 * `we:scripts/readiness/dispatch-plan.mjs`'s auto-prepare doctrine). Searching `gh pr list --search "<NNN>
 * in:title" --state merged` for `#3435` (measured 2026-09-03, `gh pr list --search "3435 in:title" --state
 * merged`) returns FOUR merged PRs including `#1780` ("WE #3435: author scope: for #3435", ref
 * `lane/3435-scope-3dfab284`) ALONGSIDE the real implementation `#1861` ("WE #3435: mechanically reap/stop
 * finished `claude agents` background sessions", ref `lane/3435-session-reaper`). Counting `#1780` as "already
 * done" would refuse the dispatch of literally every scoped build the moment its own scope-authoring PR lands —
 * before the build has even started. Excluding the two authoring ref shapes is what keeps the check aimed at
 * "was the ITEM implemented", not "was the item's card ever touched".
 */
export const NON_IMPLEMENTING_REF_RE = /^lane\/\d+[a-z]?-(scope|prepare)-/i;

/**
 * PURE — which of a `gh pr list --search` page's rows are real evidence that `num` is ALREADY DONE, most
 * recent merge first. Shared by both #3457/#3460 chokepoints ({@link readTick}'s pre-spawn guard here, and
 * `we:scripts/readiness/dispatch-plan.mjs`'s enrichment shell) so the query shape and its false-positive
 * exclusion are single-sourced rather than two readers independently reinventing (and inevitably disagreeing
 * about) what counts.
 *
 * SIX FILTERS, each closing a real false-positive this function's own authoring (or #3473's) turned up
 * against live data:
 *   1. `state === 'MERGED'` (belt-and-suspenders — the caller already asks `gh` for `--state merged`, but a
 *      pure filter over what the caller actually got is cheaper to trust than the query string).
 *   2. A WORD-BOUNDARY match on `title` — `in:title` search already scopes to the title field, but a bare
 *      substring test would let item `343` match a PR titled "WE #3435: …"; the boundary keeps `343` from
 *      matching inside `3435`.
 *   3. {@link NON_IMPLEMENTING_REF_RE} — excludes prepare-scope/prepare-decision authoring PRs (see that
 *      constant's own docblock for the live case this closes).
 *   4. (#3473) ALL-MARKDOWN DIFF — a PR whose entire changed-file set is `.md` is pure backlog housekeeping,
 *      never a real implementation, however its title reads. Live false positive: `#3096`'s dispatch-time
 *      already-done hold was fed by TWO merged PRs that both title-boundary-match "3096" — PR #1599 (ref
 *      `lane/reconcile-3147-3096-3239`, title "#3096: reconcile the three-way dispatch duplicate — #3096
 *      survives, #3147 + #3239 collapse") whose real merge diff (`git show 90fe066f6 --stat`) touches exactly
 *      4 files, ALL `.md` (3 `backlog/*.md` + a 1-line comment-marker repoint in `skills-src/conveyor/
 *      SKILL.md` — its own PR body opens "No code behaviour changes — this is a backlog reconciliation plus
 *      one in-code comment repoint"), and PR #1613 (ref `lane/split-3096`, title "WE #3096: split along its
 *      two scope entries — skill rewiring vs liveness hardening") whose diff (`gh pr view 1613 --json files`)
 *      touches exactly 2 files, both `backlog/*.md` (body opens "No code changes — two backlog files"). This
 *      filter reliably excludes PR #1613 — but NOT PR #1599: `gh`'s own `files` field for that long-lived
 *      branch is STALE (reports 17 files, 3 of them real `.mjs` changes that landed on `main` independently
 *      while the branch sat open, vs. the 4-file all-markdown TRUE diff `git show` proves), so this
 *      changed-file check alone cannot exclude it. Filter 6 below closes that gap.
 *   5. (#3473) "does not resolve #NNN" BODY DISCLAIMER, scoped to THIS `num` (unlike the sibling
 *      `deliveredItemNumsFromPr` in `we:scripts/lib/open-pr-items.mjs`, which must extract potentially-multiple
 *      candidate ids before it can scope the disclaimer, this function already knows the single id it is
 *      checking, so the regex is built with `num` inline). Targets the same false-positive CLASS as filter 4
 *      (a PR that name-matches the item without actually implementing it) via the author's own words rather
 *      than a file-shape heuristic, for the case no file-shape check can catch (a real code PR that explicitly
 *      says it only lands a partial increment — see `deliveredItemNumsFromPr`'s guard 6 docblock for the
 *      `#3443`/PR #1866 case this mirrors).
 *   6. (#3473, added during this item's own post-fix verification) "no code changes" BLANKET BODY DISCLAIMER
 *      — closes the PR #1599 gap filter 4 leaves open: its stale `gh` `files` field defeats filter 4, but its
 *      own body still opens with a blanket claim ("No code behaviour changes — this is a backlog
 *      reconciliation plus one in-code comment repoint"), the same shape PR #1613's body uses ("No code
 *      changes — two backlog files."). A body matching `/\bno\s+code\s+(behaviou?r\s+)?changes?\b/i` excludes
 *      the PR outright, independent of (and a backstop for) filter 4's changed-file check.
 * NOTE: {@link filterAlreadyDoneCandidates} is a SIBLING implementation of `deliveredItemNumsFromPr`
 * (`we:scripts/lib/open-pr-items.mjs`) — no shared code, no import between the two files — because this one
 * feeds a dispatch-time HOLD (recoverable false positive) while that one feeds an auto-committed `status:
 * resolved` RESOLVE (unrecoverable false positive); #3473 widened the fix to cover both call sites in one pass
 * since the root cause is the same shape: crediting a PR as "done" from title/ref pattern alone, with no
 * signal distinguishing a real implementation from backlog housekeeping.
 *
 * WHAT THIS DOES **NOT** CLOSE, stated rather than silently residual: a PR that is neither prepare-scope nor
 * prepare-decision but is ALSO not the item's real implementation — a backlog-only doc/evidence edit landed
 * under the item's own `lane/<NUM>-<slug>` ref (e.g. `#1848`, "backlog/3435: add evidence section…", merged
 * hours before the real `#1861` implementation) — still passes every filter here and would read as "done". Two
 * things bound the blast radius of that residual: (a) both #3457/#3460 chokepoints only ever HOLD/REFUSE on a
 * match, never auto-resolve the item (see `shapeDispatchRead`'s new branch and `dispatch-plan.mjs`'s
 * `already-done` hold) — a false hold is recoverable (a human/agent looks, then dispatches by hand), where a
 * false auto-resolve would not be; (b) narrowing further (e.g. requiring the PR's own diff to have flipped
 * `status: resolved`) would cost a SECOND `gh` call per candidate, which the ratified cost discipline
 * (`PR_LIST_TIMEOUT_MS`/`PR_LIST_LIMIT`, Fork 2's "stays cheap and non-blocking") rules out for this item; a
 * follow-up can tighten it later with real evidence that this residual bites in practice. Filters 4/5 above
 * narrow this further without a second `gh` call by riding along on `body`/`files`, now already fetched in the
 * same page (`ALREADY_DONE_JSON_FIELDS`).
 *
 * @param {object[]|null|undefined} prs - a parsed `gh pr list --search … --json …` page.
 * @param {string|number} num - the item id (already normalized by the caller).
 * @returns {object[]} matching rows, most recently merged first.
 */
export function filterAlreadyDoneCandidates(prs, num) {
  const key = String(num ?? '').trim();
  if (!key || !/^\d+$/.test(key) || !Array.isArray(prs)) return [];
  const boundary = new RegExp(`(^|[^0-9])${key}([^0-9]|$)`);
  const disclaimerRe = new RegExp(`\\bdoes\\s+not\\s+resolve\\s+#?${key}\\b`, 'i');
  return prs
    .filter((p) => p && typeof p === 'object')
    .filter((p) => p.state === undefined || p.state === 'MERGED') // undefined: a caller that omitted `state`
    .filter((p) => boundary.test(String(p?.title ?? '')))
    .filter((p) => !NON_IMPLEMENTING_REF_RE.test(String(p?.headRefName ?? '')))
    // #3473 guard 4 — an all-.md changed-file set is pure backlog/doc housekeeping, never a real delivery.
    // A no-op when `files` is absent from the row (existing fixtures that don't set it stay green).
    .filter((p) => !(Array.isArray(p?.files) && p.files.length > 0 && p.files.every((f) => /\.md$/i.test(String(f?.path ?? f)))))
    // #3473 guard 5 — the PR's own body explicitly disclaims resolving THIS id. A no-op when `body` is absent.
    .filter((p) => !disclaimerRe.test(String(p?.body ?? '')))
    // #3473 guard 6 — a blanket "no code changes" disclaimer excludes the PR outright (backstop for guard 4
    // when `files` is stale — see PR #1599 in this function's own docblock). A no-op when `body` is absent.
    .filter((p) => !/\bno\s+code\s+(behaviou?r\s+)?changes?\b/i.test(String(p?.body ?? '')))
    .sort((a, b) => (Date.parse(b?.mergedAt ?? '') || 0) - (Date.parse(a?.mergedAt ?? '') || 0));
}

/**
 * THE ALREADY-DONE GROUND-TRUTH CHECK (#3457/#3460) — "does a real merged PR already close `num` out",
 * independent of and un-trusting of the item's own `status:` frontmatter (the whole gap this item fixes: a
 * merged PR that closes an item out is not guaranteed to have flipped that item's `status:` at the same time).
 *
 * QUERY SHAPE, chosen and reasoned about explicitly (left open by #3457's own ruling for this item to settle):
 * `gh pr list --search "<NNN> in:title" --state merged` — scoped to the PR TITLE, not `gh pr list --search
 * "<NNN>"` bare (full-text over title+body+comments). Measured live while authoring this check (2026-09-03):
 * a bare-text search for `"1861"` matched THREE PRs that never mention `1861` in their own title at all — one
 * (`#1864`) only because its BODY happens to say "open PR #1861 already in flight" while describing a
 * DIFFERENT item (`#3435`) in passing. `in:title` alone already eliminates that class of false positive; this
 * repo's own convention (`we:AGENTS.md`'s commit style, confirmed via `git log`) titles every implementing PR
 * `WE #NNN: …` or `(#NNN)`, so title-scoping loses no real signal.
 *
 * FAIL-SOFT ON A `gh` FAILURE, matching {@link createDispatchObservers}'s own PR axis and the lease reaper's
 * `fetchPrStates` ("any gh failure disables the axis"): a wedged/unauthenticated/rate-limited `gh` degrades this
 * check to "nothing found" rather than blocking or crashing a dispatch read that has nothing to do with GitHub
 * auth. `checked: false` on the result says the read itself failed (never asserted as "confirmed not done") —
 * the same shape distinction {@link defaultCheckAlreadyDone}'s caller relies on.
 *
 * @param {string|number} num - the item id.
 * @param {{exec?: Function, env?: object}} [io] - injected ONLY so the argv/opts are assertable in a test.
 *   Defaults to {@link execFileSyncThrottled} (#4415 round 2), never a bare `execFileSync` — see this
 *   function's async sibling below for why an unthrottled default here is exactly what blew the shared
 *   `graphql` bucket live, 2026-09-29.
 * @returns {{done: boolean, pr: object|null, checked: boolean}}
 */
export function defaultCheckAlreadyDone(num, { exec = execFileSyncThrottled, env = process.env, git, cwd, bornAs } = {}) {
  if (git || exec === execFileSyncThrottled) {
    const local = readGitAlreadyDone(num, { git, cwd, bornAs, filter: filterAlreadyDoneCandidates });
    if (local !== null) return local;
  }
  const key = String(num ?? '').trim();
  if (!key) return { done: false, pr: null, checked: false };
  if (exec === execFileSyncThrottled) {
    try {
      const remote = String(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 5000 })).trim();
      const slug = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
      if (slug) {
        const matches = filterAlreadyDoneCandidates(meteredAlreadyDone(slug, key, { opts: { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: prListTimeoutMs(env), killSignal: 'SIGKILL' } }), key);
        return { done: matches.length > 0, pr: matches[0] ?? null, checked: true };
      }
    } catch { return { done: false, pr: null, checked: false }; }
  }
  let raw;
  try {
    raw = exec('gh', [
      'pr', 'list', '--search', `${key} in:title`, '--state', 'merged',
      '--limit', String(ALREADY_DONE_SEARCH_LIMIT), '--json', ALREADY_DONE_JSON_FIELDS,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
      timeout: prListTimeoutMs(env), // #3460 — reuses the existing `gh pr list` network bound, no new knob
      killSignal: 'SIGKILL',
    });
  } catch {
    return { done: false, pr: null, checked: false };
  }
  let prs;
  try { prs = JSON.parse(String(raw ?? '[]')); } catch { return { done: false, pr: null, checked: false }; }
  const matches = filterAlreadyDoneCandidates(prs, key);
  return matches.length ? { done: true, pr: matches[0], checked: true } : { done: false, pr: null, checked: true };
}

/**
 * #4415 round 2 — an async-signature-compatible THROTTLED `gh` call: the default `execFileFn` for
 * {@link defaultCheckAlreadyDoneAsync} below, in place of the bare promisified `execFile` it replaces. Same
 * shape a caller of the promisified `execFile` already expects (`(file, args, opts) =>
 * Promise<{stdout, stderr}>`), but the real work goes through {@link execFileSyncThrottled} — the SAME shared
 * concurrency semaphore and attribution log every other `gh` caller in this codebase goes through.
 * Deliberately SYNC under the hood despite the async signature: the semaphore's own blocking acquire is
 * exactly what needs to bind here, so many "concurrent" callers queue through it one at a time rather than all
 * hitting `gh` at once (see {@link defaultCheckAlreadyDoneAsync}'s own docblock for the live incident this
 * fixes). A thrown error from the sync call becomes a REJECTED promise by ordinary `async function` semantics,
 * so `defaultCheckAlreadyDoneAsync`'s existing try/catch-and-degrade needs no change at all.
 * @param {string} file
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function execFileThrottledAsync(file, args, opts = {}) {
  const stdout = execFileSyncThrottled(file, args, opts);
  return { stdout, stderr: '' };
}

/**
 * THE CONCURRENT SIBLING OF {@link defaultCheckAlreadyDone} — same query shape, same matcher, but via
 * `execFile` (promise-based) instead of `execFileSync`, so a caller checking MANY ids in one tick can run
 * them concurrently instead of paying each `gh` round-trip serially.
 *
 * @test-only-export-ok: consumed only via `dispatch-plan.mjs`'s dynamic `await import(...)` (a lazy IO-shell
 *   import, not a static one), which the test-only-export scan cannot trace.
 *
 * WHY THIS EXISTS (measured live, 2026-09-04): `dispatch-plan.mjs`'s already-done pass calls
 * {@link defaultCheckAlreadyDone} once per age-gated stale item, in a plain `for` loop — with the queue at
 * 69 entries, most past the 2h age gate, that is up to ~69 sequential `gh pr list` round-trips, observed to
 * push one `dispatch-plan.mjs --json` run past 60s (and `tick-core.mjs`'s own wrapping call has no timeout
 * at all — see its `runJson`). The conveyor runner ticks on a ~120s clock, so a single slow tick can eat the
 * whole budget and the next tick's dispatch reads stale-by-then state. The check itself (one `gh` call per
 * id) is unavoidable — there is no bulk "is any of these NNN already merged" query `gh pr list --search`
 * supports — but nothing requires those calls to be SEQUENTIAL, and unlike `execFileSync`, `execFile` does
 * not block the event loop, so many can be in flight at once.
 *
 * SAME fail-soft contract as the sync version: any `gh` failure (auth, rate-limit, timeout) resolves to
 * `{ done: false, pr: null, checked: false }` rather than rejecting — a caller `Promise.all`-ing many of
 * these must never have one bad id fail the whole batch.
 *
 * #4415 round 2 — LIVE INCIDENT, 2026-09-29: this function's OLD default (the plain promisified
 * `node:child_process` `execFile`) is EXACTLY what "many can be in flight at once" (this docblock's own words,
 * above) turned into in production — `dispatch-plan.mjs`'s `Promise.all(staleQueueRows.map((row) =>
 * defaultCheckAlreadyDoneAsync(row.num)))` has NO concurrency cap of its own, and a `ps aux` snapshot caught
 * ~80-100 of these `gh pr list --search … --state merged` calls running SIMULTANEOUSLY, none of them logged
 * anywhere (the bare promisified `execFile` never touches `gh-throttle.mjs`) — the single largest UNATTRIBUTED
 * slice of the shared `graphql` bucket that hour (6365.2 of 8943 points, `gh-spend.mjs report --hours=1
 * --by=caller`).
 * Fixed the same way every other `gh` caller in this codebase is: the default now goes through
 * {@link execFileThrottledAsync} — same async signature `defaultCheckAlreadyDoneAsync`'s own contract needs
 * (`(file, args, opts) => Promise<{stdout, stderr}>`), but the real work is `execFileSyncThrottled`, whose
 * shared concurrency semaphore (`DEFAULT_GH_CONCURRENCY_CAP`, `gh-throttle.mjs`) now genuinely bounds how many
 * of these run at once, AND logs every one for attribution. Deliberately re-serializes what was async/parallel
 * — a real latency cost, but the "many in flight, none paced" property is exactly what broke live, so trading
 * speed for a bounded, attributed rate is the correct direction here, not a regression to paper over.
 *
 * @param {string|number} num - the item id.
 * @param {{execFileFn?: Function, env?: object}} [io] - `execFileFn` injected ONLY so the argv/opts are
 *   assertable in a test; defaults to {@link execFileThrottledAsync}, never the bare promisified `execFile`.
 * @returns {Promise<{done: boolean, pr: object|null, checked: boolean}>}
 */
export async function defaultCheckAlreadyDoneAsync(num, { execFileFn = execFileThrottledAsync, env = process.env, git, cwd, bornAs } = {}) {
  if (git || execFileFn === execFileThrottledAsync) {
    const local = readGitAlreadyDone(num, { git, cwd, bornAs, filter: filterAlreadyDoneCandidates });
    if (local !== null) return local;
  }
  const key = String(num ?? '').trim();
  if (!key) return { done: false, pr: null, checked: false };
  if (execFileFn === execFileThrottledAsync) {
    try {
      const remote = String(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 5000 })).trim();
      const slug = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
      if (slug) {
        // Awaited through the injectable executor (not a bare runGhSync) so the #3460 bounds ride along and a test can inject.
        const req = alreadyDoneRequest(slug, key, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: prListTimeoutMs(env), killSignal: 'SIGKILL' });
        const { stdout } = await execFileFn('gh', req.args, req.opts);
        const matches = filterAlreadyDoneCandidates(JSON.parse(String(stdout)), key);
        return { done: matches.length > 0, pr: matches[0] ?? null, checked: true };
      }
    } catch { return { done: false, pr: null, checked: false }; }
  }
  let raw;
  try {
    ({ stdout: raw } = await execFileFn('gh', [
      'pr', 'list', '--search', `${key} in:title`, '--state', 'merged',
      '--limit', String(ALREADY_DONE_SEARCH_LIMIT), '--json', ALREADY_DONE_JSON_FIELDS,
    ], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: prListTimeoutMs(env), // #3460 — reuses the existing `gh pr list` network bound, no new knob
      killSignal: 'SIGKILL',
    }));
  } catch {
    return { done: false, pr: null, checked: false };
  }
  let prs;
  try { prs = JSON.parse(String(raw ?? '[]')); } catch { return { done: false, pr: null, checked: false }; }
  const matches = filterAlreadyDoneCandidates(prs, key);
  return matches.length ? { done: true, pr: matches[0], checked: true } : { done: false, pr: null, checked: true };
}

/**
 * `gh pr view <pr> --json headRefName` — the ONE value a `fix`/`ci-heal` dispatch needs that no other launch
 * kind does (#3332): the `{{LANE_REF}}` the fix briefs `--base=` off of to reconstitute the bounced/red PR's
 * work in a fresh lane clone, rather than rebuilding it from scratch.
 *
 * SAME SHAPE AS {@link defaultListPrs} — bounded timeout, `stdio: ['ignore', 'pipe', 'pipe']`,
 * `killSignal: 'SIGKILL'` — for the same reason: this call sits synchronously inside a dispatch read, and a
 * wedged `gh` must not hang it forever.
 *
 * REUSES {@link prListTimeoutMs} RATHER THAN MINTING A DEDICATED CONSTANT. This is one more single-PR `gh`
 * call over the network, the same class of cost `PR_LIST_TIMEOUT_MS`'s own docblock names ("a NETWORK read
 * against GitHub rather than a local daemon") — a `pr view` of one PR is if anything CHEAPER than the bounded
 * `pr list` page the existing constant already bounds, so a separate number would not be describing a
 * different cost, only duplicating the same one under a second name and a second env var an operator would
 * have to learn. If that stops being true — if this lookup turns out to need a materially different bound in
 * practice — split it then, with the evidence that justified it; nothing here is guessing preemptively.
 *
 * @param {string|number} pr - the PR number.
 * @param {{exec?: Function, env?: object}} [io] - injected ONLY so the argv and opts can be asserted.
 * @returns {string|null} the PR's `headRefName`, or `null` when the field is absent or blank.
 */
export function defaultLaneRefForPr(pr, { exec = execFileSyncThrottled, env = process.env } = {}) {
  // A THROW HERE IS DELIBERATE, not an oversight — the OBSERVER elsewhere in this file is fail-SOFT on a `gh`
  // failure (a completed build still needing a person is the acceptable cost there), but this is not an
  // observer: it runs BEFORE a dispatch, to resolve a value that dispatch cannot proceed without. Swallowing
  // the failure here would not make the dispatch safer, it would only turn a loud, fixable "no LANE_REF" into
  // a `fillBrief` refusal with a confusing cause once the `undefined` reaches it three calls later — and
  // `fillBrief`'s own "no value for {{LANE_REF}}" refusal is exactly the right failure mode once this bubbles
  // up unmodified. So this function does the one thing it can do honestly: ask, and let a failure be a
  // failure.
  const out = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefName'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    timeout: prListTimeoutMs(env),
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(String(out || '{}'));
  const ref = String(parsed?.headRefName || '').trim();
  return ref || null;
}

/**
 * `claude agents --json` — active sessions only BY DEFAULT. See {@link createDispatchObservers} for why the
 * observer (and every other caller that does not pass `all: true`) must never see `--all`: it also lists
 * COMPLETED sessions, so a finished build would keep reading as `running` forever — the one mistake that makes
 * an observer worse than none.
 *
 * `all: true` IS AN OPT-IN, not a second default. It exists for a caller with the opposite job to the
 * observer's — one that must see COMPLETED sessions to do anything at all (`scripts/conveyor/session-reaper.mjs`,
 * #3435 review: the reaper's whole purpose is to find and `claude stop` `done`/`failed` sessions, which the
 * non-`--all` listing excludes entirely — so the plain default silently reaped nothing, ever). Every OTHER
 * caller passes no `all`, so its argv is byte-identical to before this option existed.
 *
 * BOUNDED, because this call sits synchronously inside a waker pass that promises to be fail-soft per run: a
 * `claude` that blocks (a cold start that wants to ask something, a wedged daemon) would otherwise stall every
 * OTHER parked run in the pass. A timeout turns that into one reported observer error, which is what the
 * contract says should happen.
 *
 * ASSERTED, not merely asserted-about. This function was called by no test at all, so both of the emphatic
 * claims above it — no `--all`, and a timeout — could be inverted with the suite green (PR #1211 review, F5/F6).
 * `dispatch-lane-defaults.test.mjs` now pins the argv and the opts, and the wake CLI test proves the same argv
 * across a real process boundary. `session-reaper-cli.test.mjs` pins the OPT-IN side the same way (#3435).
 *
 * @param {{exec?: Function, env?: object, all?: boolean}} [io] - injected ONLY so the argv and opts can be
 *   asserted. `all` defaults to `false` — every existing caller keeps today's active-sessions-only behavior
 *   unchanged; pass `all: true` ONLY from a caller whose job requires seeing completed sessions too.
 */
export function defaultListAgents({ exec = execFileSync, env = process.env, all = false } = {}) {
  const out = cachedClaudeAgents({ all, env, fetch: () => exec('claude', ['agents', '--json', ...(all ? ['--all'] : [])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: listTimeoutMs(env),
    killSignal: 'SIGKILL',
    // FORWARDED TO THE CHILD, not just read for the timeout. `defaultSpawnAgent` forwards its `env` (via
    // `...opts`) and this did not, so the two halves of one chain resolved `claude` differently: a test that
    // pointed `PATH` at a fake got a real spawn and a REAL listing back. The default is `process.env`, so
    // every existing caller — all of which pass `{ exec }` alone — is byte-identical.
    env,
  }) });
  return JSON.parse(String(out || '[]'));
}
