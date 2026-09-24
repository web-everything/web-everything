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

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { normNum } from '../conveyor/queue-store.mjs';
import { laneRefItemNum, laneRefAttemptTag, sessionSlugAttemptTag } from '../conveyor/lease-reaper.mjs';
import { classifyPr } from '../conveyor/pr-watch.mjs';
// #3637 — the POC-branch registry, so an item's `deliveryTarget:` resolves against DECLARED branches only.
import { readRegistry as readPocRegistry, validateDeliveryTarget } from '../lib/poc-branches.mjs';
import { briefTokensForRepo } from '../lib/repo-profile.mjs';
import { buildGhShimSettingsEnv, sanitizeSpawnEnv } from '../lib/gh-app-shim.mjs';
import { inFlight, notApplied } from './effect-executor.mjs';
import { createFileRunStore } from './run-store.mjs';
import { DEFAULT_EXPECTED_WITHIN_MINUTES, DISPATCH_EFFECT, DISPATCH_LISTING_GRACE_MINUTES, LAUNCH_KINDS } from './dispatch-lane.mjs';

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
 * ONE `tick-core` call. Its STDIN is the caller's session-ephemeral bookkeeping — read from `bookkeepingFile`
 * when given, `{}` otherwise. The file is the CALLER'S (the runner's `nextState`); this function neither
 * creates nor writes one, so no parallel state store comes into existence (#2612).
 *
 * @param {object} o
 * @param {string|number} o.num - the item to dispatch.
 * @param {string} [o.bookkeepingFile] - path to the caller's `{ bookkeeping, signals, config }` JSON.
 * @param {string} [o.root]
 * @param {Function} [o.runNode] - injectable `(argv, opts) => stdout`, so the reader is testable without a tick.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT `runNode` goes through. Separate from
 *   `runNode` on purpose: overriding `runNode` replaces the production path, while overriding `exec` EXERCISES
 *   it, which is the only way a test can assert the options (the timeout) it builds — see F5/F12 in the PR
 *   #1211 review, where a tested default reached by nothing was the whole defect.
 * @param {Function} [o.readText] - injectable file reader.
 * @param {Function} [o.loadItems] - injectable backlog loader.
 * @param {() => Date} [o.now] - injectable clock; stamps `observedAt`, which is how the pure declaration ages
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
  root = REPO_ROOT,
  exec = execFileSync,
  runNode = (argv, opts) => defaultRunNode(argv, opts, { exec }),
  readText = (path) => readFileSync(path, 'utf8'),
  loadItems = () => defaultLoadItems(root),
  listInFlightDispatches = (key) => inFlightDispatchesFor(key),
  listAgents = () => defaultListAgents({ exec }),
  recordLiveness = (stamped) => { persistLastSeenLive(stamped, { now }); return stamped; },
  laneRefForPr = (pr) => defaultLaneRefForPr(pr, { exec }),
  checkAlreadyDone = (n) => defaultCheckAlreadyDone(n, { exec }),
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

  // An explicit verbose setting bypasses tick-core's read-and-advance of the
  // persisted diagnostic window. Read-only reports must supply false.
  if (verbose != null) {
    const payload = JSON.parse(stdin);
    stdin = JSON.stringify({ ...payload, config: { ...payload.config, verbose } });
  }

  let tick;
  try {
    tick = JSON.parse(String(runNode([tickCli(root)], { cwd: root, input: stdin })));
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || 'tick-core failed';
    throw new Error(`dispatch-lane-io: could not read the conveyor tick — ${msg}`);
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
      listInFlightDispatches, listAgents: cachedAgents, recordLiveness, laneRefForPr, checkAlreadyDone,
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
  // `{{WE_ROOT}}`/`{{ATTRIBUTION}}`), lazy on the SAME `launchKind` gate as `laneRef` just above: only a
  // fix/ci-heal fill ever references them. Hardcoded to the `we` profile — this tick-core-driven launch list
  // only ever plans a fix/ci-heal for a WE item/PR today (`tick-core.mjs#planFixSpawns`/`#planCiHealSpawns`
  // read only the WE backlog/PR pool); a REAL per-repo selection here is multi-repo slice 5's job, not this
  // one's — this file stays correct for `we` now and has exactly one line to change once that lands.
  const repoTokens = (launchKind === 'fix' || launchKind === 'ci-heal')
    ? briefTokensForRepo('we', { itemNum: key, prNum: launch?.pr ?? null })
    : null;

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
    // #3960 — the fix/ci-heal repo-aware brief quintet, or `null` for the four kinds that never need it, or
    // when the `we` profile/gate could not be resolved (fail-closed: `shapeDispatchRead` then has no value for
    // `{{REPO}}` et al. and `fillBrief`'s own required-value refusal stops the dispatch, exactly as a missing
    // `laneRef` already does for `{{LANE_REF}}`).
    repoTokens,
    // #3457/#3460 — the ground-truth verdict, or the not-checked default when nothing was cleared for launch.
    alreadyDone,
    bookkeepingSource,
    droppedBookkeepingKeys: droppedKeys,
    // THIS OPERATION'S OWN in-flight dispatches for the item — see {@link inFlightDispatchesFor} — each row
    // carrying the live/gone/unknown answer {@link stampLiveness} got for its handle.
    inFlightDispatches: recordLiveness(stampLiveness(listInFlightDispatches(key), { listAgents })),
    // WHEN THIS READ WAS TAKEN. The declaration ages the double-dispatch guard out (`dispatchStillHolds`) and
    // is pure, so the clock has to arrive as DATA rather than be read there. Omitted or unparseable → nothing
    // ages out and every in-flight record holds, which is the fail-closed direction.
    observedAt: now().toISOString(),
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
 * @param {{listAgents?: () => object[]}} [o]
 * @returns {{runs: object[], unreadable: number, livenessSource: 'claude-agents'|'unreadable'|'not-needed'}}
 */
export function stampLiveness(inFlight, { listAgents } = {}) {
  const rows = Array.isArray(inFlight?.runs) ? inFlight.runs : [];
  const unreadable = Number(inFlight?.unreadable) > 0 ? Number(inFlight.unreadable) : 0;
  if (!rows.length) return { runs: [], unreadable, livenessSource: 'not-needed' };

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
    runs: rows.map((r) => ({ ...r, live: r.handle ? listed.has(normalizeHandle(r.handle)) : null })),
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
  return ({ num, bookkeepingFile, all = false, verbose = bindings.verbose }) => readTick({ ...bindings, num, bookkeepingFile, all, verbose });
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
      + 'acquires a lane, and acquiring one from inside another nests two checkouts. Run this from the primary checkout.',
    );
  }
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
 * @param {string} [o.root] - the cwd the agent starts in. The agent acquires its OWN lane clone (brief step 1),
 *   so this is the checkout it runs `lane-pool acquire` from, never the lane itself.
 * @param {Function} [o.spawnAgent] - injectable `(argv, opts) => stdout`; the default shells `claude`. Feeds
 *   the DEFAULT `provider` below; a caller supplying its own `provider` need not touch this at all.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT `spawnAgent` goes through. See
 *   {@link readTick} for why this is a second seam and not the same one.
 * @param {(request: object) => (string|Promise<string>)} [o.provider] - the PORT (see above). Defaults to
 *   {@link defaultClaudeProvider} closed over `spawnAgent`.
 * @param {() => string} [o.mintSessionId] - injectable UUID minter.
 * @param {() => Date} [o.now] - injectable clock, for `expectedBy`.
 * @param {string[]} [o.extraArgs]
 * @returns {Record<string, Function>} effect type → `async (payload, ctx) => result`.
 */
export function createDispatchSinks({
  root = REPO_ROOT,
  exec = execFileSync,
  spawnAgent = (argv, opts) => defaultSpawnAgent(argv, opts, { exec }),
  provider = (request) => defaultClaudeProvider(request, { spawnAgent }),
  mintSessionId = () => randomUUID(),
  now = () => new Date(),
  extraArgs = [],
  // #x8mpubm — resolved ONCE per dispatch, here at the sink (the one place real fs/env effects belong in this
  // file), never inside `defaultClaudeProvider`/`buildAgentArgv` themselves, both of which stay side-effect-free
  // by default so every OTHER existing test of either keeps working unchanged. `resolveGhShimSettingsEnv`
  // itself never throws and is a no-op (fs untouched) on any host that has not opted into App auth — see
  // `we:scripts/lib/gh-app-shim.mjs`'s own header.
  resolveSettingsEnv = resolveGhShimSettingsEnv,
} = {}) {
  return {
    [DISPATCH_EFFECT]: async (payload) => {
      assertNotALaneCheckout(root);
      const sessionId = String(mintSessionId());
      let handle;
      try {
        handle = await provider({
          sessionId,
          cwd: root,
          prompt: payload?.prompt,
          sessionSlug: payload?.sessionSlug,
          num: payload?.num,
          extraArgs,
          systemPromptFile: DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
          settingsEnv: resolveSettingsEnv(root),
        });
      } catch (e) {
        // A validation failure `buildAgentArgv` already proved happened before any process existed (e.g. an
        // empty prompt) carries `.notApplied` — rethrow it as-is rather than reclassifying it as indeterminate.
        if (e && e.notApplied) throw e;
        if (isPreSpawnRefusal(e)) {
          throw notApplied(`claude could not be started (${String(e.code)}) — no agent exists`, { sessionId });
        }
        // INDETERMINATE. The entry stays `in-flight` with a NULL handle: something may be running and cannot be
        // observed. The replay guard refuses it and `inFlightEntries` reports it under `unknown`, which is
        // exactly right — a person finds out what happened and closes it out.
        throw new Error(
          `claude --bg failed and whether an agent started is UNKNOWN: ${String((e && e.message) || e).split('\n')[0]}`,
        );
      }
      const minutes = Number(payload.expectedWithinMinutes) > 0
        ? Number(payload.expectedWithinMinutes)
        : DEFAULT_EXPECTED_WITHIN_MINUTES;
      return inFlight({
        handle: handle != null ? String(handle) : sessionId,
        expectedBy: new Date(now().getTime() + minutes * 60 * 1000).toISOString(),
      });
    },
  };
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
  const argv = buildAgentArgv({
    sessionId: request.sessionId,
    payload: { prompt: request.prompt, sessionSlug: request.sessionSlug, num: request.num },
    extraArgs: request.extraArgs,
    systemPromptFile: request.systemPromptFile,
    // #x8mpubm — resolved once by the SINK (`createDispatchSinks`), not here: this function never reaches
    // for `process.env`/real fs on its own (`request.settingsEnv` defaults to nothing, i.e. `null`), so every
    // existing caller/test of this port that never mentions it sees byte-identical behaviour.
    settingsEnv: request.settingsEnv ?? null,
  });
  const stdout = String(spawnAgent(argv, { cwd: request.cwd }) ?? '');
  return parseBackgroundedId(stdout) || request.sessionId;
}

/**
 * The default `claude --bg` spawner — named and exported for the same reason as {@link defaultRunNode}: the
 * TIMEOUT it sets is the whole point of the option bag, and while it lived inside a default parameter that
 * every test overrode, deleting it left the suite green (PR #1211 review, F5).
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {{exec?: Function}} [io] - injected ONLY so the opts can be asserted.
 * @returns {string}
 */
export function defaultSpawnAgent(argv, opts = {}, { exec = execFileSync } = {}) {
  return exec('claude', argv, {
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
    env: sanitizeSpawnEnv(opts.env || process.env),
  });
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

export function buildAgentArgv({ sessionId, payload, extraArgs = [], systemPromptFile = null, resumeSessionId = null, settingsEnv = null }) {
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
  // NO `--session-id` — see this function's own header. `sessionId` is deliberately unreferenced here.
  void sessionId;
  return [
    '--bg',
    '-n', String(payload.sessionSlug || `conveyor-${payload.num}`),
    // #x8mpubm — a `PATH` (or other) override, folded into `--settings '{"env":{...}}'`. THIS is how a
    // dispatched session's own `gh` calls end up authenticating as the App installation: `claude --bg` does
    // NOT inherit the spawning process's ambient env (live-confirmed — see gh-app-shim.mjs's own header), but
    // DOES apply `--settings`'s `env` to the session's own Bash-tool subprocess environment (also
    // live-confirmed). Omitted entirely when `settingsEnv` is `null`/empty — a caller that never resolves one
    // (or a host with App auth unconfigured) gets a `--bg` argv byte-identical to before this existed.
    ...(settingsEnv && Object.keys(settingsEnv).length ? ['--settings', JSON.stringify({ env: settingsEnv })] : []),
    ...(systemPromptFile ? ['--append-system-prompt-file', String(systemPromptFile)] : []),
    ...extraArgs.map(String),
    prompt,
  ];
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
 *   {@link readTick} for why this is a second seam and not the same one.
 * @param {() => Date} [o.now]
 * @returns {Record<string, Function>} effect type → `async (entry, ctx) => {status, result?, error?}`.
 */
export function createDispatchObservers({
  exec = execFileSync,
  listAgents = () => defaultListAgents({ exec }),
  listPrs = () => defaultListPrs({ exec }),
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

      // ── AXIS 2: LIVENESS. Unchanged — it is what answers while no PR exists yet, which is every dispatch
      //    for most of its life, and the dominant case until real dispatch lands.
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
      const live = listedIds.has(normalizeHandle(handle));
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
 */
export function defaultListPrs({ exec = execFileSync, env = process.env } = {}) {
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
 * @returns {{done: boolean, pr: object|null, checked: boolean}}
 */
export function defaultCheckAlreadyDone(num, { exec = execFileSync, env = process.env } = {}) {
  const key = String(num ?? '').trim();
  if (!key) return { done: false, pr: null, checked: false };
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
 * @param {string|number} num - the item id.
 * @param {{execFileFn?: Function, env?: object}} [io] - `execFileFn` injected ONLY so the argv/opts are
 *   assertable in a test; defaults to the promisified `node:child_process` `execFile`.
 * @returns {Promise<{done: boolean, pr: object|null, checked: boolean}>}
 */
export async function defaultCheckAlreadyDoneAsync(num, { execFileFn = execFileAsync, env = process.env } = {}) {
  const key = String(num ?? '').trim();
  if (!key) return { done: false, pr: null, checked: false };
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
export function defaultLaneRefForPr(pr, { exec = execFileSync, env = process.env } = {}) {
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
  const out = exec('claude', ['agents', '--json', ...(all ? ['--all'] : [])], {
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
  });
  return JSON.parse(String(out || '[]'));
}
