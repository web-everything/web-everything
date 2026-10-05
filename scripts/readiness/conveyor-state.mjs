#!/usr/bin/env node
/**
 * @file scripts/readiness/conveyor-state.mjs
 * @description The CONVEYOR TICK STATE-READ (WE #2611, epic #2612). ONE `--json` read that returns the whole
 *   conveyor tick picture — the build queue, the live lanes + their leases/breaches, free slots, in-flight lane
 *   PRs, the resident drain daemon's status, the idle-stop clock inputs, and a stalled-lane health verdict — so
 *   each tick of the /conveyor skill (#2613) starts from ONE deterministic read instead of four ad-hoc commands
 *   plus eyeballing. Scripted per platform-decisions.md#deterministic-core-thin-judgment (script-decidable →
 *   a deterministic, tested script single-sourced in we:scripts; skills/UIs SHELL it, never re-derive it).
 *
 * PURE-CORE / IO-SHELL SPLIT (the hard design constraint, mirrored from scope-lease-collect.mjs #2560):
 *   • The PURE core (every `shape*` / `derive*` / `assess*` fn and {@link assembleConveyorState}) has NO fs, git,
 *     `Date`, `child_process`, or `gh` — it takes the ALREADY-PARSED raw collector outputs plus an INJECTED clock
 *     (`now`) and returns the shaped object. It is unit-tested directly against fixtures, with zero git/network/gh.
 *   • The IO SHELL (the `main()` CLI, gated on `import.meta.url === pathToFileURL(process.argv[1]).href`) owns all
 *     side effects: it shells `backlog.mjs build-queue --json`, `lane-pool.mjs status --json`,
 *     `scope-lease-collect.mjs --json`, `gh pr list --json`, and (cross-repo, best-effort) the plateau drain
 *     daemon's `status --json`; reads `queued.json` + `lane-ports.json`; and scans delivery-agent transcript
 *     mtimes for the health scan. Every read is GUARDED — a failing collector degrades to a null/empty section
 *     plus an `errors[]` entry, never a crashed tick.
 *
 * COMPOSES, NEVER REINVENTS: the lanes section is derived from `lane-pool status --json` × the live scope-lease
 *   picture (`scope-lease-collect.mjs`, which itself composes the #2560 observer) — this script re-implements
 *   neither lease/overlap detection nor breach math, it just shapes their output into the tick view. The daemon
 *   section is the plateau daemon's OWN `status --json` verbatim-distilled (the daemon owns all drain logic,
 *   #2449). The health scan reuses the transcript-mtime stall approach from
 *   `.claude/skills/batch-backlog-items/workflow-progress.mjs`.
 *
 * DAEMON, GRACEFUL DEGRADE: the drain daemon lives in the SIBLING plateau-app repo, which may be absent (a WE-only
 *   checkout, or a lane pool without the sibling clone). When its CLI can't be found or errors, {@link shapeDaemon}
 *   yields the string `"unavailable"` — the conveyor skill SURFACES that to the operator (it offers `/drain`); it
 *   NEVER drains inline (landing is the resident daemon's job, per the ratified /conveyor design) — rather than
 *   failing the whole tick.
 */

import { planningRead } from '../lib/planning-snapshot.mjs';
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readQueueFile, resolveQueuePath, normNum, bornAsIndexFromItems, resolveBornAsRefs } from '../conveyor/queue-store.mjs';
import { collapseRollupToLatestPerName } from '../merge-ai-prs.mjs';
import { CI_TRUTH_EXCLUDED_CHECKS } from '../operations/pr-status.mjs';
// #3296 — `standDownComments` recovers "has a fixer already stood down here" from the PR's own comments
// (the same durable marker `reconcile-core.mjs`'s `planReconcile` already reads). Shaping it into the PR row
// here — rather than re-deriving it in the board — keeps the marker single-sourced at its one definition.
import { standDownComments } from '../conveyor/stand-down.mjs';
// #2659 — the infra-blocked state: a delivery/prepare agent that PUSHED its lane ref but failed PR-open on an
// outside dependency lands here (not a stall / gate-red). `deriveInfraByNum` is PURE (no fs/clock — it takes the
// raw store + injected `now`), safe for the pure core; the IO shell reads the sidecar via `readInfraStore`.
// #2661 — `correlateCause` refines an infra cause against a fetched githubstatus (a live outage vs a one-off) and
// `clusterByCause` collapses same-cause blocks into ONE degraded-infra signal (not N stall alarms); both are PURE.
// `fetchGithubStatus` is the IO-shell poll (best-effort, guarded) the health scan corroborates with.
import { deriveInfraByNum, readInfraStore, resolveInfraStorePath, correlateCause, clusterByCause, fetchGithubStatus } from '../conveyor/infra-blocked.mjs';
// #2613 — the SAME empty-scope test the dispatcher uses (normScope([]) === [] ⇒ no usable scope), so the tick
// picture's `unshaped` set and the dispatch plan's `unshaped-no-scope` holds can never disagree on what counts
// as "no predicted scope". scope-lease.mjs is import-clean (no node built-ins), safe for the pure core.
import { normScope } from './scope-lease.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';
import { isGroupingKind } from '../check-standards-rules.mjs';
// #x5n4zn3 — the SAME async rollout `we:scripts/readiness/dispatch-plan.mjs` already uses for its own
// collectors: `main()` here is already `async` (nothing else to propagate), and every bare `execFileSync`
// call site below shells another whole CLI (`backlog.mjs`/`lane-pool.mjs`/`scope-lease-collect.mjs`/the
// cross-repo drain-daemon/`gh`) exactly ONCE per tick, never in a per-item loop — so switching to `runBounded`
// is the low-risk, faithful rollout here (unlike `we:scripts/lane-pool.mjs`'s own internal git helper, which
// stays synchronous — see that file's header for why).
import { runBounded } from '../lib/bounded-child.mjs';

// ── PURE CORE (no fs / git / Date / child_process / gh — every input is passed IN) ───────────────────────────

/** The default stall threshold: a delivery-agent transcript silent longer than this reads as a suspected stall
 *  (mirrors workflow-progress.mjs's `WF_STALL_S` = 180s). Exported so a caller/test can override it. */
export const DEFAULT_STALL_MS = 180_000;

/**
 * Shape the ready/queued build queue from `backlog.mjs build-queue --json` (which lists the READY items in
 * next-to-build order — already unblocked, so `openBlockers` is empty by construction unless a producer annotates
 * it). Accepts the full command object (`{ queue: [...] }`) OR a bare row array OR null. Reads `scope` and
 * `openBlockers` DEFENSIVELY — a sibling lane (#2612's dispatch-plan script) may add a `scope` field to the build
 * queue rows; until then it is simply absent (→ null), and this never depends on it.
 *
 * `clearedNums` (#2613) is the SESSION-LOCAL conveyor queue — the ids the operator cleared for build via
 * `scripts/conveyor/queue.mjs` (the gitignored `.conveyor/queue.json` sidecar). When provided, a row's
 * `buildQueued` reflects SIDECAR membership (session-local operator intent), NOT the committed `buildQueued`
 * frontmatter — so `state.queue.filter(buildQueued)` (the conveyor skill's queue-empty test) tracks exactly
 * what the dispatch plan will pull. When `clearedNums` is null/absent, `buildQueued` falls back to the committed
 * frontmatter flag (backward-compatible with any caller that doesn't pass the sidecar).
 * @param {{queue?:object[]}|object[]|null|undefined} buildQueue
 * @param {Array<string|number>|null|undefined} clearedNums  the sidecar's cleared ids, or null to use frontmatter
 * @returns {Array<{num:(string|null), rank:(number|null), buildQueued:boolean, openBlockers:string[], scope:*, kind:(string|null), epicState:(string|null), prepared:boolean, preparedDate:(string|null)}>}
 */
