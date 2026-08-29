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
 *   - the brief is whichever of the three authored mandates the launch's KIND names — the delivery brief for
 *     a build, `prepare-scope-agent-brief.md` / `prepare-decision-agent-brief.md` for a prepare (#3165) —
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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normNum } from '../conveyor/queue-store.mjs';
import { laneRefItemNum } from '../conveyor/lease-reaper.mjs';
import { classifyPr } from '../conveyor/pr-watch.mjs';
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
// THE AGENT-BRIEF TEMPLATE the declaration fills, PER KIND (#3165).
//
// All three briefs were authored and only one was reachable: `briefPath` took no kind, so
// `prepare-scope-agent-brief.md` (15.7 KB) and `prepare-decision-agent-brief.md` (18 KB) sat unrouted while
// the planner kept surfacing prepares nobody could dispatch. This map is the whole connection.
//
// ONE FILE PER KIND, declared as data rather than as a string built from the kind: a computed name silently
// resolves to a path that does not exist, and `readText` would then fail with `ENOENT` on a filename instead
// of naming the kind nobody wired.
const BRIEF_BY_KIND = Object.freeze({
  build: 'delivery-agent-brief.md',
  prepare: 'prepare-scope-agent-brief.md',
  'prepare-decision': 'prepare-decision-agent-brief.md',
  fix: 'fix-agent-brief.md',
  'ci-heal': 'fix-agent-ci-brief.md',
});

