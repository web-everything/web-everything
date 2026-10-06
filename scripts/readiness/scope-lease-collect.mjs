#!/usr/bin/env node
/**
 * @file scripts/readiness/scope-lease-collect.mjs
 * @description LIVE scope-lease snapshot COLLECTOR (WE epic #2560 — the IO BOUNDARY for the pure observer).
 *   The pure, read-only observer {@link ./scope-lease-live.mjs liveScopePicture} takes a plain array of lease
 *   objects and reports the live conflict picture (per-lease breach + policy outcome, pairwise overlaps). It owns
 *   NO fs/git/clock — everything is passed IN. THIS module is the missing other half: it walks the live lane
 *   pool, reads each HELD lease and its git diff, and assembles exactly that `leases` array, then composes the
 *   observer. It NEVER re-implements breach / overlap / policy — it collects, then hands off.
 *
 * PURE-CORE / IO-SHELL SPLIT (the hard design constraint, mirrored from the observer):
 *   • The PURE core ({@link qualifyPaths}, {@link parseObservedFiles}, {@link resolvePredictedScope},
 *     {@link collectSnapshot}) has NO fs, git, `Date`, or `child_process` — every dependency is INJECTED. It is
 *     unit-tested directly by feeding it raw strings / fake pool objects / fake collector fns.
 *   • The IO SHELL (the `main()` CLI, gated on `import.meta.url === pathToFileURL(process.argv[1]).href`) owns
 *     the git/child_process reads: it runs `lane-pool status --json`, and per lane runs `git remote get-url`,
 *     `git merge-base`, `git diff --name-only`, `git status --porcelain`. It provides those as the injected
 *     functions the pure core orchestrates over.
 *
 * PREDICTED SCOPE SOURCE + the predicted = observed DEFAULT — the central design call of #2560's collector:
 *   The observer keys breach detection on PREDICTED (planned) file-scope vs OBSERVED (live diff) scope. As of
 *   #2560's final slice there IS a live producer: a lane declares its predicted file-scope at acquire via
 *   `we:scripts/lane-pool.mjs acquire --scope=<repo:path,...>`, which persists it into the lease marker
 *   (`lease.predictedScope`). So {@link resolvePredictedScope} takes predicted from the marker-declared scope
 *   when present, else `--plan`, else defaults `predicted := observed`. The default still holds when nothing
 *   declared a scope (a plain acquire with no `--scope`). The effect of that default:
 *     • With NO plan, predicted ≡ observed ⇒ breachOf(predicted, observed) is empty ⇒ ZERO false breach. The
 *       observer then reports only the REAL cross-lane OVERLAPS between live leases' effective scopes — which
 *       need no plan to be meaningful (two lanes sitting on the same file is contention regardless of intent).
 *     • Breach detection turns ON only when a real per-lane plan IS supplied (via `--plan=<file>`). Then predicted
 *       is the plan and observed the live diff, and the observer's breach machinery lights up as designed.
 *   This is the conservative, correct default: surface the signal that is trustworthy now (overlap), and never
 *   fabricate a breach from the absence of a plan.
 *
 * DURABLE PER-LANE BREACH-ATTEMPT COUNTER (WE #2598 — the last slice of #2560): §3i-A4 Fork 2's total-attempt
 *   counter now has live persistence. It CANNOT live in the lease marker (that is deleted at release), so it is a
 *   per-lane SIDECAR at `<laneDir>/.git/.lane-breach-count`. An "attempt" = a distinct breach EPISODE, advanced on
 *   a breach TRANSITION (a NEW or CHANGED breach file-set), NOT per poll — the honestly-detectable retry proxy
 *   from observations alone (no orchestrator hook exists). Rules ({@link advanceBreachCount}): a stable ongoing
 *   breach stays ONE attempt (rising edge only); a CHANGED breach file-set is a new attempt (+1); a clean
 *   observation resets to 0; a new lease occupant (session changed) resets. The counter is ADVISORY (§3i-A4
 *   Fork 1 — never gates). Writes happen ONLY on a state transition, so steady-state polls stay READ-ONLY. The
 *   `--no-track-attempts` flag forces a pure read (no sidecar writes, `breachAttempt` omitted). The observer
 *   consumes `breachAttempt` in its `breachOutcome` to ESCALATE once the count exceeds `retryBound`.
 *   LIMITATION (proxy, not a literal total): a STATIC unchanged breach sits at attempt 1 forever, and a
 *   breach that drops to clean and re-appears on a DIFFERENT file resets — both diverge from §3i-A4's literal
 *   total-attempt counter. Faithful per-retry counting needs an orchestrator build-iteration signal (none yet);
 *   this is the honest edge-driven approximation until that hook exists.
 *
 * FILE-LEVEL LEASE GRANULARITY (WE #2679): the breach + overlap matchers this collector composes
 *   (`breachOf` here; `scopesOverlap`/`overlapAtLaunch` in the observer) are now GRANULARITY-AWARE. A lane that
 *   declares a NARROW file-level `predictedScope` (via `acquire --scope=we:path/to/file.mjs`) leases at FILE
 *   granularity: a sibling lane touching a DISJOINT file that merely shares the same directory no longer
 *   false-overlaps it, so both dispatch in parallel. A lane declaring a BROAD subtree (a glob, or a
 *   bare/trailing-slash directory) still leases the whole tree, so a genuinely-spanning declaration — or a real
 *   same-file dependency — still serializes. This is a pure refinement of the SAME advisory signal (§3i-A4 Fork 1
 *   — the whole-clone lease remains the only real lock); the collector's own logic is unchanged, it simply
 *   passes each lane's declared scope through at its authored granularity. Authoring `scope:` as narrowly as
 *   correctness allows is the upstream half (#2619, in the readiness flow).
 *
 * COMPOSES, NEVER REINVENTS: `normScope` (dedupe/normalize repo-qualified paths) and `porcelainFiles` (parse
 *   `git status --porcelain`, rename-aware) and `repoKeyFromSlug` (origin slug → repo key) and `liveScopePicture`
 *   (the observer itself) are all IMPORTED. This module adds only the pool-walk + git-read IO and the pure glue.
 */