export function shapeQueue(buildQueue, clearedNums = null) {
  const rows = Array.isArray(buildQueue)
    ? buildQueue
    : Array.isArray(buildQueue?.queue)
      ? buildQueue.queue
      : [];
  const clearedSet = Array.isArray(clearedNums) ? new Set(clearedNums.map(normNum)) : null;
  return rows.map((r) => ({
    num: r?.num != null ? String(r.num) : null,
    rank: r?.rank ?? null,
    // buildQueued: sidecar membership when a cleared set is injected (#2613), else the committed frontmatter flag.
    buildQueued: clearedSet ? clearedSet.has(normNum(r?.num)) : r?.buildQueued === true,
    // openBlockers: explicit field if present, else the item's `blockedBy`, else [] (a ready row has none).
    openBlockers: Array.isArray(r?.openBlockers)
      ? r.openBlockers.map(String)
      : Array.isArray(r?.blockedBy)
        ? r.blockedBy.map(String)
        : [],
    // scope: read defensively — absent today (the dispatch-plan sibling owns adding it), null until then.
    scope: r?.scope ?? null,
    // kind / epicState: enriched by the IO shell from the loader (#2645). `kind` drives the epic → `needs-slice`
    // surface (a container is never built); `epicState` lets the skill route a held epic precisely (`unsliced` →
    // /slice, `done` → resolve, `tracking`/`program`/`parked` → no slice). Both null until enriched.
    kind: r?.kind ?? null,
    epicState: r?.epicState ?? null,
    // prepared / preparedDate: enriched by the IO shell from the loader (#2647). `kind:decision` drives the
    // decision → `needs-decision` surface (a decision is never built); `prepared` lets the skill route a held
    // decision precisely — UNPREPARED → spawn a prepare-decision agent, PREPARED → present its forks for ratify.
    // `prepared` is false and `preparedDate` null until enriched (a decision then reads UNPREPARED — a SAFE
    // default: "prepare it", never a false "ready to ratify" surfaced with un-researched forks).
    prepared: r?.prepared === true,
    preparedDate: r?.preparedDate ?? null,
  }));
}

/**
 * Extract a backlog item id from a lane `headRefName` like `lane/2611-conveyor-state` or `lane/xe2fmix-slug`.
 * Returns the numeric run (`2611`) or a JIT slug (`xe2fmix` — the drain's pre-number `x`+base36 id). A ref whose
 * first segment is a plain word (`lane/hotfix-2611`) does NOT return the word — it falls back to a trailing
 * `-<digits>` (→ `2611`), and a ref with no recognizable id at all returns null (never a silent wrong id).
 *
 * RETRY REFS carry an attempt-tag letter glued directly onto the id (`lane/3441b-...`, a "b" retry of #3441,
 * mirroring `we:scripts/conveyor/lease-reaper.mjs`'s own `itemNumFromSession`/`laneRefItemNum` grammar for the
 * exact same dispatcher retry-naming convention). Both branches below allow one optional trailing `[a-z]`
 * before the delimiter so a retried PR still resolves to its base item instead of `null` — confirmed live
 * against `gh pr view 1851` (`lane/3441b-resolve-on-land-extractor`), which returned `null` before this fix.
 * The numeric branch is unambiguous (`\d+` is pure digits, so a trailing letter is always the tag). The
 * JIT-slug branch is NOT fully unambiguous — `{5,7}` is itself variable-length, so a base slug shorter than
 * the 7-char cap plus a 1-letter retry can total a length that also reads as a valid bare slug (the greedy
 * quantifier absorbs it, same as a real 7-char slug with no retry at all); only a base slug already at the
 * cap disambiguates correctly. Accepted, not fixed further: `laneRefItemNum` (the precedent this mirrors)
 * carries the identical ambiguity unaddressed, and it is currently unreachable in practice —
 * `itemNumFromSession`'s own grammar only ever retries a digit-identified session, never an `x`-hash one, so
 * no JIT-slug item is actually retried today (`#xaa7r2n`).
 * @param {string|null|undefined} ref
 * @returns {string|null}
 */
export function itemNumFromRef(ref) {
  if (!ref) return null;
  const s = String(ref);
  // Normal lane ref: the first segment after `lane/` is the numeric item number, optionally retry-tagged …
  let m = s.match(/lane\/(\d+)[a-z]?(?:-|$)/i);
  if (m) return m[1];
  // … or a JIT slug (the drain's pre-number id: `x` + 5-7 base36 chars — anchored so a plain word never matches),
  // also optionally retry-tagged.
  m = s.match(/lane\/(x[a-z0-9]{5,7})[a-z]?(?:-|$)/i);
  if (m) return m[1];
  // Fallback: a non-standard word-first ref (`lane/hotfix-2611`) → the TRAILING digits, not the leading word.
  m = s.match(/-(\d+)$/);
  if (m) return m[1];
  return null;
}

/**
 * Reverse the lane-ports registry (`{ "<num>": { lane, port?, repo? } }`, #2139/#2616) into the `{ [lane]: num }`
 * lookup the lanes/health scan keys on — each entry that carries a `lane` becomes `lane → num`. Pure: it takes the
 * ALREADY-PARSED registry object (the IO shell's {@link laneItemMap} reads the file). A missing / non-object /
 * array registry, or an entry with no `lane`, contributes nothing (→ {} — a missing mapping never fabricates a
 * lane→num). If two nums claim one lane (a stale entry a reset should have cleared), the LAST wins — deterministic;
 * the acquire reset/unmap path keeps the registry 1:1 per lane in practice.
 * @param {Record<string, {lane?:*}>|null|undefined} reg
 * @returns {Record<string, string>}
 */
export function reverseLaneItemMap(reg) {
  const map = {};
  if (reg && typeof reg === 'object' && !Array.isArray(reg)) {
    for (const [num, entry] of Object.entries(reg)) {
      if (entry && entry.lane != null) map[entry.lane] = num;
    }
  }
  return map;
}

/**
 * Distill a `gh pr` `statusCheckRollup` array into ONE CI token: `pass` (all complete & successful), `fail` (any
 * definitively-failed check), `pending` (any still-running / queued check, none failed), or `none` (no checks).
 * A definitively-red conclusion wins over pending; pending wins over pass. Never throws on a malformed rollup.
 *
 * #2925 — COLLAPSED TO THE LATEST ENTRY PER CHECK NAME FIRST (`collapseRollupToLatestPerName`,
 * `we:scripts/merge-ai-prs.mjs`), same rule `latestRequiredCheck` uses. This distils ALL checks into one token
 * rather than picking one out, so without the per-name collapse a superseded `CANCELLED` entry beside a later
 * `SUCCESS` for the same name still wins the `anyFail` fold even though the check that finished is green.
 *
 * EXCLUDES `CI_TRUTH_EXCLUDED_CHECKS` (`we:scripts/operations/pr-status.mjs`, currently just `review-gate`)
 * BEFORE folding — that check is BY DESIGN red for as long as a PR carries an un-cleared review hold, so
 * counting it here mislabels every un-reviewed PR `ci: 'fail'` and, via `isRedCi`/`isCiHealTarget`
 * (`we:scripts/conveyor/tick-core.mjs`), can misdirect the CI-heal loop at a PR whose only "failure" is
 * "nobody has reviewed it yet". See that constant's docblock for the full incident.
 * @param {Array<object>|null|undefined} statusCheckRollup
 * @returns {'pass'|'fail'|'pending'|'none'}
 */
export function ciRollup(statusCheckRollup) {
  const roll = collapseRollupToLatestPerName(statusCheckRollup)
    .filter((c) => !CI_TRUTH_EXCLUDED_CHECKS.includes(String(c?.name ?? c?.context ?? '')));
  if (roll.length === 0) return 'none';
  const RED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const DONE_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  let anyFail = false;
  let anyPending = false;
  for (const c of roll) {
    // A check-run reports `status`/`conclusion`; a legacy commit-status reports `state`. Prefer the terminal
    // `conclusion` when the run is COMPLETED, else fall back to the coarse `state`/`status`.
    const status = String(c?.status || '').toUpperCase();
    const conclusion = String(c?.conclusion || '').toUpperCase();
    const state = String(c?.state || '').toUpperCase();
    const verdict = conclusion || state || status;
    if (RED.has(verdict)) anyFail = true;
    else if (DONE_OK.has(verdict)) {
      /* complete & green — contributes nothing */
    } else anyPending = true; // COMPLETED-with-no-conclusion, IN_PROGRESS, QUEUED, PENDING, or unknown → pending
  }
  if (anyFail) return 'fail';
  if (anyPending) return 'pending';
  return 'pass';
}