// UNKNOWN KIND THROWS; it does NOT fall back to the delivery brief. Handing a scope-prep agent the delivery
// mandate tells it to BUILD an item whose scope is exactly what it was dispatched to write — it would acquire
// a lane, read an empty scope and improvise. A loud refusal costs one dispatch; the silent fallback costs a
// lane and a wrong PR.
/**
 * @param {string} [root]
 * @param {'build'|'prepare'|'prepare-decision'} [kind] - defaults to `build`, so every pre-#3165 caller
 *   resolves the same path it always did.
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
 * @param {() => object[]} [o.listPrs] - injectable `gh pr list` reader (#3383), consulted ONLY for a
 *   `fix`/`ci-heal` launch — a build/prepare dispatch never pays for this call. Defaults to
 *   {@link defaultListPrs}, the SAME reader the observer already uses, so a fix/ci-heal's `LANE_REF` comes
 *   from one already-proven `headRefName` source rather than a second one invented for this path.
 * @returns {{launch: object|null, launchKind: 'build'|'prepare'|'prepare-decision'|'fix'|'ci-heal', suppressed: object|null, resolvedNum: string, item: object|null, briefTemplate: string, nextState: object, statusLine: string, notes: object[], bookkeepingSource: string, observedAt: string, prHeadRef: string|null}}
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
  listPrs = () => defaultListPrs({ exec }),
  now = () => new Date(),
} = {}) {
  const key = normNum(num);
  if (!key) throw new TypeError(`dispatch-lane-io: \`num\` must be an item id, got ${JSON.stringify(num)}`);

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

  let tick;
  try {
    tick = JSON.parse(String(runNode([tickCli(root)], { cwd: root, input: stdin })));
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || 'tick-core failed';
    throw new Error(`dispatch-lane-io: could not read the conveyor tick — ${msg}`);
  }
  const decisions = tick && typeof tick.decisions === 'object' && tick.decisions ? tick.decisions : {};
  const match = (rows) => (Array.isArray(rows) ? rows : []).find((r) => r && normNum(r.num) === key) || null;

  const item = findItem(key, loadItems);
  const nextState = tick && typeof tick.nextState === 'object' ? tick.nextState : null;
  // THE SELECTION happens here, with the tick's own normalizer — see the declaration's header for why it is
  // not in the pure half. FIVE LISTS, not one (#3165, extended #3383): `planTick` plans builds, both prepare
  // kinds, fixes and CI-heals, and launching only a subset is why `dispatch-lane --num=<an item held for one
  // of the others>` did nothing at all while the operator's status line kept promising it would.
  //
  // FIRST MATCH WINS, and no real tick makes that a decision — an item held as unscoped never reaches
  // `spawnBuilds`, a decision is never an unshaped build, and a fix/ci-heal targets an OPEN PR a build/prepare
  // item cannot simultaneously be — so the lists are disjoint by construction.
  const LAUNCH_LISTS = [
    ['build', decisions.spawnBuilds],
    ['prepare', decisions.spawnPrepareScope],
    ['prepare-decision', decisions.spawnPrepareDecision],
    ['fix', decisions.spawnFixes],
    ['ci-heal', decisions.spawnCiHeals],
  ];
  let launch = null;
  let launchKind = 'build';
  for (const [kind, rows] of LAUNCH_LISTS) {
    const row = match(rows);
    if (row) { launch = row; launchKind = kind; break; }
  }

  // THE PR'S HEAD REF (#3383) — a `fix`/`ci-heal` brief's `{{LANE_REF}}`, the ref it reconstitutes onto rather
  // than starting fresh from `main`. Fetched ONLY for these two kinds: a build/prepare dispatch has no PR yet
  // and must not pay for a `gh pr list` call it has no use for. Reuses `defaultListPrs`'s OWN listing (the
  // observer's `headRefName` source, `classifyDispatchPr`) rather than a second `gh pr view` invented for this
  // one field, per this file's own `PR_LIST_JSON_FIELDS` precedent.
  let prHeadRef = null;
  if ((launchKind === 'fix' || launchKind === 'ci-heal') && launch && launch.pr != null) {
    let prs = [];
    try { prs = listPrs(); } catch { prs = []; }
    const row = (Array.isArray(prs) ? prs : []).find((p) => Number(p?.number) === Number(launch.pr));
    prHeadRef = row?.headRefName ? String(row.headRefName) : null;
  }

  return {
    resolvedNum: key,
    launch,
    // WHICH LIST IT CAME OUT OF. It picks the brief below, and the session slug and the lane scope in the
    // declaration — one answer, read three times, rather than three re-derivations that can disagree.
    launchKind,
    suppressed: match(decisions.suppressedBuilds),
    // THIS launch's guard entry, picked out of the tick's guards with the same normalizer. The core records
    // one per planned spawn, in `buildGuards` for a build, `prepareGuards` for either prepare kind, `fixGuards`
    // for a fix and `ciHealGuards` for a ci-heal; only this one describes work this operation actually starts.
    // The prepare match is keyed on the KIND too, because `prepareGuards` holds both kinds in one list.
    dispatchedGuard: launchKind === 'build' ? match(nextState?.buildGuards)
      : launchKind === 'fix' ? match(nextState?.fixGuards)
      : launchKind === 'ci-heal' ? match(nextState?.ciHealGuards)
      : (Array.isArray(nextState?.prepareGuards) ? nextState.prepareGuards : [])
        .find((g) => g && normNum(g.num) === key && (g.kind || 'prepare') === launchKind) || null,
    item,
    briefTemplate: String(readText(briefPath(root, launchKind))),
    nextState,
    statusLine: String(decisions.statusLine || ''),
    notes: Array.isArray(decisions.notes) ? decisions.notes : [],
    bookkeepingSource,
    droppedBookkeepingKeys: droppedKeys,
    // THIS OPERATION'S OWN in-flight dispatches for the item — see {@link inFlightDispatchesFor} — each row
    // carrying the live/gone/unknown answer {@link stampLiveness} got for its handle.
    inFlightDispatches: recordLiveness(stampLiveness(listInFlightDispatches(key), { listAgents })),
    // WHEN THIS READ WAS TAKEN. The declaration ages the double-dispatch guard out (`dispatchStillHolds`) and
    // is pure, so the clock has to arrive as DATA rather than be read there. Omitted or unparseable → nothing
    // ages out and every in-flight record holds, which is the fail-closed direction.
    observedAt: now().toISOString(),
    prHeadRef,
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
 * neither `state` nor `status` nor `id` at all. `sessionId` is the ONE field present on every one of them, and
 * it is the only field anything here reads; `id` in particular is absent from half the listing and is NOT
 * reliably the `sessionId` prefix, so nothing should key off it.
 *
 * An EMPTY result from a NON-EMPTY listing is the signal the callers act on: the response parsed, and not one
 * element yielded an id — which is a shape this code does not understand, not a machine with no agents on it.
 *
 * @param {unknown[]} sessions
 * @returns {Set<string>}
 */