import { planningRead } from '../lib/planning-snapshot.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { normScope, breachOf } from './scope-lease.mjs';
import { porcelainFiles } from './claimScope.mjs';
import { repoKeyFromSlug } from './lane-manifest.mjs';
import { liveScopePicture } from './scope-lease-live.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
// #x5n4zn3 — the shared budget policy `we:scripts/lib/bounded-child.mjs` ships (`resolveChildTimeoutMs`, env
// `WE_CHILD_TIMEOUT_MS`), reused here for its constant only. `tryGit` below is called per-lane, several times
// per lane (`repoKeyForLane` + `observedForLane`'s merge-base/rev-list×2/diff/status), from a plain `.map()`
// over every HELD lane in the pool (#x3xz8qp is concurrently adding a spawn-COUNT regression test over exactly
// this loop) — so, like `we:scripts/lane-pool.mjs`'s own git helper, this stays synchronous and reconciles via
// Node's native per-call `timeout`/`killSignal` rather than switching to the async `runBounded` primitive,
// which would force the whole per-lane collection loop to become async for the same "keep the diff to the spawn
// call sites only" coordination reason recorded there.
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

// ── PURE CORE (no fs / git / Date / child_process — every dependency is injected) ────────────────────────────

/** Prefer a tip only when it contains every candidate; divergent or unreadable history keeps the first. */
export function pickFreshestTip(candidates, isAncestor) {
  const tips = [...new Set(candidates.filter(Boolean))];
  try {
    return tips.find((tip) => tips.every((other) => other === tip || isAncestor(other, tip))) ?? tips[0] ?? null;
  } catch {
    return tips[0] ?? null;
  }
}

/**
 * Repo-qualify a list of repo-relative file paths → "<repoKey>:<path>". Skips empty/falsy entries. When
 * `repoKey` is null/empty the path passes through UNQUALIFIED (the observer's path convention tolerates an
 * unqualified path; a bare path never collides across repos it was never tagged with).
 * @param {string|null|undefined} repoKey
 * @param {string[]} files
 * @returns {string[]}
 */
export function qualifyPaths(repoKey, files) {
  const list = Array.isArray(files) ? files : [];
  const key = repoKey ? String(repoKey) : null;
  return list
    .map((f) => (f == null ? '' : String(f).trim()))
    .filter(Boolean)
    .map((f) => (key ? `${key}:${f}` : f));
}

/**
 * Is a lane's git history TRULY DIVERGED from its own `origin/<branch>` ref (both ahead AND behind, i.e. its
 * HEAD and the remote tip share a common ancestor further back than either tip, rather than one being a
 * straight-line descendant of the other)?
 *
 * WHY THIS MATTERS (live incident, 2026-09-14, #3521/lane-2): the committed-range observed-scope diff below is
 * `git diff --name-only $(git merge-base origin/main HEAD)...HEAD`. When a lane's HEAD is a clean descendant of
 * `origin/main` (behind=0, ahead≥0 — the normal "fresh reset, then some real edits" shape), that merge-base IS
 * `origin/main` (or very close to it) and the diff faithfully reports only the lane's own new work. But when a
 * lane's local branch was never hard-reset onto a current `origin/main` (both ahead>0 AND behind>0 — it carries
 * OLD commits `origin/main` no longer has, most likely already-landed work whose PR squash/rebase-merged under
 * different SHAs), the merge-base can sit far in the past. The diff from that stale point then sweeps in every
 * file that changed across the ENTIRE intervening history — hundreds of unrelated files the lane never touched
 * this session — and can spuriously overlap a totally unrelated item's declared scope (observed: lane-2 held a
 * bogus 249-file scope, including `scripts/operations/run-record.mjs`, purely because merge-base(origin/main,
 * HEAD) landed 138 commits back; #3521 declares that exact file and was held `overlaps lane-2` indefinitely,
 * even though lane-2's working tree was completely clean and nothing was actually in progress there).
 *
 * A lane in this state is NOT reporting a trustworthy committed-range diff, so the collector drops that half of
 * `observed` for it (see the IO shell) and flags it via `historyDiverged` instead of silently mis-scoping it.
 * PURE — both counts are the caller's own `git rev-list --count` reads. Either count non-finite (unknown / a
 * failed git read) reads as NOT diverged — never fabricate a flag from missing data.
 * @param {number} aheadCount   commits in HEAD not in `origin/<branch>` (`git rev-list --count origin/x..HEAD`).
 * @param {number} behindCount  commits in `origin/<branch>` not in HEAD (`git rev-list --count HEAD..origin/x`).
 * @returns {boolean}
 */