/**
 * Shape the in-flight PR section from
 * `gh pr list --json number,state,statusCheckRollup,labels,headRefName,mergeStateStatus,comments`.
 * `mergeStateStatus` is carried through raw (e.g. `BEHIND`) so the tick's CI-heal loop can spot a
 * not-landable BEHIND+parked PR (`tick-core.mjs` isBehind/isCiHealTarget, #2666/#2738).
 *
 * `stoodDown` (#3296) is derived here, once, from the PR's own comments via {@link standDownComments} —
 * the SAME durable signal `reconcile-core.mjs`'s `planReconcile` reads to refuse re-dispatching a fixer. A
 * stand-down makes **no label change** (`stand-down.mjs`'s own contract: "the PR was left EXACTLY as the
 * reviewer left it"), so a stood-down PR still carries whatever `review:*` label it had — without this flag
 * a board or dashboard reading only `labels` cannot tell "parked for ordinary review" from "a fixer already
 * gave up and a human is the intended next step" apart. Shaping it into the row (rather than leaving every
 * consumer to re-scan `comments` itself) keeps the marker single-sourced at `stand-down.mjs`.
 * @param {Array<object>|null|undefined} prList
 * @returns {Array<{num:(string|null), prNumber:(number|null), state:string, ci:string, labels:string[], mergeStateStatus:string, stoodDown:boolean}>}
 */
export function shapePrs(prList) {
  const rows = Array.isArray(prList) ? prList : [];
  return rows.map((p) => ({
    num: itemNumFromRef(p?.headRefName),
    prNumber: Number(p?.number) || null,
    state: String(p?.state || ''),
    ci: ciRollup(p?.statusCheckRollup),
    // gh labels arrive as `[{name}]`; tolerate a bare-string array too.
    labels: Array.isArray(p?.labels)
      ? p.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
      : [],
    // Raw gh mergeable-state (e.g. `BEHIND`) — the CI-heal loop's BEHIND branch reads this (#2666/#2738).
    mergeStateStatus: String(p?.mergeStateStatus || ''),
    stoodDown: standDownComments(p?.comments).length > 0,
  }));
}

/**
 * Shape the live lanes section: `lane-pool status --json` rows (the pool + each lane's raw lease marker) crossed
 * with the live scope-lease picture (`scope-lease-collect.mjs --json`, per-lease predicted/observed/breach). Only
 * LIVE-LEASED lanes (`leased === true`) are active work streams. Each lane's `lease` paths come from the scope
 * picture's PREDICTED (declared/planned) scope when present, else the raw marker's `predictedScope`, else []; its
 * `breach` is the picture's per-lease breach set. `num` (the backlog item on the lane) is looked up in an injected
 * `laneItem` map (from the lane-ports registry) — null when unmapped.
 * @param {{poolStatus?:{lanes?:object[]}, scopePicture?:{leases?:object[]}, laneItem?:Record<string,*>}} input
 * @returns {Array<{lane:*, num:*, session:(string|null), lease:string[], breach:string[]}>}
 */
export function shapeLanes({ poolStatus, scopePicture, laneItem } = {}) {
  const laneRows = Array.isArray(poolStatus?.lanes) ? poolStatus.lanes : [];
  const held = laneRows.filter((l) => l && typeof l === 'object' && l.leased === true);
  const byLane = new Map();
  for (const s of Array.isArray(scopePicture?.leases) ? scopePicture.leases : []) byLane.set(s.lane, s);
  const itemMap = laneItem && typeof laneItem === 'object' ? laneItem : {};
  return held.map((l) => {
    const s = byLane.get(l.lane) || {};
    const lease = Array.isArray(s.predicted)
      ? s.predicted
      : Array.isArray(l.lease?.predictedScope)
        ? l.lease.predictedScope
        : [];
    return {
      lane: l.lane,
      num: itemMap[l.lane] ?? itemMap[String(l.lane)] ?? null,
      session: l.lease?.session ?? s.session ?? null,
      lease,
      breach: Array.isArray(s.breach) ? s.breach : [],
    };
  });
}

/**
 * #2659 — attach the infra-blocked detail to each lane whose item is recorded infra-blocked. `infraByNum` is the
 * `{ [normNum]: { cause, attempt, nextRetrySec, capped } }` map {@link deriveInfraByNum} produced from the store
 * (with an injected clock). A lane with a matching `num` gains an `infra` field — exactly the shape
 * `status-board.mjs`'s `infraOf` reads for its ⊘ marker + collapsed OUTAGE banner (#2660). A lane with no match
 * is returned UNCHANGED (no `infra` key), so a clean tick's lanes stay byte-for-byte as before. Pure.
 * @param {Array<{lane:*, num:*}>} lanes
 * @param {Record<string, object>} infraByNum
 * @returns {Array<object>}
 */
export function attachLaneInfra(lanes, infraByNum) {
  const map = infraByNum && typeof infraByNum === 'object' ? infraByNum : {};
  return (Array.isArray(lanes) ? lanes : []).map((l) => {
    const detail = l && l.num != null ? map[normNum(l.num)] : undefined;
    return detail ? { ...l, infra: detail } : l;
  });
}

/**
 * Count FREE lanes in the pool — lanes that exist, hold no live lease, and are not DIRTY (the conveyor's launch
 * budget). A lane with `leased === true` is occupied; a missing lane (`exists === false`) is not counted; a
 * `clean === false` lane (uncommitted work sitting unleased — orphaned from a crashed/killed session) is
 * excluded too, using the same `status --json` field the caller already fetched, no extra IO.
 *
 * THIS IS STILL AN OPTIMISTIC UPPER BOUND, NOT A GUARANTEE. `lane-pool list --acquirable` (what
 * `dispatch-plan.mjs` actually dispatches against) also excludes AHEAD lanes — clean, but carrying unpushed
 * commits — via `isLaneAcquirable`'s `dirtyOrAhead.ahead` check (we:scripts/lib/lane-lease.mjs). That needs a
 * fetch-and-compare per lane, too costly to run on every tick (the #2920/#2924 fan-out), so it is deliberately
 * NOT folded in here. A tick can therefore report `freeSlots > 0` while `dispatch-plan.mjs` holds every item
 * for `"no free lane"` — confirmed live, 2026-08-29 (all 41 lanes on one host: 10 leased, 17 dirty, and the
 * remaining 14 "clean" ones every one of them AHEAD) — `dispatch-plan.mjs`'s own hold reason is authoritative
 * for whether a specific dispatch can actually launch; `freeSlots` is a cheap status-line estimate only.
 *
 * #4345 — a `status --leased-only` read never sets `clean` on an unleased row (no git ran there), and this fn's
 * `clean !== false` test reads that missing field as clean (`undefined !== false` is `true`) — so it needs NO
 * special-casing for a leased-only payload: an unleased row is simply never excluded on the `clean` test, which
 * is exactly the (documented, already-tolerated) lenient behavior this card wants. Asserted directly — this fn
 * called on both a `--leased-only` and a full `status` payload of the same fixture, same count — in
 * we:scripts/__tests__/lane-pool-status-leased-only.test.mjs (a first cut added a separate
 * `computeFreeSlotsLeasedOnly` fn + a branch to "handle" this; a `/converge` panel round caught it computing the
 * identical count with no test defending either path, so both the fn and the branch were removed — #4345 round
 * 1 — and this assertion was added in their place).
 * @param {{lanes?:object[]}|null|undefined} poolStatus
 * @returns {number}
 */
export function computeFreeSlots(poolStatus) {
  const laneRows = Array.isArray(poolStatus?.lanes) ? poolStatus.lanes : [];
  return laneRows.filter((l) => l && typeof l === 'object' && l.exists !== false && l.leased !== true && l.clean !== false).length;
}