export function listedSessionIds(sessions) {
  const ids = (Array.isArray(sessions) ? sessions : []).map((s) => normalizeHandle(s?.sessionId)).filter(Boolean);
  return new Set(ids);
}

/**
 * IS `handle` ONE OF THE SESSIONS IN THIS LISTING — by PREFIX, not equality.
 *
 * #3331's probe proved `claude --bg` ignores `--session-id` (three runs, three mismatches, the CLI's own
 * stderr warning), so the handle a dispatch carries from now on is never the minted UUID — it is the SHORT id
 * {@link parseBackgroundedHandle} reads off the CLI's own `--bg` confirmation, which is a hex PREFIX of the
 * full `sessionId` this listing reports (measured against CLI 2.1.246: `1ae0905c` ↔
 * `1ae0905c-314c-4f73-a7c4-3973a9005e82`). Equality would never match a short handle against a full id, so
 * every reader that used to do `listedSessionIds(sessions).has(normalizeHandle(handle))` switches to this.
 *
 * STILL CORRECT FOR A FULL HANDLE, deliberately. A full 36-char id is a (trivial) prefix of itself, so this is
 * a superset of the old comparison, not a replacement with different behaviour on the case it used to handle —
 * forward-compatible if a future CLI ever starts honouring `--session-id`.
 *
 * @param {unknown} handle
 * @param {unknown[]} sessions
 * @returns {boolean}
 */