export function isDivergedHistory(aheadCount, behindCount) {
  return Number.isFinite(aheadCount) && aheadCount > 0 && Number.isFinite(behindCount) && behindCount > 0;
}

/**
 * Parse a lane's raw git outputs into its repo-qualified, deduped OBSERVED scope (the file-level live diff the
 * observer reads). Unions the committed range and the uncommitted working tree, so a lane's footprint includes
 * both what it has committed and what it is mid-edit on.
 * @param {{diffOut?:string, porcelainOut?:string, repoKey?:string|null}} input
 *   `diffOut` = raw `git diff --name-only <base>...HEAD` stdout (committed range);
 *   `porcelainOut` = raw `git status --porcelain` stdout (uncommitted; parsed rename-aware via `porcelainFiles`).
 * @returns {string[]} repo-qualified, deduped/normalized observed paths.
 */
export function parseObservedFiles({ diffOut = '', porcelainOut = '', repoKey = null } = {}) {
  const committed = String(diffOut || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // porcelainFiles returns a Set (rename `old -> new` → keeps `new`); spread to the union.
  const uncommitted = [...porcelainFiles(porcelainOut)];
  const qualified = qualifyPaths(repoKey, [...committed, ...uncommitted]);
  return normScope(qualified);
}

/**
 * The grace period (ms) an empty, unclaimed lease is spared before it counts as a finished GHOST (WE #2623). It
 * must comfortably exceed a fresh build lane's acquire→claim window — acquire writes the lease marker, THEN resets
 * + installs deps (can run a couple minutes) before the agent claims and produces its first diff — yet stay well
 * under a real build's duration, so a genuinely-finished ghost (held far longer) is still reaped promptly. Exported
 * so a test / caller can override it. 5 minutes is that middle ground.
 */
export const GHOST_GRACE_MS = 5 * 60_000;

/**
 * The backlog item numbers EVIDENCED in a lane's observed scope (WE #2623 — the ghost drop's claimed-item signal).
 * A lane's live claim shows up as a `backlog/<NNN>-*.md` change in its diff (`backlog.mjs claim` flips the item to
 * `active` + stamps `dateStarted`), so the ids among the observed paths are the items the lane is holding. Matches
 * a `backlog/<digits>` segment anywhere in a (possibly repo-qualified `we:backlog/…`) path; deduped, order-stable.
 * PURE — string parsing only, no fs/git. Returns [] for a lane with no backlog file in its observed scope.
 * @param {string[]} observed  repo-qualified observed paths.
 * @returns {string[]} the distinct backlog item numbers (as strings), in first-seen order.
 */
export function backlogItemsFromObserved(observed) {
  const list = Array.isArray(observed) ? observed : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const m = String(p == null ? '' : p).match(/(?:^|[:/])backlog\/(\d+)/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Resolve a lane's PREDICTED scope. PRIORITY (#2560 final slice): marker-`declared` (the lane's own
 * `acquire --scope=` file-scope, persisted in its lease marker — the REAL predicted-scope producer #2596 noted
 * was missing) → `--plan` → observed. With a non-empty `declared`, predicted is that normalized declared scope
 * (breach detection is ON, keyed on what the lane itself promised). Else with a non-empty `plan`, predicted is
 * the normalized plan. Else predicted := observed unchanged (predicted ≡ observed ⇒ zero false breach — the
 * observer then reports only real cross-lane overlaps). The default still holds when nothing declared a scope.
 * @param {{observed:string[], plan?:string[]|null, declared?:string[]|null}} input
 * @returns {string[]}
 */
export function resolvePredictedScope({ observed, plan, declared } = {}) {
  if (Array.isArray(declared) && declared.length > 0) return normScope(declared);
  const obs = Array.isArray(observed) ? observed : [];
  if (Array.isArray(plan) && plan.length > 0) return normScope(plan);
  return [...obs]; // a fresh array — predicted and observed must not alias (no in-place mutation footgun)
}

/**
 * A stable, order-INDEPENDENT signature of a breach file-set (WE #2598). Two observations of the SAME breach
 * files in a different order produce the SAME signature, so a mere reorder is NOT read as a changed episode. An
 * empty / na breach signs to `''` (the "clean" sentinel {@link advanceBreachCount} treats as no breach).
 * @param {string[]} breach  a breach file array (repo-qualified).
 * @returns {string} the sorted, newline-joined normalized set (`''` when empty).
 */
export function breachSig(breach) {
  return [...normScope(breach)].sort().join('\n');
}

/**
 * Advance the durable per-lane breach-attempt counter by ONE observation (WE #2598, §3i-A4 Fork 2). PURE — the
 * IO shell reads `prev` from the sidecar, calls this, and writes `next` back only when it changed.
 *
 * SEMANTICS — an "attempt" = a distinct breach EPISODE, advanced on a breach TRANSITION (the rising edge of a new
 * or CHANGED breach set), NOT per poll:
 *   • A stable ongoing breach (same file-set) stays ONE attempt — `attempts`/`sig` unchanged.
 *   • A NEW or CHANGED breach set (signature differs from prev) is a new attempt → `attempts + 1`.
 *   • A CLEAN observation (empty breach) resets → `attempts: 0`, `sig: ''`.
 *   • A NEW lease occupant (session changed vs prev.session, both non-null) resets prev to fresh first — the
 *     previous holder's episode does not carry into a different session.
 * ADVISORY (§3i-A4 Fork 1) — this count never gates; the observer consumes it to escalate past `retryBound`.
 *
 * @param {{attempts?:number, sig?:string, session?:string|null}|null|undefined} prev  the prior sidecar state.
 * @param {string[]} breach  this observation's breach file-set (repo-qualified).
 * @param {string|null} [session]  the current lease occupant's session (drives the new-occupant reset).
 * @returns {{attempts:number, sig:string, session:(string|null)}} the next sidecar state.
 */
export function advanceBreachCount(prev, breach, session = null) {
  // Normalize prev → a well-formed state (attempts a non-negative integer, sig a string, session a value|null).
  let base =
    prev && typeof prev === 'object'
      ? {
          attempts: Number.isInteger(prev.attempts) && prev.attempts >= 0 ? prev.attempts : 0,
          sig: typeof prev.sig === 'string' ? prev.sig : '',
          session: prev.session ?? null,
        }
      : { attempts: 0, sig: '', session: null };

  // New-occupant reset: a different session than the one the prior state was recorded under starts fresh.
  if (session != null && base.session != null && session !== base.session) {
    base = { attempts: 0, sig: '', session: null };
  }

  const carrySession = session ?? base.session ?? null;
  const sig = breachSig(breach);

  if (sig === '') {
    // Clean observation → reset the episode.
    return { attempts: 0, sig: '', session: carrySession };
  }
  if (sig !== base.sig) {
    // New or changed breach set → a new episode (rising edge).
    return { attempts: base.attempts + 1, sig, session: carrySession };
  }
  // Same breach persists → hold the attempt (no rising edge).
  return { attempts: base.attempts, sig: base.sig, session: carrySession };
}

/**
 * Assemble the observer's `leases` array from a `lane-pool status --json` object, over INJECTED collector fns.
 * PURE orchestration — no git/fs of its own; the shell supplies the reads.
 *
 * @param {{
 *   poolStatus: {lanes?: Array<object>},
 *   observedForLane: (lane:object) => string[],   // already-repo-qualified observed scope for a lane
 *   planForLane?: ((lane:object) => string[]|null) | null,  // optional per-lane predicted plan
 *   breachAttemptForLane?: ((lease:object) => number) | null,  // optional per-lease breach-attempt counter
 *   itemsForLane?: ((lane:object) => Array<string|number>|null) | null,  // optional per-lane claimed backlog items
 * }} input
 *   The IO shell repo-qualifies each lane's paths inside `observedForLane`, so the pure shape needs no separate
 *   repo key — observed scope arrives already qualified, exactly as the observer expects.
 * @returns {Array<{lane, session, predictedScope:string[], observedScope:string[], breachAttempt?:number}>}
 *   The observer's lease-input shape. `breachAttempt` is stamped ONLY when `breachAttemptForLane` is supplied AND
 *   returns an integer ≥ 1 (WE #2598); when the param is absent it is OMITTED and the observer defaults it to 1
 *   ("first observation ⇒ retry-in-place") — exact back-compat with the pre-#2598 collector.
 *
 * PREDICTED SCOPE SOURCE (#2560 final slice): each lease's `predictedScope` now flows from the lane's OWN lease
 * marker (`lane.lease.predictedScope`, declared at acquire via `we:scripts/lane-pool.mjs acquire --scope=`) when
 * present — the real predicted-scope producer the collector previously lacked. It takes priority over `--plan`,
 * which takes priority over observed (see {@link resolvePredictedScope}).
 *
 * EMPTY/STALE (GHOST) LEASE DROP (WE #2623): a lane whose agent has FINISHED but never released still holds a live
 * lease marker, yet holds NO observed scope (no diff / no `git status` change) AND no claimed backlog item. Such a
 * ghost contributes nothing real, but its STALE marker-declared `predictedScope` (from `acquire --scope=`) would
 * otherwise flow into the observer's effective scope (predicted ∪ observed) and the dispatcher's overlap gate,
 * FALSELY blocking a new item's dispatch (`overlaps lane-N` against a dead lane) and inflating the board's active
 * count. So an empty/stale lease is DROPPED here at the collector — the single source every consumer (observer,
 * dispatcher, board) reads, so they all see the same de-ghosted set. This mirrors the serial-floor-era rule that
 * an empty lease must not block dispatch, applied to the COUNT as well as the gate.
 *
 * A lease is a GHOST when ALL THREE hold: (1) EMPTY observed scope, (2) NO claimed item, (3) held PAST a short
 * grace ({@link GHOST_GRACE_MS}). All three are INJECTED so the pure core stays clock/fs-free:
 *   • `itemsForLane(lane)` → the lane's claimed backlog items. TODAY the IO shell derives this from the lane's diff
 *     (a live claim shows as a `backlog/<NNN>-*.md` change), so it moves in lockstep with observed — it is not yet
 *     an INDEPENDENT signal (no authoritative item source exists: `.claude/lane-ports.json` is empty and the lease
 *     marker carries no item). The param is the seam a future authoritative source (marker-declared item / merged-PR
 *     state) plugs into to make axis (2) independently meaningful; the pure contract already honors it.
 *   • `leaseAgeMsForLane(lane)` → ms since the lease was acquired (shell: now − marker `acquiredAt`). This is the
 *     axis that ACTUALLY separates a finished ghost from a just-acquired reservation TODAY: a fresh build lane sits
 *     EMPTY only during its brief acquire→claim window (seconds to a couple minutes of provisioning), whereas a
 *     finished ghost has been held far longer (it ran a whole build). Without the grace, dropping every empty lease
 *     would reap a fresh reservation and let a scope-overlapping rival launch — the exact conflict the lease exists
 *     to prevent. An UNKNOWN age (null / unparseable `acquiredAt`) is treated as "still fresh" → NOT dropped (never
 *     reap a lease we cannot age).
 * The drop is GATED on `itemsForLane` being injected: with NO `itemsForLane` the collector KEEPS every leased lane
 * — exact back-compat with the pre-#2623 collector. Predicted scope is deliberately NOT part of the ghost test: a
 * ghost's whole harm IS its leftover predicted scope, so keying the drop on predicted would never fire.
 *
 * BREACH-ATTEMPT COUNTER (WE #2598): `breachAttemptForLane(lease)` is the INJECTED counter — the IO shell's fn
 * reads/advances/writes the per-lane sidecar and returns the current attempt count for the just-built lease. Kept
 * OUT of the pure core (it does fs) — this pure fn only stamps the integer it returns onto `lease.breachAttempt`.
 */
export function collectSnapshot({ poolStatus, observedForLane, planForLane = null, breachAttemptForLane = null, itemsForLane = null, leaseAgeMsForLane = null, divergedForLane = null } = {}) {
  const lanes = Array.isArray(poolStatus?.lanes) ? poolStatus.lanes : [];
  // Keep only LIVE-held lanes — `leased === true` marks an active work stream (a stale marker reads as free).
  const held = lanes.filter((l) => l && typeof l === 'object' && l.leased === true);
  const itemAware = typeof itemsForLane === 'function';
  const ageOf = typeof leaseAgeMsForLane === 'function' ? leaseAgeMsForLane : null;
  const leases = [];
  for (const lane of held) {
    const observed = normScope(observedForLane(lane));
    // WE #2623 — DROP an empty/stale ghost lease (see the header): item-aware, EMPTY observed, NO claimed item, and
    // held PAST the grace. Gated on item-awareness so a plain (pre-#2623) call keeps every leased lane.
    if (itemAware && observed.length === 0) {
      // The lane's claimed backlog items (evidence it is a REAL work stream). Never emitted on the lease.
      const rawItems = itemsForLane(lane);
      const claimedItems = Array.isArray(rawItems)
        ? rawItems.filter((x) => x != null && String(x).trim() !== '')
        : [];
      const ageMs = ageOf ? ageOf(lane) : null;
      // Past the grace only when age is KNOWN and ≥ threshold; an unknown age reads as "still fresh" (kept).
      const pastGrace = Number.isFinite(ageMs) && ageMs >= GHOST_GRACE_MS;
      if (claimedItems.length === 0 && pastGrace) continue; // reap the ghost
    }
    const plan = typeof planForLane === 'function' ? planForLane(lane) : null;
    const lease = {
      lane: lane.lane,
      session: lane.lease?.session ?? null,
      // #2560 — marker-declared scope (from `acquire --scope=`) wins over --plan wins over observed.
      predictedScope: resolvePredictedScope({ observed, plan, declared: lane.lease?.predictedScope }),
      observedScope: observed,
    };
    // WE #2598 — stamp the durable breach-attempt count when the injected counter yields a valid one (≥ 1).
    if (typeof breachAttemptForLane === 'function') {
      const a = breachAttemptForLane(lease);
      if (Number.isInteger(a) && a >= 1) lease.breachAttempt = a;
    }
    // 2026-09-14 (#3521/lane-2 incident) — stamp `historyDiverged` when the injected check says so, so a
    // consumer (the dispatch-plan overlap gate, telemetry, a human) can tell "this lease's scope came from a
    // desynced git history" apart from a real overlap. Omitted (not `false`) when no checker is injected —
    // exact back-compat with callers that don't wire one.
    if (typeof divergedForLane === 'function' && divergedForLane(lane)) lease.historyDiverged = true;
    leases.push(lease);
  }
  return leases;
}

// ── IO SHELL (runs only as a CLI — owns all git / child_process / fs) ────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_POOL_CLI = join(HERE, '..', 'lane-pool.mjs');

// stdout = machine payload ONLY; ALL logs / human text → stderr (lane-pool discipline).
const log = (m) => process.stderr.write(m + '\n');
function fail(m) {
  process.stderr.write(`✗ ${m}\n`);
  process.exit(1);
}

/** Hand-rolled `--k=v` flag parsing (lane-pool style). */
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

/**
 * Run a git command in `cwd`, returning its stdout with only TRAILING whitespace stripped, or null on any
 * failure (never throws). `trimEnd`, never `trim` — a blanket `.trim()` ate the leading status-code space
 * `git status --porcelain` puts on an unstaged-only line (`" M path"`, X=' ' Y='M'), which is significant
 * fixed-column data, not incidental whitespace: {@link porcelainFiles} in `./claimScope.mjs` reads the
 * status columns as `line.slice(3)`, so losing that one leading char shifted every field on the FIRST
 * porcelain line by one column and silently chopped the first character off that file's path (`backlog/…`
 * read as `acklog/…`) — corrupting the observed scope for every lane whose first uncommitted change was
 * unstaged-only, and manufacturing false scope-lease breaches from it (live incident, 2026-09-04).
 */
function tryGit(args, cwd) {
  try {
    // #x5n4zn3 — was bare (no timeout at all): a stuck `git` (typically its network transport, under
    // `remote get-url`'s config read this is unlikely, but `merge-base`/`diff`/`status` all still shell a real
    // process) could hang this ONE lane's read forever, and every caller here treats a `tryGit` failure as
    // "contributes [] observed, log and move on" — so failing fast on a timeout is strictly an improvement, never
    // a new failure mode.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' }).trimEnd();
  } catch {
    return null;
  }
}

// ── WE #2598 — the durable per-lane breach-attempt sidecar (IO: read/write `<laneDir>/.git/.lane-breach-count`) ─

/** The per-lane sidecar path — under `.git/` so it never shows in the lane's diff / porcelain (never observed). */
const breachCountPath = (laneDir) => join(laneDir, '.git', '.lane-breach-count');

/** Read a lane's breach-count sidecar → its state, or the fresh default on any error (missing/corrupt/unreadable). */
function readBreachCount(laneDir) {
  try {
    const obj = JSON.parse(readFileSync(breachCountPath(laneDir), 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    /* missing or corrupt sidecar → fresh default below */
  }
  return { attempts: 0, sig: '', session: null };
}

/** Write a lane's breach-count sidecar (2-space JSON). GUARDED — a write failure logs and is swallowed, never
 *  throws: the advisory counter must never break a read-only collection run (§3i-A4 Fork 1). */
function writeBreachCount(laneDir, state) {
  try {
    writeFileSync(breachCountPath(laneDir), JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    log(`  ⚠ lane sidecar write failed (${breachCountPath(laneDir)}): ${String(e.message || e).split('\n')[0]}`);
  }
}

/** Parse `--policy=<file-or-inline-json>` → an object, or null. A parse failure fails loud. */
function parsePolicyFlag(value) {
  if (value == null || value === true || value === '') return null;
  const raw = String(value);
  let text = raw;
  try {
    // Prefer a file path; fall back to treating the value as inline JSON.
    text = readFileSync(raw, 'utf8');
  } catch {
    text = raw;
  }
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    fail(`--policy is neither a readable JSON file nor inline JSON: ${String(e.message || e).split('\n')[0]}`);
  }
}

/** Parse `--plan=<file>` → a `{ "<laneId>": ["<repo>:<path>", …] }` map, or null. A read/parse failure fails loud. */
function parsePlanFlag(value) {
  if (value == null || value === true || value === '') return null;
  let text;
  try {
    text = readFileSync(String(value), 'utf8');
  } catch (e) {
    fail(`--plan=${value} is not readable: ${String(e.message || e).split('\n')[0]}`);
  }
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('--plan must be a JSON object mapping laneId → string[]');
    return obj;
  } catch (e) {
    fail(`--plan=${value} is not valid JSON: ${String(e.message || e).split('\n')[0]}`);
  }
}

/** Run `lane-pool.mjs status --leased-only --json` (passing through the repo/name selector) and parse the
 *  payload. #4345 — `collectSnapshot` below only ever consumes LEASED rows (`l.leased === true`, filtered
 *  before any other field is read), so `--leased-only` is a pure win here: the git probe (rev-parse ×2,
 *  `status --porcelain`, rev-list) is skipped for every lane this collector was going to discard anyway. */
function readPoolStatus(flags) {
  const args = [LANE_POOL_CLI, 'status', '--leased-only', '--json'];
  if (typeof flags.repo === 'string') args.push(`--repo=${flags.repo}`);
  if (typeof flags.name === 'string') args.push(`--name=${flags.name}`);
  return planningRead(args, () => {
    let out;
    try {
      // #x5n4zn3 — generous (a full pool `status` walks every lane, itself now individually git-timeout-bounded
      // by `we:scripts/lane-pool.mjs`'s own #x5n4zn3 fix), but never unbounded.
      out = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs() * 4, killSignal: 'SIGKILL' });
    } catch (e) {
      fail(`lane-pool status failed: ${String(e.message || e).split('\n')[0]}`);
    }
    try {
      return JSON.parse(out);
    } catch (e) {
      fail(`could not parse lane-pool status JSON: ${String(e.message || e).split('\n')[0]}`);
    }
  });
}

/** The IO shell: collect the live snapshot, compose the observer, emit the picture. */
function main(argv) {
  const flags = parseFlags(argv);
  const policy = parsePolicyFlag(flags.policy);
  const planMap = parsePlanFlag(flags.plan);

  const poolStatus = readPoolStatus(flags);

  const upstreamCache = new Map();
  const upstreamAt = (path, gitDir = false) => {
    if (!upstreamCache.has(path)) {
      upstreamCache.set(path, tryGit([...(gitDir ? [`--git-dir=${path}`] : []), 'rev-parse', 'origin/main'], gitDir ? process.cwd() : path));
    }
    return upstreamCache.get(path);
  };
  const cwdTip = upstreamAt(process.cwd());
  const upstreamForLane = (path) => {
    const candidates = [upstreamAt(path), cwdTip];
    try {
      const objects = readFileSync(join(path, '.git/objects/info/alternates'), 'utf8').split('\n')[0].trim();
      if (objects) candidates.push(upstreamAt(dirname(objects), true));
    } catch { /* No readable alternates owner. */ }
    const available = [...new Set(candidates.filter(Boolean))]
      .filter((sha) => tryGit(['cat-file', '-e', `${sha}^{commit}`], path) !== null);
    return pickFreshestTip(available, (a, b) => tryGit(['merge-base', '--is-ancestor', a, b], path) !== null) || 'origin/main';
  };

  // Injected real collector fns (own all git IO; every git call is guarded — a lane whose git fails
  // contributes [] observed and is logged, never crashing the whole run).
  const repoKeyCache = new Map();
  const repoKeyForLane = (lane) => {
    const path = lane?.path;
    if (!path) return null;
    if (repoKeyCache.has(path)) return repoKeyCache.get(path);
    const slug = tryGit(['remote', 'get-url', 'origin'], path);
    const key = slug ? repoKeyFromSlug(slug) : null;
    repoKeyCache.set(path, key);
    return key;
  };

  // MEMOIZED (per lane path) so the git-heavy read runs ONCE per lane per tick even though both `collectSnapshot`
  // and the `itemsForLane` derivation below consult it — avoids doubling the merge-base/diff/status subprocesses
  // and pins both consumers to the SAME observation (no read-at-two-instants skew).
  const observedCache = new Map();
  // 2026-09-14 (#3521/lane-2) — parallel cache of the divergence verdict, keyed the SAME way as `observedCache`
  // so `observedForLane` and `divergedForLane` agree on the same git read (never a read-at-two-instants skew).
  const divergedCache = new Map();
  const observedForLane = (lane) => {
    const path = lane?.path;
    if (!path) return [];
    if (observedCache.has(path)) return observedCache.get(path);
    let observed;
    try {
      const repoKey = repoKeyForLane(lane);
      // 2026-10-06, lane-19 / PR #4072: a stale lane ref read merged work as live → false `overlaps lane-19`.
      // The DIFF BASE uses the freshest upstream tip the lane can see, so commits already on main drop out.
      const upstream = upstreamForLane(path);
      const base = tryGit(['merge-base', upstream, 'HEAD'], path) || upstream;
      // #3521/lane-2 GUARD: a lane whose HEAD is BOTH ahead of AND behind its OWN `origin/main` never got a
      // clean reset onto current upstream — its merge-base can sit far in the past, so the committed-range diff
      // below would sweep in the entire intervening history (see {@link isDivergedHistory}'s header for the
      // live incident this reproduces). Detect it BEFORE trusting that diff. Measured against the lane's own
      // ref, never the fresh tip: every live lane is "behind" a tip that moved on, and reading that as diverged
      // would drop its real committed scope from the overlap picture.
      const aheadCount = Number.parseInt(tryGit(['rev-list', '--count', 'origin/main..HEAD'], path) ?? '', 10);
      const behindCount = Number.parseInt(tryGit(['rev-list', '--count', 'HEAD..origin/main'], path) ?? '', 10);
      const diverged = isDivergedHistory(aheadCount, behindCount);
      divergedCache.set(path, diverged);
      // Diverged ⇒ the committed-range diff is untrustworthy; fall back to the uncommitted working tree only
      // (still a real, reliable live-work signal regardless of the lane's history health).
      const diffOut = diverged ? '' : tryGit(['diff', '--name-only', '--end-of-options', `${base}...HEAD`], path) || '';
      const porcelainOut = tryGit(['status', '--porcelain'], path) || '';
      if (diverged) {
        log(
          `  ⚠ lane-${lane?.lane ?? '?'}: history diverged from origin/main (${aheadCount} ahead / ${behindCount} behind) — ` +
            `dropping the committed-range diff from observed scope (working-tree diff only)`,
        );
      }
      observed = parseObservedFiles({ diffOut, porcelainOut, repoKey });
    } catch (e) {
      log(`  ⚠ lane-${lane?.lane ?? '?'}: git read failed (${String(e.message || e).split('\n')[0]}) — treating observed scope as empty`);
      observed = [];
      divergedCache.set(path, false);
    }
    observedCache.set(path, observed);
    return observed;
  };
  const divergedForLane = (lane) => {
    const path = lane?.path;
    if (!path) return false;
    if (!divergedCache.has(path)) observedForLane(lane); // populate both caches together
    return divergedCache.get(path) === true;
  };

  const planForLane = planMap
    ? (lane) => {
        const p = planMap[String(lane?.lane)];
        return Array.isArray(p) ? p : null;
      }
    : null;

  // WE #2623 — the injected CLAIMED-ITEM signal for the empty/stale ghost drop. A lane's live claim is EVIDENCED
  // by its backlog file appearing in the observed diff: `backlog.mjs claim` flips the item to `active`+stamps
  // `dateStarted` in the lane clone, and that `backlog/<NNN>-*.md` change stays in the diff until the PR merges;
  // once merged the item is resolved and the file drops out — exactly the finished-ghost state. So the item ids a
  // lane holds = the backlog numbers among its observed paths. This needs no populated lane-ports registry (it is
  // `{}` today) nor a marker item field (there is none) — it reads the diff the collector already has. A future
  // authoritative item source (marker-declared item, or a populated registry) can supersede this fn unchanged.
  const itemsForLane = (lane) => backlogItemsFromObserved(observedForLane(lane));

  // WE #2623 — the injected LEASE-AGE signal (ms since acquire) for the ghost drop's grace gate. The lease marker
  // stamps `acquiredAt` (ISO) at acquire; age = now − acquiredAt. A missing / unparseable stamp → null (the pure
  // core reads that as "still fresh" and keeps the lease — never reap a lease we cannot age). `now` is read ONCE
  // here (IO) so the whole tick ages every lane against the same clock.
  const nowMs = Date.now();
  const leaseAgeMsForLane = (lane) => {
    const at = lane?.lease?.acquiredAt;
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? nowMs - t : null;
  };

  // WE #2598 — the durable per-lane breach-attempt counter. lane id → lane clone dir (for the sidecar path).
  const pathByLane = new Map(
    (Array.isArray(poolStatus?.lanes) ? poolStatus.lanes : [])
      .filter((l) => l && typeof l === 'object')
      .map((l) => [l.lane, l.path]),
  );
  // Injected counter: reads the sidecar, advances it on a breach TRANSITION, writes back ONLY when it changed
  // (steady-state polls stay read-only), and returns the current attempt count for the built lease.
  const breachAttemptForLane = (lease) => {
    const laneDir = pathByLane.get(lease.lane);
    if (!laneDir) return 0;
    // Both scopes are already normalized in the lease; breachOf yields this observation's breach file-set.
    const breach = breachOf(lease.predictedScope, lease.observedScope);
    const prev = readBreachCount(laneDir);
    const next = advanceBreachCount(prev, breach, lease.session);
    if (JSON.stringify(next) !== JSON.stringify(prev)) writeBreachCount(laneDir, next);
    return next.attempts;
  };
  // `--no-track-attempts` forces a PURE read: no sidecar writes, no breachAttempt stamped.
  const trackAttempts = !flags['no-track-attempts'];

  const leases = collectSnapshot({
    poolStatus,
    observedForLane,
    planForLane,
    breachAttemptForLane: trackAttempts ? breachAttemptForLane : null,
    itemsForLane,
    leaseAgeMsForLane,
    divergedForLane,
  });
  const picture = liveScopePicture({ leases, policy });

  if (flags.json) {
    writeAllSync(1, JSON.stringify(picture, null, 2) + '\n');
  } else {
    const overlaps = picture.overlaps.length;
    log(
      `live scope: ${picture.leases.length} live lease(s) · ` +
        `breachedLanes ${picture.breachedLanes.length ? picture.breachedLanes.join(', ') : 'none'} · ` +
        `overlaps ${overlaps} · clean ${picture.clean ? 'y' : 'n'}`,
    );
  }
  process.exit(0);
}

// Main-module detection — run the IO shell only when invoked directly, never on import (keeps the pure core
// importable by the test with zero side effects).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