/**
 * Distill the plateau drain daemon's `status --json` report (WE #2449) into the tick's `daemon` section, or the
 * string `"unavailable"` when the daemon CLI was absent / errored (a null/non-object report). Reads the report
 * DEFENSIVELY across its known shape (`launchd.loaded` → resident; top-level `lastPass`/`parkedNow`) with legacy
 * fallbacks, so a daemon-shape change degrades a field to a safe default rather than throwing.
 * @param {object|null|undefined} report
 * @returns {'unavailable'|{resident:boolean, lastPass:(object|null), parked:object[]}}
 */
export function shapeDaemon(report) {
  if (!report || typeof report !== 'object') return 'unavailable';
  const resident = report.launchd?.loaded ?? report.loaded ?? report.resident ?? false;
  const lastPass = report.lastPass ?? report.state?.lastPass ?? null;
  const parked = report.parkedNow ?? report.state?.parkedNow ?? report.parked ?? [];
  return { resident: !!resident, lastPass: lastPass ?? null, parked: Array.isArray(parked) ? parked : [] };
}

/**
 * The most recent MERGE timestamp from the daemon report — the newest `at` across `[lastPass, ...history]` whose
 * pass actually merged something (`merged > 0`). ISO strings compare lexicographically, so a plain `>` finds the
 * latest. null when the daemon is unavailable or has never merged in its retained window.
 * @param {object|null|undefined} report
 * @returns {string|null}
 */
export function lastMergeFromDaemon(report) {
  if (!report || typeof report !== 'object') return null;
  const passes = [report.lastPass, ...(Array.isArray(report.history) ? report.history : [])].filter(Boolean);
  let best = null;
  for (const p of passes) {
    if ((Number(p?.merged) || 0) > 0 && p?.at && (best === null || String(p.at) > best)) best = String(p.at);
  }
  return best;
}

/**
 * The most recent QUEUE-ADD timestamp from the parsed `queued.json` state (the newest `at` among queued items).
 * null when nothing is queued / the state is empty.
 * @param {{queued?:Array<{at?:string}>}|null|undefined} queuedState
 * @returns {string|null}
 */
export function lastQueueAddFromQueued(queuedState) {
  const q = Array.isArray(queuedState?.queued) ? queuedState.queued : [];
  let best = null;
  for (const e of q) if (e?.at && (best === null || String(e.at) > best)) best = String(e.at);
  return best;
}

/**
 * The idle-stop clock inputs the conveyor skill's idle-wait timer reads: the last merge, the last queue-add, and
 * the injected `now`. The clock (`now`) is passed IN — the pure core never calls `Date.now()` (determinism).
 * @param {{daemonReport?:object|null, queuedState?:object|null, now?:number|string|null}} input
 * @returns {{lastMerge:(string|null), lastQueueAdd:(string|null), now:(number|string|null)}}
 */
export function deriveIdle({ daemonReport, queuedState, now } = {}) {
  return {
    lastMerge: lastMergeFromDaemon(daemonReport),
    lastQueueAdd: lastQueueAddFromQueued(queuedState),
    now: now ?? null,
  };
}

/**
 * Does a transcript's text mention item `num` as a DISTINCT id? ANCHORED — the `#<num>` match must NOT be
 * followed by another alphanumeric, so `#26` never matches `#2611` / `#261x`, and a JIT slug never matches a
 * longer one. Without this anchor an unrelated recent session (`#2611`) masks a real stall on `#26` — the exact
 * failure the health verdict exists to catch. Mirrors workflow-progress.mjs's anchored item-id scrape.
 * @param {string} text  a transcript tail.
 * @param {string|number} num  the item id (numeric run or JIT slug).
 * @returns {boolean}
 */
export function transcriptMentionsItem(text, num) {
  if (!text || num == null) return false;
  const esc = String(num).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('#' + esc + '(?![0-9A-Za-z])').test(String(text));
}

/**
 * The health verdict — stalled-lane detection via delivery-agent transcript mtimes (reusing the approach in
 * workflow-progress.mjs). A lane is STALLED when its transcript's last activity (`lastActivity`, epoch ms) is
 * older than `stallMs`. A lane with `lastActivity == null` (no transcript located) is NOT flagged — a missing
 * mapping must never fabricate a stall. `errors` are collector-level read failures surfaced by the IO shell.
 * `verdict` is `warn` when anything is stalled OR any error was collected, else `ok`. The clock (`now`) and all
 * activity timestamps are passed IN — no `Date`/fs here (determinism).
 *
 * #2661 — a WIDESPREAD external-infra failure is ONE signal, not N. An infra-blocked lane has a KNOWN external
 * cause (recorded in the infra state, `l.infra.cause`); rather than dropping it (which surfaced it only via the
 * board's OUTAGE banner, never the health verdict the tick loop reads), collect every infra lane and CLUSTER by
 * cause into `degradedInfra` — so several lanes down on the SAME outage collapse into ONE `{ cause, count,
 * members }` entry, not N stall alarms. A genuine per-lane STALL (a silent non-infra lane) still surfaces on its
 * own in `stalled`. `degradedInfra` is ADDITIVE and does NOT flip `verdict` (kept `stalled`+`errors`-driven for
 * consumer back-compat; the outage is its own distinct signal, read separately). When a fetched `githubStatus` is
 * injected, each infra cause is refined against it via {@link correlateCause} (a live incident vs a one-off) —
 * null-safe by construction, so a missing/failed poll NEVER cascades into a false or lost signal.
 * @param {{lanes?:Array<{lane:*, num?:*, session?:*, lastActivity?:(number|null), infra?:{cause?:string}}>, now?:number, stallMs?:number, errors?:string[], githubStatus?:object|null}} input
 * @returns {{verdict:'ok'|'warn', stalled:Array<{lane:*, num:*, session:*, idleS:number}>, degradedInfra:Array<{cause:string, count:number, members:Array<{lane:*, num:*}>}>, errors:string[]}}
 */
export function assessHealth({ lanes = [], now = 0, stallMs = DEFAULT_STALL_MS, errors = [], githubStatus = null } = {}) {
  const stalled = [];
  const infraMembers = [];
  for (const l of Array.isArray(lanes) ? lanes : []) {
    // #2659/#2661 — an infra-blocked lane is DISTINCT from a stall: its agent exited (so its transcript goes
    // silent) but the work is pushed + tracked by the infra state, which is auto-retrying. It never reads as a
    // ⚠ stall; instead its KNOWN cause feeds the degraded-infra cluster below (ONE signal per outage cause).
    if (l?.infra) {
      // Refine the cause against a fetched githubstatus when injected (live outage vs one-off); null → the store
      // cause as-is (already refined by infra-blocked's retry pass). correlateCause is null-safe → no cascade.
      infraMembers.push({ lane: l.lane, num: l.num ?? null, cause: correlateCause(l.infra.cause, githubStatus) });
      continue;
    }
    const last = l?.lastActivity;
    if (last == null) continue; // no transcript located → conservative (never a false stall)
    if (now - Number(last) > stallMs) {
      stalled.push({
        lane: l.lane,
        num: l.num ?? null,
        session: l.session ?? null,
        idleS: Math.round((now - Number(last)) / 1000),
      });
    }
  }
  // Collapse same-cause infra blocks into ONE degraded-infra signal per cause (#2661).
  const degradedInfra = clusterByCause(infraMembers);
  const errs = (Array.isArray(errors) ? errors : []).filter(Boolean).map(String);
  return { verdict: stalled.length || errs.length ? 'warn' : 'ok', stalled, degradedInfra, errors: errs };
}

/**
 * The CLEARED-BUT-NOT-READY ids (#2613 review, required 2b): the sidecar ids (`clearedNums`) with NO row in the
 * build queue. `build-queue --json .queue` is hard-filtered to READY items, so a cleared id that is blocked /
 * resolved / a typo lands in the sidecar but never in a row — without surfacing it the operator gets NO feedback
 * (the "I cleared it, nothing happened" failure #2613 kills). This returns each such id (stored spelling) for the
 * tick's `clearedNotReady` signal. Pure — normalizes both sides via {@link normNum}.
 * @param {{queue?:object[]}|object[]|null|undefined} buildQueue  the build-queue rows (ready set)
 * @param {Array<string|number>|null|undefined} clearedNums  the sidecar ids
 * @returns {Array<string|number>}
 */