export function isHandleListed(handle, sessions) {
  const h = normalizeHandle(handle);
  if (!h) return false;
  return (Array.isArray(sessions) ? sessions : []).some((s) => normalizeHandle(s?.sessionId).startsWith(h));
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
    // PREFIX match (#3331), not `listed.has(...)` — `listed` above is still the full-id Set, kept only for the
    // shape guard; `r.handle` is the short id `parseBackgroundedHandle` stored at dispatch time, and equality
    // against a full `sessionId` would never match it. See {@link isHandleListed}.
    runs: rows.map((r) => ({ ...r, live: r.handle ? isHandleListed(r.handle, sessions) : null })),
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
 */
function defaultLoadItems(root) {
  const require = createRequire(import.meta.url);
  const load = require(join(root, 'src', '_data', 'backlog.js'));
  return typeof load === 'function' ? load() : [];
}

/** One item's spec path + repo-qualified scope, or null when the loader cannot see it. */
function findItem(key, loadItems) {
  let items = [];
  try { items = loadItems() || []; } catch { return null; }
  const it = (Array.isArray(items) ? items : []).find((x) => normNum(x?.num) === key);
  if (!it || !it.slug) return null;
  return {
    num: String(it.num),
    slug: String(it.slug),
    specPath: `backlog/${it.num}-${it.slug}.md`,
    // Already repo-qualified by the loader (`we:scripts/...`), which is the form the brief's `--scope` wants.
    scope: Array.isArray(it.scope) ? it.scope.map(String) : [],
  };
}

/** `readTick` bound to one root — the shape the declaration wants. */
export function createTickReader(bindings = {}) {
  return ({ num, bookkeepingFile }) => readTick({ ...bindings, num, bookkeepingFile });
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
 * THE HANDLE IS READ FROM THE CLI'S OWN CONFIRMATION, NOT MINTED — corrected by #3331. This docblock used to
 * claim `claude --session-id <uuid>` "removes the race outright" by letting the dispatcher choose the id
 * before the agent exists. #3331's probe disproved that against the real CLI: THREE runs, THREE mismatches
 * between the id passed and the id `claude agents --json` reported back, and the CLI's own stderr warns
 * `--bg manages the session id; ignoring --session-id`. The #3030 spike's "read it back and race every other
 * session starting in the same instant" problem was real — but the CLI already solves it, for free, in the
 * SAME stdout {@link defaultSpawnAgent} already captures: a `--bg` confirmation prints
 * `backgrounded · <shortId> · <name>`, where `<shortId>` is a hex PREFIX of the real `sessionId` (measured:
 * `1ae0905c` ↔ `1ae0905c-314c-4f73-a7c4-3973a9005e82`). {@link parseBackgroundedHandle} reads it SYNCHRONOUSLY
 * off the spawn's own return value — no polling, no before/after diff, no race with a concurrent dispatch,
 * because the id comes from the one process that assigned it. `mintSessionId` and `--session-id` in the argv
 * are kept (harmless — the CLI just ignores the flag) so a future CLI that starts honouring it costs nothing
 * to benefit from, but neither is load-bearing for identity any more.
 *
 * WHAT IS STILL NOT COVERED, stated rather than papered over: a sink killed between `claude --bg` returning
 * and this function returning loses the handle, same as before, and so does a `--bg` that returns 0 but prints
 * a confirmation this parser cannot read (a future CLI output change). Both throw here rather than return, and
 * the executor then refuses the entry on replay (it is `in-flight` with a null handle —
 * `inFlightEntries().unknown`). That window is VISIBLE and closable with `resolveInFlight`, which is the whole
 * reason #3073 wrote `in-flight` before the sink rather than after.
 *
 * NO PERMISSION FLAGS ARE BAKED IN — but the knob is REACHABLE. `extraArgs` (model, effort, permission mode)
 * defaults to empty, because a dispatcher that hard-coded `--dangerously-skip-permissions` would silently widen
 * every agent it ever launches; that is a decision for whoever runs the conveyor. It is read from
 * {@link AGENT_ARGS_ENV} at the `run.mjs` binding so an operator can actually set it, rather than being a
 * parameter only a test can reach.
 *
 * PROVEN AGAINST A PROCESS, NOT AGAINST THE REAL CLI. `./__tests__/dispatch-spawn-live.test.mjs` starts a
 * `claude` executable — a fake first on `PATH` that parses options the way a commander-style CLI does, and
 * (post-#3331) mints its own id and prints the same confirmation shape the real CLI does — and asserts this
 * argv is ACCEPTED, that `--bg` returns instead of blocking, and that the handle {@link parseBackgroundedHandle}
 * recovers from the confirmation is a real prefix of the id `defaultListAgents` later reports back. What is
 * still NOT proven: no dispatch has been fired end to end against the REAL CLI. A background session's
 * permission mode and the isolation default are the two things a first live run has to settle; #xaibmeu, which
 * routes the conveyor through this operation, is where that happens.
 *
 * @param {object} [o]
 * @param {string} [o.root] - the cwd the agent starts in. The agent acquires its OWN lane clone (brief step 1),
 *   so this is the checkout it runs `lane-pool acquire` from, never the lane itself.
 * @param {Function} [o.spawnAgent] - injectable `(argv, opts) => stdout`; the default shells `claude`.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT `spawnAgent` goes through. See
 *   {@link readTick} for why this is a second seam and not the same one.
 * @param {() => string} [o.mintSessionId] - injectable UUID minter.
 * @param {() => Date} [o.now] - injectable clock, for `expectedBy`.
 * @param {string[]} [o.extraArgs]
 * @returns {Record<string, Function>} effect type → `async (payload, ctx) => result`.
 */
export function createDispatchSinks({
  root = REPO_ROOT,
  exec = execFileSync,
  spawnAgent = (argv, opts) => defaultSpawnAgent(argv, opts, { exec }),
  mintSessionId = () => randomUUID(),
  now = () => new Date(),
  extraArgs = [],
} = {}) {
  return {
    [DISPATCH_EFFECT]: async (payload) => {
      assertNotALaneCheckout(root);
      const sessionId = String(mintSessionId());
      const argv = buildAgentArgv({ sessionId, payload, extraArgs });
      let stdout;
      try {
        stdout = spawnAgent(argv, { cwd: root });
      } catch (e) {
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
      // #3331: `sessionId` above is what we ASKED for, never what the CLI used — the real handle is read back
      // off the spawn's own confirmation. A spawn that returned 0 but printed no readable confirmation is the
      // SAME indeterminate shape as a thrown spawn (something may be running, its identity is unknown), so it
      // is refused the same way rather than trusted onto `handle`.
      const handle = parseBackgroundedHandle(stdout);
      if (!handle) {
        throw new Error(
          'claude --bg started an agent but its confirmation output carried no parseable session handle — '
          + `whether it is the agent this dispatch expects cannot be told: ${JSON.stringify(String(stdout ?? '').slice(0, 200))}`,
        );
      }
      const minutes = Number(payload.expectedWithinMinutes) > 0
        ? Number(payload.expectedWithinMinutes)
        : DEFAULT_EXPECTED_WITHIN_MINUTES;
      return inFlight({
        handle,
        expectedBy: new Date(now().getTime() + minutes * 60 * 1000).toISOString(),
      });
    },
  };
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
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts,
  });
}

/**
 * The `claude` argv for one dispatch. PURE and exported, because the argv IS the contract with the CLI and a
 * test that asserts it is the only thing standing between a flag rename and a silent non-dispatch.
 *
 * `--bg` starts the session and returns immediately; `--session-id` is passed but PROVEN IGNORED by the real
 * CLI on a `--bg` spawn (#3331) — kept anyway because it costs nothing and a future CLI may honour it; `-n`
 * names the session so `claude agents` is legible to an operator watching the pool. The handle the dispatcher
 * actually keys on comes from neither flag — see {@link parseBackgroundedHandle}.
 *
 * THE PROMPT'S POSITION GUARANTEES NOTHING, which the first cut of this comment got wrong. `claude` parses with
 * commander, and commander accepts options intermixed with operands — a last positional beginning with `-` is
 * still read as a flag. Rather than bet on `--` being handled the way this file hopes (untested against the
 * real CLI, and a wrong bet turns into a dispatch with a mangled prompt), the dash is REFUSED outright. Every
 * legitimate brief starts with markdown, so the refusal costs nothing and proves what the position could not.
 */
export function buildAgentArgv({ sessionId, payload, extraArgs = [] }) {
  const prompt = String(payload?.prompt || '');
  if (!prompt.trim()) throw notApplied('dispatch-lane: refusing to start an agent with an empty prompt');
  if (prompt.trimStart().startsWith('-')) {
    throw notApplied('dispatch-lane: refusing a brief that begins with `-` — an argument parser can read it as a flag');
  }
  return [
    '--bg',
    '--session-id', String(sessionId),
    '-n', String(payload.sessionSlug || `conveyor-${payload.num}`),
    ...extraArgs.map(String),
    prompt,
  ];
}

/**
 * THE SESSION HANDLE `claude --bg` PRINTS IN ITS OWN CONFIRMATION — the #3331 remedy, and the only source the
 * sink trusts for a dispatch's identity now.
 *
 * THE SHAPE, measured against CLI 2.1.246, not invented: a `--bg` spawn's stdout begins with a line reading
 * `backgrounded · <shortId> · <name>` (the middle dot is U+00B7), where `<shortId>` is a lower-case hex string
 * — 8 characters on every run observed — that is a genuine PREFIX of the full `sessionId` `claude agents
 * --json` reports back for that same session (`1ae0905c` ↔ `1ae0905c-314c-4f73-a7c4-3973a9005e82`). This line
 * is on STDOUT specifically; the `--session-id ignored` warning that precedes it in a terminal is on stderr
 * and never reaches this parser, which is why {@link defaultSpawnAgent}'s plain `execFileSync` capture is
 * enough — no stream-merging needed.
 *
 * WHY A PREFIX AND NOT THE FULL ID. The full id is never printed synchronously — only `claude agents --json`
 * carries it, and reading that back races a concurrent dispatch (the exact problem `--session-id` was
 * supposed to solve and does not). The short id has no such race: it is emitted by the one process that
 * assigned it, before this function returns. {@link isHandleListed} is the matching half — a prefix check,
 * because equality would never find a short handle inside a listing of full ids.
 *
 * RETURNS null ON ANYTHING ELSE, deliberately never a best-effort guess. A CLI output change that breaks this
 * regex must surface as "no handle could be read" (the sink turns that into a throw, landing the entry
 * `in-flight` with a null handle, exactly like a killed sink) rather than silently keying a dispatch on a
 * fragment of the wrong line.
 *
 * @param {string} stdout - what {@link defaultSpawnAgent} (or an injected `spawnAgent`) returned for a `--bg` call.
 * @returns {string|null}
 */
export function parseBackgroundedHandle(stdout) {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})\s*·/i.exec(String(stdout ?? ''));
  return m ? m[1].toLowerCase() : null;
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
        const { verdict, pr } = classifyDispatchPr({ num, startedAt: entry?.startedAt, prs: prList });
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
      // PREFIX match (#3331), not `listedIds.has(...)` — `handle` is the short id {@link parseBackgroundedHandle}
      // read off the dispatch's own confirmation, and `listedIds` (above) is full ids kept for the shape guard
      // only. See {@link isHandleListed}.
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
 * THE STALE GUARD IS THE HONEST COST OF ID-MATCHING. Ids match a predecessor's PR as well as this build's, so a
 * merge only counts when it happened at or after `startedAt` (which every in-flight entry carries — the
 * executor stamps it, and re-stamps it on every retry). A MISSING or unparseable `startedAt` fails CLOSED: with
 * no instant to compare against, no merge can be attributed, and the verdict is `stale`. The residual this
 * does not close, stated rather than hidden: a predecessor's PR that merges AFTER a retry started is inside the
 * window and would resolve the retry. Only a PR number stored on the entry could tell those apart, and that is
 * approach 2 — a persisted field, a `pr-land`→run-store coupling and a migration, which is not this item.
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
 * @returns {{verdict: 'merged'|'pending'|'parked'|'closed'|'stale', pr: object|null}}
 */
export function classifyDispatchPr({ num, startedAt = null, prs = null } = {}) {
  const key = normNum(num);
  // NO ITEM ID, or NO LISTING (the read failed / returned junk) → no verdict. `pending` is the word for "this
  // axis has nothing to say", and it is indistinguishable from "no PR yet" ON PURPOSE: both mean fall through.
  if (!key || !Array.isArray(prs)) return { verdict: 'pending', pr: null };

  const mine = prs.filter((p) => laneRefItemNum(p?.headRefName) === key);
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
 * `claude agents --json` — active sessions only. See {@link createDispatchObservers} for why not `--all`.
 *
 * BOUNDED, because this call sits synchronously inside a waker pass that promises to be fail-soft per run: a
 * `claude` that blocks (a cold start that wants to ask something, a wedged daemon) would otherwise stall every
 * OTHER parked run in the pass. A timeout turns that into one reported observer error, which is what the
 * contract says should happen.
 *
 * ASSERTED, not merely asserted-about. This function was called by no test at all, so both of the emphatic
 * claims above it — no `--all`, and a timeout — could be inverted with the suite green (PR #1211 review, F5/F6).
 * `dispatch-lane-defaults.test.mjs` now pins the argv and the opts, and the wake CLI test proves the same argv
 * across a real process boundary.
 *
 * @param {{exec?: Function, env?: object}} [io] - injected ONLY so the argv and opts can be asserted.
 */
export function defaultListAgents({ exec = execFileSync, env = process.env } = {}) {
  const out = exec('claude', ['agents', '--json'], {
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