export function deriveClearedNotReady(buildQueue, clearedNums) {
  if (!Array.isArray(clearedNums)) return [];
  const rows = Array.isArray(buildQueue)
    ? buildQueue
    : Array.isArray(buildQueue?.queue)
      ? buildQueue.queue
      : [];
  const ready = new Set(rows.map((r) => normNum(r?.num)));
  return clearedNums.filter((n) => n != null && String(n) !== '' && !ready.has(normNum(n)));
}

/**
 * The UNSHAPED set (#2613 auto-prepare, ruled 2026-07-22): the ARMED (cleared-for-build) queue rows with NO
 * usable predicted `scope`. These are exactly the items the dispatcher NEVER launches to build — it holds every
 * one `unshaped-no-scope` (never runs it blind), and the /conveyor skill reads THIS set to dispatch a prepare-scope
 * task that authors each item's `scope:` upstream; once that lands the item is scoped and dispatches to BUILD.
 * Surfacing them here is how the skill decides to AUTO-PREPARE: "these cleared items have no scope — prepare it so
 * they can build and parallelize." An item counts as unshaped when its scope is absent / non-array / empty /
 * all-blank (the SAME `normScope`-emptiness test the dispatcher keys on) AND it is NOT a grouping kind (`epic`, or
 * `feature` — #2998 epic-parity; {@link isGroupingKind}) — a grouping kind is held `needs-slice` BEFORE the scope
 * gate in the dispatcher (a container is sliced, never scope-authored), so this excludes grouping kinds to mirror
 * that precedence EXACTLY: a scope-less container surfaces ONLY in {@link deriveNeedsSlice}, never here. Without
 * that guard an armed scope-less container (the common case — containers rarely carry scope) would appear in BOTH
 * sets, and the skill's §3b would aim a prepare-scope agent at a container — the very hazard #2645 closes (and the
 * exact regression a cleared `kind:feature` reached before #2998's fix, since only `epic` was excluded here).
 * A `kind:decision` is excluded for the SAME reason (#2647): it is held `needs-decision` before the scope gate (a
 * decision is prepared/presented, never scope-authored), and surfaces ONLY in {@link deriveDecisions}. A
 * `kind:investigation` is excluded too (#3567): it is held `needs-investigation` before the scope gate and is
 * spawned straight off `plan.held`, never scope-authored. So the surfaces never disagree with `plan.held`. Reads `buildQueued` from the session-local sidecar when
 * `clearedNums` is injected (else the committed frontmatter flag), so `unshaped` tracks exactly what the operator
 * cleared this session. Pure — shapes the queue via {@link shapeQueue} and filters; no fs / clock.
 * @param {{queue?:object[]}|object[]|null|undefined} buildQueue  the build-queue rows (scope+kind-enriched by the shell)
 * @param {Array<string|number>|null|undefined} clearedNums  the sidecar's cleared ids, or null to use frontmatter
 * @returns {Array<{num:(string|null), scope:*}>} the armed, no-usable-scope, non-grouping, non-decision, non-investigation rows (spelling kept)
 */
export function deriveUnshaped(buildQueue, clearedNums = null) {
  return shapeQueue(buildQueue, clearedNums)
    // Grouping kinds (epic/feature) are held `needs-slice` and decisions `needs-decision`, both BEFORE the scope
    // gate (see deriveNeedsSlice / deriveDecisions) — exclude both so a scope-less container/decision is not
    // double-surfaced as unshaped (which would drive §3b to prepare-scope a container #2645/#2998, or a decision
    // that needs no build scope #2647). A `kind:investigation` is excluded for the same reason (#3567): the
    // dispatcher holds it `needs-investigation` before the scope gate, and `planPrepareSpawns` shares ONE guard set
    // across both lists — so surfacing it here would spawn a wrong-kind prepare-scope agent and silently swallow
    // the real investigate spawn.
    .filter((r) => r.buildQueued && !isGroupingKind(r.kind) && r.kind !== 'decision' && r.kind !== 'investigation' && normScope(r.scope).length === 0)
    .map((r) => ({ num: r.num, scope: r.scope }));
}

/**
 * The NEEDS-SLICE set (#2645, extended #2998): the ARMED (cleared-for-build) queue rows that are a GROUPING kind
 * (`epic`, or `feature` — epic-parity; {@link isGroupingKind}). A grouping kind is a CONTAINER — its work lives in
 * children (an epic's stories/tasks, a feature's epics) — so the dispatcher NEVER launches it to build; it holds
 * every cleared grouping item `needs-slice` (mirroring how {@link deriveUnshaped} tracks the `unshaped-no-scope`
 * holds), and the /conveyor skill reads THIS set to surface each for `/slice` so a cleared container is decomposed
 * into buildable children instead of silently stalling. Each entry carries `epicState` so the skill routes
 * precisely: `unsliced` → `/slice`; `done` → resolve; `tracking` / `program` / `parked` → no slice (its children
 * ARE the work / a recorded reason gates it). Kept aligned with the dispatch plan's `needs-slice` holds — the two
 * surfaces read the same `isGroupingKind` signal off the same enriched rows, so they never disagree on which
 * cleared items are containers.
 * Pure — shapes the queue via {@link shapeQueue} and filters; no fs / clock.
 * @param {{queue?:object[]}|object[]|null|undefined} buildQueue  the build-queue rows (kind-enriched by the shell)
 * @param {Array<string|number>|null|undefined} clearedNums  the sidecar's cleared ids, or null to use frontmatter
 * @returns {Array<{num:(string|null), epicState:(string|null)}>} the armed, grouping-kind rows (stored spelling kept)
 */
export function deriveNeedsSlice(buildQueue, clearedNums = null) {
  return shapeQueue(buildQueue, clearedNums)
    .filter((r) => r.buildQueued && isGroupingKind(r.kind))
    .map((r) => ({ num: r.num, epicState: r.epicState }));
}

/**
 * The DECISIONS set (#2647): the ARMED (cleared-for-build) queue rows that are a `kind:decision`. A decision is
 * NOT build work — its lifecycle is prepare (research + author its forks to "ready to ratify") then present
 * (surface the prepared forks for a human to ratify). The dispatcher NEVER launches a decision to build; it holds
 * every cleared decision `needs-decision` BEFORE the scope gate (mirroring how {@link deriveNeedsSlice} tracks the
 * `needs-slice` holds), and the /conveyor skill reads THIS set to drive each per its `prepared` state: UNPREPARED
 * (`prepared === false`) → spawn a prepare-decision agent that researches + authors its forks and lands a
 * `preparedDate`; PREPARED → present its forks (a chat artefact + the ruling surface) for ratification. Each entry
 * carries `prepared` + `preparedDate` so the skill routes precisely, exactly as `needs-slice` carries `epicState`.
 * Kept aligned with the dispatch plan's `needs-decision` holds — the two surfaces read the same `kind:decision`
 * signal off the same enriched rows, so they never disagree on which cleared items are decisions. Pure — shapes the
 * queue via {@link shapeQueue} and filters; no fs / clock.
 * @param {{queue?:object[]}|object[]|null|undefined} buildQueue  the build-queue rows (kind+prepared-enriched by the shell)
 * @param {Array<string|number>|null|undefined} clearedNums  the sidecar's cleared ids, or null to use frontmatter
 * @returns {Array<{num:(string|null), prepared:boolean, preparedDate:(string|null)}>} the armed, `kind:decision` rows
 */
export function deriveDecisions(buildQueue, clearedNums = null) {
  return shapeQueue(buildQueue, clearedNums)
    .filter((r) => r.buildQueued && r.kind === 'decision')
    .map((r) => ({ num: r.num, prepared: r.prepared, preparedDate: r.preparedDate }));
}

/**
 * The top-level PURE composer: raw collector outputs (+ an injected clock) → the whole conveyor tick picture. The
 * IO shell gathers the raw inputs and calls this; a test drives it directly with fixtures. `laneActivity` is a
 * `{ [lane]: epochMs }` map of each active lane's last transcript activity (the shell's best-effort transcript
 * scan); it is folded into the lanes ONLY for the health scan (the emitted `lanes` section stays activity-free).
 * @param {{
 *   buildQueue?:object|object[]|null, poolStatus?:object|null, scopePicture?:object|null, prList?:object[]|null,
 *   daemonReport?:object|null, queuedState?:object|null, laneItem?:Record<string,*>|null,
 *   laneActivity?:Record<string,number>|null, clearedNums?:Array<string|number>|null,
 *   infraBlocks?:object[]|null, githubStatus?:object|null, now?:number, stallMs?:number, errors?:string[],
 * }} input
 * @returns {{queue:object[], clearedNotReady:Array<string|number>, unshaped:object[], needsSlice:object[], decisions:object[], lanes:object[], freeSlots:number, prs:object[], daemon:*, idle:object, health:object, infraBlocked:object[]}}
 */
export function assembleConveyorState({
  buildQueue,
  poolStatus,
  scopePicture,
  prList,
  daemonReport,
  queuedState,
  laneItem,
  laneActivity,
  clearedNums = null,
  infraBlocks = null,
  githubStatus = null,
  now,
  stallMs = DEFAULT_STALL_MS,
  errors = [],
} = {}) {
  // #2659 — the infra-blocked state: attach each blocked item's `{ cause, attempt, nextRetrySec, capped }` to
  // its lane (the ⊘ marker + OUTAGE banner status-board reads), and fold it into the health scan so an
  // infra-blocked lane never reads as a stall. `deriveInfraByNum` is clock-injected (deterministic).
  const infraByNum = deriveInfraByNum(Array.isArray(infraBlocks) ? infraBlocks : [], now);
  const lanes = attachLaneInfra(shapeLanes({ poolStatus, scopePicture, laneItem }), infraByNum);
  const actMap = laneActivity && typeof laneActivity === 'object' ? laneActivity : {};
  const healthLanes = lanes.map((l) => ({
    ...l,
    lastActivity: actMap[l.lane] ?? actMap[String(l.lane)] ?? null,
  }));
  return {
    queue: shapeQueue(buildQueue, clearedNums),
    // Cleared ids with no ready build-queue row — surfaced so a clear never silently vanishes (#2613 review, 2b).
    clearedNotReady: deriveClearedNotReady(buildQueue, clearedNums),
    // Armed rows with NO predicted scope — the dispatcher NEVER builds these; the /conveyor skill reads this set
    // to AUTO-PREPARE each item's scope upstream, after which it dispatches to build (#2613 auto-prepare).
    unshaped: deriveUnshaped(buildQueue, clearedNums),
    // Armed grouping-kind (`epic`/`feature`) rows — the dispatcher NEVER builds a container; the /conveyor skill
    // reads this set to SURFACE each for `/slice` so a cleared container is decomposed into buildable children
    // (#2645, extended #2998).
    needsSlice: deriveNeedsSlice(buildQueue, clearedNums),
    // Armed `kind:decision` rows — the dispatcher NEVER builds a decision; the /conveyor skill reads this set to
    // drive each by its `prepared` state: UNPREPARED → prepare-decision agent; PREPARED → present its forks (#2647).
    decisions: deriveDecisions(buildQueue, clearedNums),
    lanes,
    // #4345 — unchanged: `computeFreeSlots`'s own `clean !== false` test already reads a `--leased-only` read's
    // missing `clean` on an unleased row as clean (see that fn's docblock), so no branch is needed here.
    freeSlots: computeFreeSlots(poolStatus),
    prs: shapePrs(prList),
    daemon: shapeDaemon(daemonReport),
    idle: deriveIdle({ daemonReport, queuedState, now }),
    health: assessHealth({ lanes: healthLanes, now, stallMs, errors, githubStatus }),
    // #2659 — the raw infra-blocked entries (pushed-but-unopened work, auto-retrying). Attached to lanes above
    // for the board; emitted here in full so the /conveyor skill can surface a capped/surfaced block for the
    // operator even if its lane's lease was somehow lost (defense — the record, not the lane, is the truth).
    infraBlocked: Array.isArray(infraBlocks) ? infraBlocks : [],
  };
}

// ── IO SHELL (runs only as a CLI — owns all git / child_process / gh / fs / clock) ───────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // scripts/readiness → repo root
const BACKLOG_CLI = join(ROOT, 'scripts', 'backlog.mjs');
const LANE_POOL_CLI = join(ROOT, 'scripts', 'lane-pool.mjs');
const SCOPE_COLLECT_CLI = join(HERE, 'scope-lease-collect.mjs');
const QUEUED_PATH = join(ROOT, '.claude', 'skills', 'batch-backlog-items', 'queued.json');
const LANE_PORTS_PATH = join(ROOT, '.claude', 'lane-ports.json');

// stdout = machine payload ONLY; ALL logs / human text → stderr.
const log = (m) => process.stderr.write(m + '\n');

/** Hand-rolled `--k=v` flag parsing. */
function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

// #x5n4zn3 — a listing/status call's budget: generous enough for a real pool/backlog walk, but bounded so a
// hung child (the 2026-09-23 incident: `lane-pool.mjs list`-shaped reads stalling) fails THIS one section of
// the tick, never the whole tick.
const RUN_JSON_TIMEOUT_MS = 2 * 60_000;
/** Run a node CLI and JSON-parse its stdout, or return `fallback` + push a message to `errors` on any failure. */
async function runJson(node, args, { cwd = ROOT, errors, label } = {}) {
  try {
    return await planningRead(args, async () => {
      const out = await runBounded(node, args, { cwd, timeoutMs: RUN_JSON_TIMEOUT_MS, maxBytes: 64 * 1024 * 1024 });
      return JSON.parse(out);
    });
  } catch (e) {
    if (errors) errors.push(`${label}: ${String(e.message || e).split('\n')[0]}`);
    return undefined;
  }
}

/** Read + JSON-parse a file, or return `fallback` (never throws — a missing/corrupt file is a soft miss). */
function readJsonFile(path, fallback = null) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return obj ?? fallback;
  } catch {
    return fallback;
  }
}

/** Locate the cross-repo plateau drain-daemon CLI: env override, else the sibling `../plateau-app` (resolves in
 *  BOTH the primary checkout and a lane pool root, which carries a plateau-app sibling clone). null when absent. */
function findDaemonCli() {
  const env = process.env.CONVEYOR_DRAIN_DAEMON_CLI;
  const candidates = [
    env,
    resolve(ROOT, '..', 'plateau-app', 'tools', 'drain-daemon', 'cli.mjs'),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** The lane → item-num map, reverse-derived from the lane-ports registry (`{ "<num>": { lane, port, repo } }`).
 *  The registry is POPULATED by `lane-pool.mjs acquire --item=<num>` (#2616) — a delivery agent's own lease records
 *  its item→lane there — so this map is non-empty during live conveyor work and the health-stall scan can flag a
 *  genuinely stalled lane. (Before #2616 nothing wrote it, so it stayed `{}`, no lane carried a num, and the scan
 *  was permanently inert — `assessHealth` always `ok`; the silent hole this closed.) The pure reverse is
 *  {@link reverseLaneItemMap}; this IO wrapper just reads + parses the registry file. */
function laneItemMap() {
  return reverseLaneItemMap(readJsonFile(LANE_PORTS_PATH, {}));
}

// ── best-effort delivery-agent transcript scan (health) — the IO half of the stall check ─────────────────────
// Reuses workflow-progress.mjs's approach: a transcript's mtime IS its last-activity clock, and an item's number
// is written distinctively in a worker's prompt (`#NNNN`). For each active lane we find the newest transcript
// whose tail references the lane's item number (ANCHORED, via transcriptMentionsItem) and take its mtime.
//
// LIMITS (best-effort by design — the PURE assessHealth verdict is the tested contract; this shell scan only
// supplies its `lastActivity` inputs, and a miss degrades to the conservative "no transcript ⇒ never a stall"):
//   • MAP: no reliable lane→session-uuid map exists, so a lane is matched by its item `#num` scraped from the
//     transcript. That number comes from `.claude/lane-ports.json` (`{ "<num>": { lane } }`), which
//     `lane-pool.mjs acquire --item=<num>` POPULATES when a delivery agent leases its lane (#2616) — so a live
//     conveyor lane carries a num and this scan is ACTIVE. When the registry is empty (no acquire recorded a num
//     — a stale or hand-run lane), the scan degrades to the conservative `ok` (nothing to flag), never a false warn.
//   • TAIL: only the last TAIL_BYTES of each transcript is read, so an item id stated ONLY in a session's opening
//     prompt (never restated) can be missed. Acceptable — a live delivery agent restates its item id as it works.
//   • WINDOW: ACTIVITY_WINDOW_MS is kept FAR PAST the stall threshold on purpose. A lane silent LONGER than the
//     window is precisely the stall we want to catch, so the window must never drop that lane's (old-mtime)
//     transcript — it caps scan COST only, never the stall reach.
const PROJECTS = join(homedir(), '.claude', 'projects');
const ACTIVITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14d — far past any stall threshold, so a long-silent (stalled) lane's transcript is still found, not dropped
const TAIL_BYTES = 16 * 1024; // bounded tail read — a session transcript can be large

/** Read the last ≤ `TAIL_BYTES` of a file as utf8, or '' on any error. */
function readTail(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return '';
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, 'r');
    const got = readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8', 0, got);
  } catch {
    return '';
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** All recent (`mtime` within the window) session `.jsonl` transcripts under ~/.claude/projects. */
function recentTranscripts(nowMs) {
  const out = [];
  let projects = [];
  try { projects = readdirSync(PROJECTS).map((d) => join(PROJECTS, d)); } catch { return out; }
  for (const proj of projects) {
    let files = [];
    try { files = readdirSync(proj); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(proj, f);
      const m = (() => { try { return statSync(path).mtimeMs; } catch { return 0; } })();
      if (m && nowMs - m <= ACTIVITY_WINDOW_MS) out.push({ path, mtime: m });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** `{ [lane]: lastActivityMs }` — for each active lane with a mapped item num, the newest recent transcript whose
 *  tail references `#<num>`. Unmapped / unmatched lanes are simply omitted (→ null activity in the pure scan). */
function collectLaneActivity(lanes, nowMs) {
  const nums = lanes.map((l) => l.num).filter((n) => n != null).map(String);
  if (nums.length === 0) return {};
  const transcripts = recentTranscripts(nowMs);
  const numToMtime = new Map();
  for (const t of transcripts) {
    const tail = readTail(t.path);
    if (!tail) continue;
    for (const num of nums) {
      if (numToMtime.has(num)) continue; // transcripts are newest-first — first hit is the freshest
      if (transcriptMentionsItem(tail, num)) numToMtime.set(num, t.mtime);
    }
    if (numToMtime.size === nums.length) break;
  }
  const activity = {};
  for (const l of lanes) {
    const hit = l.num != null ? numToMtime.get(String(l.num)) : undefined;
    if (hit != null) activity[l.lane] = hit;
  }
  return activity;
}

/** The IO shell: gather every raw collector output, then compose the pure picture and emit it. */
async function main(argv) {
  const flags = parseFlags(argv);
  const errors = [];
  const nowMs = Date.now();

  // 1. Build queue (ready + queued items, ranked) — READ-ONLY. `--backlog-dir` (#3445) points the whole read
  //    (and, via `WE_BACKLOG_DIR` below, the enrichment require at 1b) at a fixture corpus instead of the
  //    live `backlog/` directory — the dispatcher-fixture-root thread (#3402).
  const buildQueueArgs = ['build-queue', '--json'];
  if (typeof flags['backlog-dir'] === 'string') {
    buildQueueArgs.push(`--backlog-dir=${flags['backlog-dir']}`);
    process.env.WE_BACKLOG_DIR = flags['backlog-dir'];
  }
  const buildQueue = await runJson('node', [BACKLOG_CLI, ...buildQueueArgs], { errors, label: 'build-queue' });

  // 1b. Enrich the build-queue rows with each item's predicted `scope`, `kind`, `epicState`, and `preparedDate`
  //     (the `build-queue` view omits them) so the tick picture can flag UNSHAPED armed items — cleared-for-build
  //     rows with no predicted scope, which the dispatcher NEVER builds (the skill AUTO-PREPARES their scope
  //     instead, #2613) — NEEDS-SLICE armed items — cleared `kind:epic` containers, which the dispatcher NEVER
  //     builds either (the skill surfaces them for `/slice`, #2645) — AND DECISIONS — cleared `kind:decision`
  //     rows, which the dispatcher NEVER builds either (the skill prepares/presents them, #2647; `preparedDate`
  //     splits prepare-vs-present). Best-effort + guarded: a load failure leaves scope/kind
  //     absent (every armed row then reads as unshaped and non-epic — a SAFE over-surface: "prepare scope", never a
  //     false parallel claim, and no false needs-slice) and is logged to stderr ONLY, NOT pushed to errors[] (a
  //     cosmetic enrichment miss must not flip the tick's health verdict to warn). Mirrors dispatch-plan.mjs's own
  //     enrichment.
  // Loaded here (rather than only inside the `if` below) so it is ALSO available for the bornAs resolution at
  // 5b below even on a tick whose build-queue happens to be empty — a stale-hash sidecar row must still resolve
  // (or fail to) the same way regardless of what's currently ready.
  let backlogItems = [];
  try {
    const require = createRequire(import.meta.url);
    const loadBacklog = require(join(ROOT, 'src', '_data', 'backlog.js'));
    backlogItems = typeof loadBacklog === 'function' ? loadBacklog() : [];
  } catch (e) {
    log(`  ⚠ could not load backlog for scope/kind enrichment (${String(e.message || e).split('\n')[0]}) — armed items read as unshaped, non-epic`);
  }
  if (buildQueue && Array.isArray(buildQueue.queue) && buildQueue.queue.length && backlogItems.length) {
    try {
      const byNum = new Map(backlogItems.map((it) => [String(it.num), it]));
      buildQueue.queue = buildQueue.queue.map((r) => {
        const it = byNum.get(String(r?.num));
        return {
          ...r,
          scope: r?.scope ?? it?.scope ?? null,
          kind: r?.kind ?? it?.kind ?? null,
          epicState: r?.epicState ?? it?.epicState ?? null,
          // prepared / preparedDate (#2647): drive the `kind:decision` → prepared-vs-unprepared routing. A
          // decision with a `preparedDate` reads PREPARED (present its forks); without, UNPREPARED (prepare them).
          prepared: r?.prepared ?? (it?.preparedDate != null),
          preparedDate: r?.preparedDate ?? it?.preparedDate ?? null,
        };
      });
    } catch (e) {
      log(`  ⚠ could not load backlog for scope/kind enrichment (${String(e.message || e).split('\n')[0]}) — armed items read as unshaped, non-epic`);
    }
  }

  // 2. Lane pool status + the live scope-lease picture (leases / overlaps / breach).
  //    #x7xv2xt — FIXTURE MODE (`--backlog-dir`, or an explicit `--no-lane-pool`) never touches the real lane
  //    pool: both reads would scan every real lane (a `git` walk per lane) for a synthetic corpus that has no
  //    lanes at all. The picture gets an empty pool instead, and says so in `lanePool`.
  const skipLanePool = typeof flags['backlog-dir'] === 'string' || flags['no-lane-pool'] === true;
  let poolStatus;
  let scopePicture;
  if (skipLanePool) {
    poolStatus = { lanes: [] };
    scopePicture = { leases: [] };
  } else {
    // #4345 — `--leased-only`: `shapeLanes` below and `computeFreeSlots`'s free-slot count only ever need LEASED
    // rows (the latter by construction — its `clean !== false` test already reads a missing `clean` as clean),
    // so the git probe (rev-parse ×2, `status --porcelain`, rev-list) is wasted on the ~88/90 lanes that are NOT
    // leased on a typical tick — skipping it there cuts ~364 git spawns/tick to a handful (measured live: 8).
    // Deliberately NOT switched to also fetch `list --acquirable` for a stricter freeSlots count: that read is
    // its own, separately-scanned cost (its own single-flight cache, #xn432dz), and folding it into EVERY
    // conveyor-state.mjs call (not just inside a tick-core tick, where a nearby call already pays it) would trade
    // this card's whole saving right back — live-measured at 170 git spawns / 42.6s on the real pool when tried.
    const poolArgs = ['status', '--leased-only', '--json'];
    if (typeof flags.repo === 'string') poolArgs.push(`--repo=${flags.repo}`);
    if (typeof flags.name === 'string') poolArgs.push(`--name=${flags.name}`);
    poolStatus = await runJson('node', [LANE_POOL_CLI, ...poolArgs], { errors, label: 'lane-pool status' });
    // `--no-track-attempts` keeps this a PURE read (no breach-counter sidecar writes) — a state read must not mutate.
    const scopeArgs = ['--json', '--no-track-attempts'];
    if (typeof flags.repo === 'string') scopeArgs.push(`--repo=${flags.repo}`);
    if (typeof flags.name === 'string') scopeArgs.push(`--name=${flags.name}`);
    scopePicture = await runJson('node', [SCOPE_COLLECT_CLI, ...scopeArgs], { errors, label: 'scope-lease-collect' });
  }

  // 3. In-flight lane PRs (this repo's open PRs).
  let prList;
  try {
    // `comments` (#3296) is read so `shapePrs` can derive `stoodDown` — the durable stand-down marker lives on
    // the PR's own comment thread, and this is the tick's only PR read, so it must carry the field or `shapePrs`
    // has nothing to scan.
    const prArgs = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,state,statusCheckRollup,labels,headRefName,mergeStateStatus,comments'];
    if (typeof flags.repo === 'string') prArgs.push(`--repo=${flags.repo}`);
    const out = await runBounded('gh', prArgs, { cwd: ROOT, timeoutMs: RUN_JSON_TIMEOUT_MS, maxBytes: 32 * 1024 * 1024 });
    prList = JSON.parse(out || '[]');
  } catch (e) {
    errors.push(`gh pr list: ${String(e.message || e).split('\n')[0]}`);
    prList = [];
  }

  // 4. Drain daemon status (cross-repo, graceful degrade to `"unavailable"`).
  let daemonReport = null;
  const daemonCli = findDaemonCli();
  if (daemonCli) {
    // The daemon is explicitly best-effort + cross-repo, so a present-but-THROWING daemon must degrade IDENTICALLY
    // to an absent one: NO `errors` sink is passed here, so a failed read returns undefined → null → shapeDaemon
    // "unavailable", and a cross-repo daemon hiccup never flips the whole tick's health verdict to warn.
    daemonReport = (await runJson('node', [daemonCli, 'status', '--json'], { cwd: dirname(daemonCli), label: 'drain-daemon status' })) ?? null;
  }
  // A null report (absent CLI OR a failed/throwing read) shapes to "unavailable" — expected degradation, never an
  // `errors[]` row (the contract: the daemon section can vanish without warning the whole tick).

  // 5. Idle-clock inputs: queued.json for last queue-add (last merge comes from the daemon report).
  const queuedState = readJsonFile(QUEUED_PATH, { queued: [] });

  // 5b. The SESSION-LOCAL conveyor queue (#2613): the ids the operator cleared for build via
  //     `scripts/conveyor/queue.mjs` (the gitignored `.conveyor/queue.json` sidecar). This — NOT committed
  //     `buildQueued` frontmatter — is what arms a conveyor build, so the tick picture's `queue.buildQueued`
  //     reflects it (see shapeQueue). Read via the SAME resolver the dispatcher uses (script-location + env
  //     override) so the reader here can never diverge from the writer. A missing/corrupt sidecar degrades to [].
  //
  //     RESOLVE-AT-READ-TIME (same fix as dispatch-plan.mjs, #4291 area): the drain JIT-numbers a cleared card
  //     the moment its WE half lands, but the sidecar keeps the pre-number hash the operator cleared it under —
  //     rewriting it through the SAME `bornAsIndexFromItems`/`resolveBornAsRefs` pair BEFORE it becomes
  //     `clearedNums` means `buildQueued` (and the idle-stop / unshaped / needs-slice / decision derivations
  //     that filter on it below) sees the card's landed NNN, not a dead hash that will never again match a
  //     build-queue row. An unresolvable hash (not yet landed, or a typo) passes through unchanged — unresolved
  //     ids still surface via `deriveClearedNotReady` exactly as before.
  const bornAsIndex = bornAsIndexFromItems(backlogItems);
  const clearedNums = resolveBornAsRefs(readQueueFile(resolveQueuePath()), bornAsIndex).map((e) => e.num);

  // 5c. The infra-blocked state (#2659): items whose build succeeded + lane ref pushed, but whose PR-open failed
  //     on an outside dependency (a GitHub outage). Read via the SAME script-location resolver pr-land writes to
  //     (env override wins) so reader and writer never diverge. A missing/corrupt sidecar degrades to [].
  const infraBlocks = readInfraStore(resolveInfraStorePath());

  // 5d. #2661 — ONLY when work is infra-blocked, poll githubstatus.com ONCE to corroborate the failure class (a
  //     live GitHub incident vs a one-off), so same-cause blocks cluster into ONE degraded-infra signal with an
  //     accurate cause. DEFENSIVE by construction: a clean tick (no infra) skips the network entirely; the poll
  //     is short-timeout + guarded, so its own failure returns `{reachable:false}`/null and NEVER cascades
  //     (correlateCause is null-safe → the store cause is used as-is). A poll must never stall or red a tick.
  let githubStatus = null;
  if (Array.isArray(infraBlocks) && infraBlocks.length) {
    try { githubStatus = await fetchGithubStatus(); } catch { githubStatus = null; }
  }

  // 6. Lane → item map + the best-effort transcript activity scan for the health verdict.
  const laneItem = laneItemMap();
  const lanesForActivity = shapeLanes({ poolStatus, scopePicture, laneItem });
  const laneActivity = collectLaneActivity(lanesForActivity, nowMs);

  const picture = assembleConveyorState({
    buildQueue,
    poolStatus,
    scopePicture,
    prList,
    daemonReport,
    queuedState,
    laneItem,
    laneActivity,
    clearedNums,
    infraBlocks,
    githubStatus,
    now: nowMs,
    errors,
  });

  // This script's whole reason to exist is the ONE JSON read, so it always emits the payload (a `--json`-less
  // human summary would just be the "eyeball four commands" this replaces). `--json` is accepted for call-site
  // symmetry with the sibling collectors but is not required.
  void flags.json;
  // #x7xv2xt — flag a picture whose lane section is a stand-in, not the real pool. Absent on a normal run.
  if (skipLanePool) picture.lanePool = 'skipped';
  // Emit the payload SYNCHRONOUSLY so it fully drains before the process exits — a plain
  // `process.stdout.write` is async to a pipe and `process.exit(0)` would drop the unflushed tail, truncating
  // this ~23 KB JSON for an `execFileSync`/pipe consumer. `writeLineSync` is remedy (b) from
  // we:scripts/lib/write-all-sync.mjs and appends the trailing newline. The drain loop used to be a local copy
  // here (one of three identical ones); #3061 moved it to the shared home with behaviour unchanged.
  writeLineSync(1, JSON.stringify(picture, null, 2));
  process.exit(0);
}

// Main-module detection — run the IO shell only when invoked directly, never on import (keeps the pure core
// importable by the test with zero side effects).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`conveyor-state: ${String(e?.message || e)}\n`);
    process.exit(1);
  });
}
