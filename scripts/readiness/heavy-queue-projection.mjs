/**
 * @file scripts/readiness/heavy-queue-projection.mjs
 * @description Card xkyw1x4 (epic #4075, under #3383) — ADMISSION BY PROJECTED QUEUE TIME + A FAST LANE. The PURE
 *   half: every constant, classifier and formula the heavy-command queue projection needs, with no fs, env or
 *   clock of its own. `we:scripts/readiness/heavy-admission.mjs` does the reads (held slots, waiting markers, lane
 *   leases, the hold-duration log) and re-exports everything here; `we:scripts/conveyor/tick-core.mjs#planTick`
 *   and the fix / ci-heal daemon dispatch (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`,
 *   `we:scripts/operations/ci-heal-pr-dispatch.mjs`) import only this file, so the tick's pure core never pulls in
 *   the admission module's IO dependencies.
 *
 * THE PROBLEM. #4076's load gate holds new sessions when the CPU is already hot, and #2692 made the heavy-command
 * slots first-come-first-served. Neither looks AHEAD: a burst of dispatches all start while the queue is still
 * short, each arrives at the slots 3-6 minutes later, and the queue is suddenly an hour long. A fixer's 1-minute
 * check then waits behind 25-minute full suites.
 *
 * THE DESIGN (operator-approved 2026-09-25):
 *   1. STANDARD TIME per heavy-command KIND ({@link HEAVY_KINDS}) — a seed ({@link DEFAULT_STANDARD_MINUTES}),
 *      replaced by the rolling median of real hold durations once there are enough samples ({@link typicalMinutes}).
 *   2. EXPECTED DEMAND per DISPATCH kind ({@link dispatchDemandMinutes}): review is EXEMPT; the prepare family is
 *      charged its rolling measured per-session demand, seeded with one selected run + one check:standards.
 *      `WE_QUEUE_ADMISSION_PREPARE=exempt` restores the old exemption. Fix and ci-heal cost that same seed unit;
 *      a build costs the unit times a count scaled by the card's `size`.
 *   3. PROJECTED WAIT, per queue lane ({@link laneProjection}). The backlog (remaining time on held slots +
 *      standard time of every live waiter + expected demand of sessions dispatched but not yet queued + the new
 *      dispatch) is split by kind: FULL-suite / other demand ÷ the HEAVY slots; short-job demand ÷ (the fast slots
 *      + whatever heavy slots no heavy job holds or waits for). A dispatch's own demand is short (selected runs +
 *      check:standards), so it is ADMITTED only while the short-lane wait stays ≤
 *      {@link DEFAULT_QUEUE_MAX_WAIT_MINUTES} ({@link createQueueBudget}).
 *   4. FAST LANE (operator decision on PR #2707): the fast slots are ADDED ON TOP of the cap, never carved out of
 *      it. `WE_HEAVY_ADMISSION_CAP` (default 2) is the number of HEAVY slots — full suites and anything else — and
 *      `WE_HEAVY_ADMISSION_FAST_SLOTS` (default 1) more slots exist only for the short kinds
 *      ({@link FAST_LANE_KINDS}). Default 2 heavy + 1 fast; the weekend cap of 3 gives 3 + 1. A short job tries the
 *      fast slot first and may also take any free heavy slot; a full suite never takes a fast slot. Short jobs
 *      rank first-come-first-served among themselves, never behind a full-suite waiter
 *      ({@link resolveFastSlots}, {@link slotOrderFor}).
 */

/** Every heavy-command kind the queue distinguishes. Same vocabulary `we:scripts/operations/heavy-queue.mjs`
 *  already reported (`FULL` is the whole unit suite; `selected` a verify-lane diff-driven run; `files` a bare
 *  `vitest related`; `standards` check:standards alone; `other` anything else routed through the pool). */
export const HEAVY_KINDS = Object.freeze(['selected', 'FULL', 'standards', 'files', 'verify', 'soak', 'coverage', 'build', 'agent', 'other']);

/** Item 100 — `other` held 60% of heavy minutes because it was the bucket for every command the classifier did not
 *  name. These kinds split it: `verify` (a verify-lane gate phase — the gate decides selected/FULL inside the
 *  process, and its larger vitest phase and unscoped standards phase used to land in `other`), `soak` (the
 *  conveyor soak shards), `coverage` (`test:coverage`), `build` (npm ci / install / build / tsc),
 *  `agent` (a delegated codex / gemini task). `other` is now only a truly unknown command, and the command is
 *  recorded beside it (`command` on the slot meta + durations log). All ride the slow lane, as `other` did. */

/** Seed standard hold times in MINUTES, measured 2026-09-25 under real load: a selected run took ~1-5 min, a
 *  full suite ~10-25 min, check:standards ~12-16 s of CPU. `files` (a bare `vitest related`) is the vitest half
 *  of `selected`; `other` (npm ci, a build, …) is a neutral middle guess. Replaced per kind by the rolling median
 *  of real holds once {@link TYPICAL_MIN_SAMPLES} exist. */
export const DEFAULT_STANDARD_MINUTES = Object.freeze({
  selected: 3,
  FULL: 18,
  standards: 0.25,
  files: 1.5,
  verify: 5,
  soak: 10,
  coverage: 18,
  build: 5,
  agent: 5,
  other: 5,
});

/** The kinds that ride the FAST LANE — short jobs a fixer or a builder runs between edits. */
export const FAST_LANE_KINDS = Object.freeze(['selected', 'files', 'standards']);

/** How many of the most recent holds of a kind the rolling typical value looks at. */
export const TYPICAL_WINDOW = 20;
/** Fewer real samples than this and the seed is used instead (one odd run must not become the standard). */
export const TYPICAL_MIN_SAMPLES = 3;

/** Admit a new dispatch only while the projected wait stays at or under this many minutes. Overridable via
 *  `WE_QUEUE_ADMISSION_MAX_WAIT_MINUTES`; `WE_QUEUE_ADMISSION=off` disables the gate. */
export const DEFAULT_QUEUE_MAX_WAIT_MINUTES = 30;
export const QUEUE_MAX_WAIT_ENV = 'WE_QUEUE_ADMISSION_MAX_WAIT_MINUTES';
export const QUEUE_ADMISSION_SWITCH_ENV = 'WE_QUEUE_ADMISSION';

/** A dispatched session reaches the slots ~3-6 min after it starts. Until then its demand is counted as PENDING
 *  from its lane lease; after this window it is assumed to have arrived (or to be doing something else). */
export const DEFAULT_ARRIVAL_WINDOW_MINUTES = 10;

/** Review runs no heavy command; the prepare family is charged (operator decision 2026-10-06). */
export const EXEMPT_DISPATCH_KINDS = Object.freeze(['review']);
export const PREPARE_DISPATCH_KINDS = Object.freeze(['prepare', 'prepare-scope', 'prepare-decision', 'prepare-item', 'investigate']);
export const PREPARE_ADMISSION_ENV = 'WE_QUEUE_ADMISSION_PREPARE';

/** Charge prepares by default; only an explicit `exempt` restores the exemption. */
export function resolvePrepareAdmission(env = {}) {
  return /^exempt$/i.test(env?.[PREPARE_ADMISSION_ENV]) ? 'exempt' : 'charge';
}

/** A build with no declared size is costed as this size. */
export const DEFAULT_BUILD_SIZE = 3;
/** A build runs about one fix-sized check per this many size points (min 1, max {@link MAX_BUILD_RUNS}). */
export const BUILD_SIZE_POINTS_PER_RUN = 2;
export const MAX_BUILD_RUNS = 5;

/** Fast-lane slots added on top of the heavy cap when the operator sets nothing. */
export const DEFAULT_FAST_SLOTS = 1;
export const FAST_SLOTS_ENV = 'WE_HEAVY_ADMISSION_FAST_SLOTS';

const BOOLEAN_VITEST_FLAGS = new Set(['--run', '--passWithNoTests', '--silent']);
/**
 * #5128 — over every `vitest run` segment (split on `&&`, `||`, `;`, `|`, newline) of `cmd`: `null` when there is none,
 * else whether EACH one names an explicit test file (the verify gate's bounded related list). A bare or flag-only
 * `vitest run` is the whole suite. A flag's value (`--config x.ts`, `-c x.mjs`, `--reporter=./r.mjs`) is never a target:
 * a token counts only when it does not start with `-` and does not follow a value-taking flag.
 */
function vitestRunSegmentsNameFiles(cmd) {
  const segments = cmd.split(/&&|\|\||[;|\n]/).filter((s) => /\bvitest\s+run\b/.test(s));
  if (!segments.length) return null;
  return segments.every((segment) => {
    const tokens = segment.slice(segment.search(/\bvitest\s+run\b/)).split(/\s+/).slice(2).map((t) => t.replace(/^['"]|['"]$/g, ''));
    return tokens.some((t, i) => {
      if (!/\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/.test(t) || t.startsWith('-')) return false;
      const prev = tokens[i - 1];
      return !(prev && prev.startsWith('-') && !prev.includes('=') && !BOOLEAN_VITEST_FLAGS.has(prev));
    });
  });
}

/** x1ds37v — a fixer's single-test debug run (`npm run test:unit -- <files>`, no chained standards) rides the fast
 *  lane only while its target list is small; more files than this is a real suite and stays `FULL`. */
export const FAST_FILES_ENV = 'WE_HEAVY_ADMISSION_FAST_MAX_FILES';
export const DEFAULT_FAST_MAX_FILES = 5;
export function resolveFastMaxFiles(env = {}) {
  const n = Number(env?.[FAST_FILES_ENV]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_FAST_MAX_FILES;
}
/** x1ds37v — per-run timeout (ms) for a bare `files` run: fits under the 10-minute Bash cap. */
export const FAST_RUN_TIMEOUT_ENV = 'WE_HEAVY_ADMISSION_FAST_RUN_TIMEOUT_MS';
export const DEFAULT_FAST_RUN_TIMEOUT_MS = 8 * 60_000;
export function resolveFastRunTimeoutMs(env = {}) {
  const n = Number(env?.[FAST_RUN_TIMEOUT_ENV]);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_FAST_RUN_TIMEOUT_MS;
}
function countVitestRunFileTargets(cmd) {
  let max = 0;
  for (const segment of cmd.split(/&&|\|\||[;|\n]/).filter((x) => /\bvitest\s+run\b/.test(x))) {
    const tokens = segment.slice(segment.search(/\bvitest\s+run\b/)).split(/\s+/).slice(2).map((t) => t.replace(/^['"]|['"]$/g, ''));
    const n = tokens.filter((t, i) => {
      if (!/\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/.test(t) || t.startsWith('-')) return false;
      const prev = tokens[i - 1];
      return !(prev && prev.startsWith('-') && !prev.includes('=') && !BOOLEAN_VITEST_FLAGS.has(prev));
    }).length;
    max = Math.max(max, n);
  }
  return max;
}

/**
 * Classify a heavy command line into a {@link HEAVY_KINDS} kind. Pure. The order matters: an unconditional full
 * suite (`test:unit`, `test:coverage`, a bare `vitest run`) wins over everything else in the same chain; a
 * `vitest related` run chained with check:standards is the verify-lane `selected` gate.
 * @param {string|null|undefined} command
 * @returns {'selected'|'FULL'|'standards'|'files'|'other'}
 */
export function classifyCommandKind(command, env = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return 'other';
  const standards = /check[-:]standards/.test(cmd);
  if (/\btest:coverage\b|\bvitest\b[^\n]*--coverage\b/.test(cmd)) return 'coverage';
  if (/vitest\.soak\.config|conveyor\/soak\//.test(cmd)) return 'soak';
  if (/\b(?:codex|gemini)-direct-task\.mjs\b/.test(cmd)) return 'agent';
  if (/\bnpm\s+(?:run\s+)?test(?::unit|:coverage)?\b/.test(cmd) || /\btest:(?:unit|coverage)\b/.test(cmd)) return 'FULL';
  // A `vitest run` segment without an explicit test file is a whole suite wherever it sits in the chain.
  const runNamesFiles = vitestRunSegmentsNameFiles(cmd);
  if (runNamesFiles === false) return 'FULL';
  if (!standards && !/\bvitest\s+related\b/.test(cmd) && runNamesFiles && countVitestRunFileTargets(cmd) > resolveFastMaxFiles(env)) return 'FULL';
  if (/\bvitest\s+related\b/.test(cmd) || runNamesFiles) return standards ? 'selected' : 'files';
  if (/\bvitest(?:\s+run)?\b/.test(cmd)) return 'FULL';
  if (standards) return 'standards';
  if (/verify-lane\.mjs/.test(cmd)) return 'verify';
  if (/\bnpm\s+(?:ci|install|i)\b|\bnpm\s+run\s+build\b|\bvite\s+build\b|\btsc\b|\besbuild\b/.test(cmd)) return 'build';
  return 'other';
}

/** Item 100 — the label for WHO is acquiring: the entry script's basename plus its subcommand word
 *  (`verify-lane.mjs run`). Pure over an argv. Used when the caller passed no kind and no command, so a hold the
 *  classifier cannot read off a command line (a direct `acquireSlotBlocking`, like verify-lane's phases) still says
 *  what it is. */
export function holderLabel(argv = []) {
  const script = String(argv[1] || '').split('/').pop();
  if (!script) return null;
  const sub = /^[a-z][a-z-]*$/.test(String(argv[2] || '')) ? ` ${argv[2]}` : '';
  return `${script}${sub}`;
}

/** Item 100 — refine a caller-supplied kind: only a missing / `other` kind is re-derived (from the command, else
 *  from the holder label). An explicit named kind is never overridden. */
export function refineKind(kind, { command = null, holder = null, env = {} } = {}) {
  const k = normalizeKind(kind);
  if (k !== 'other') return k;
  if (command) { const c = classifyCommandKind(command, env); if (c !== 'other') return c; }
  if (holder) { const h = classifyCommandKind(holder, env); if (h !== 'other') return h; }
  return 'other';
}

/** Item 100 — minutes held per kind, and for `other` per holder/command, over duration records. Pure. */
export function holdBreakdown(records = [], { sinceIso = null } = {}) {
  const kinds = {};
  const otherBy = {};
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !Number.isFinite(r.ms) || (sinceIso && String(r.at) < sinceIso)) continue;
    const k = normalizeKind(r.kind);
    const e = (kinds[k] ||= { holds: 0, minutes: 0 });
    e.holds += 1; e.minutes += r.ms / 60_000;
    if (k === 'other') {
      const who = r.command || r.holder || r.dispatchKind || String(r.session || 'unknown').replace(/\d[\w-]*$/, '').replace(/-lane-$/, '') || 'unknown';
      const o = (otherBy[who] ||= { holds: 0, minutes: 0 });
      o.holds += 1; o.minutes += r.ms / 60_000;
    }
  }
  const round = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { holds: v.holds, minutes: Math.round(v.minutes) }]));
  return { kinds: round(kinds), other: round(otherBy) };
}

/** Normalise any kind-ish value to a {@link HEAVY_KINDS} member (`null`/unknown → `other`). */
export function normalizeKind(kind) {
  return HEAVY_KINDS.includes(kind) ? kind : 'other';
}

/** The queue lane a kind rides: `fast` for the short kinds, `slow` for full suites and anything unknown. */
export function queueLaneOf(kind) {
  return FAST_LANE_KINDS.includes(kind) ? 'fast' : 'slow';
}

/** The median of a numeric list (`null` when empty). */
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * The typical (standard) minutes per kind: the median of the last {@link TYPICAL_WINDOW} recorded holds of that
 * kind once at least {@link TYPICAL_MIN_SAMPLES} exist, else the seed. Pure over the parsed duration records.
 * @param {Array<{kind:string, ms:number}>} records  oldest first (the log's append order)
 * @param {{seeds?:object, window?:number, minSamples?:number}} [o]
 * @returns {{minutes:Record<string,number>, source:Record<string,{from:'rolling'|'seed', samples:number}>}}
 */
export function typicalMinutes(records = [], { seeds = DEFAULT_STANDARD_MINUTES, window = TYPICAL_WINDOW, minSamples = TYPICAL_MIN_SAMPLES } = {}) {
  const minutes = {};
  const source = {};
  for (const kind of HEAVY_KINDS) {
    const samples = (Array.isArray(records) ? records : [])
      .filter((r) => r && normalizeKind(r.kind) === kind && Number.isFinite(r.ms) && r.ms >= 0)
      .slice(-window)
      .map((r) => r.ms / 60_000);
    const m = samples.length >= minSamples ? median(samples) : null;
    minutes[kind] = m != null ? Math.round(m * 100) / 100 : seeds[kind];
    source[kind] = { from: m != null ? 'rolling' : 'seed', samples: samples.length };
  }
  return { minutes, source };
}

/** Rolling median of per-session heavy time; prepare subkinds share one measurement. */
export function typicalDispatchMinutes(records = [], { window = TYPICAL_WINDOW, minSamples = TYPICAL_MIN_SAMPLES } = {}) {
  const minutes = {};
  const source = {};
  for (const kind of ['prepare']) {
    const sessions = new Map();
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || !PREPARE_DISPATCH_KINDS.includes(r.dispatchKind) || !Number.isFinite(r.ms) || r.ms < 0) continue;
      const key = typeof r.session === 'string' && r.session.length > 0 ? r.session : `${r.repo}|${r.leaseAcquiredAt ?? r.at}`;
      sessions.set(key, (sessions.get(key) || 0) + r.ms);
    }
    const samples = [...sessions.values()].slice(-window).map((ms) => ms / 60_000);
    const m = samples.length >= minSamples ? median(samples) : null;
    minutes[kind] = m != null ? Math.round(m * 100) / 100 : null;
    source[kind] = { from: m != null ? 'rolling' : 'seed', samples: samples.length };
  }
  return { minutes, source };
}

/**
 * Classify a dispatched session from its lane lease (`purpose` / `session`) into a dispatch kind, or `null` when
 * the lease is not a recognised dispatched session (a human or ad-hoc worker lane — not counted as pending).
 * @param {{purpose?:string|null, session?:string|null}} lease
 * @returns {'fix'|'ci-heal'|'build'|'review'|'prepare'|null}
 */
export function classifyDispatchKind(lease) {
  const purpose = String(lease?.purpose || '');
  const session = String(lease?.session || '');
  if (/ci-heal/.test(purpose) || /^ci-heal-/.test(session)) return 'ci-heal';
  if (purpose === 'conveyor-fix' || /^fix-\d/.test(session)) return 'fix';
  if (/^review/.test(purpose) || /^review-/.test(session)) return 'review';
  if (/^prepare|investigat/.test(purpose) || /^(?:prepare|investigate)-/.test(session)) return 'prepare';
  if (purpose === 'conveyor-delivery' || /^conveyor-/.test(session) || /^build-/.test(purpose)) return 'build';
  return null;
}

/**
 * Expected heavy-slot minutes a NEW session of `kind` will add to the queue. Pure.
 *   review → 0; prepare family → measured session demand (or the fix-sized seed), unless exempt;
 *   fix, ci-heal → one selected run + one check:standards;
 *   build → that same unit × clamp(ceil(size ÷ {@link BUILD_SIZE_POINTS_PER_RUN}), 1, {@link MAX_BUILD_RUNS}).
 *   Anything else is costed like a fix (a conservative small unit, never zero).
 * @param {string} kind
 * @param {{size?:number|null, standardMinutes?:Record<string,number>, dispatchMinutes?:object|null, prepareAdmission?:string}} [o]
 */
export function dispatchDemandMinutes(kind, { size = null, standardMinutes = DEFAULT_STANDARD_MINUTES, dispatchMinutes = null, prepareAdmission = 'charge' } = {}) {
  if (EXEMPT_DISPATCH_KINDS.includes(kind)) return 0;
  const std = { ...DEFAULT_STANDARD_MINUTES, ...(standardMinutes || {}) };
  const unit = std.selected + std.standards;
  if (PREPARE_DISPATCH_KINDS.includes(kind)) {
    return prepareAdmission === 'exempt' ? 0 : round1(Number.isFinite(dispatchMinutes?.prepare) && dispatchMinutes.prepare > 0 ? dispatchMinutes.prepare : unit);
  }
  if (kind === 'build') {
    const s = Number(size);
    const pts = Number.isFinite(s) && s > 0 ? s : DEFAULT_BUILD_SIZE;
    const runs = Math.min(MAX_BUILD_RUNS, Math.max(1, Math.ceil(pts / BUILD_SIZE_POINTS_PER_RUN)));
    return round1(unit * runs);
  }
  return round1(unit);
}

function round1(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Sum the current queue BACKLOG in slot-minutes. Pure.
 * @param {{held?:Array<{kind?:string, elapsedMinutes?:number}>, waiting?:Array<{kind?:string}>,
 *   pending?:Array<{demandMinutes:number}>, standardMinutes?:Record<string,number>}} o
 * @returns {{heldRemainingMinutes:number, waitingMinutes:number, pendingMinutes:number, backlogMinutes:number,
 *   held:Array<object>, waiting:Array<object>}}
 */
export function queueBacklog({ held = [], waiting = [], pending = [], standardMinutes = DEFAULT_STANDARD_MINUTES } = {}) {
  const std = { ...DEFAULT_STANDARD_MINUTES, ...(standardMinutes || {}) };
  const heldRows = held.map((h) => {
    const kind = normalizeKind(h.kind);
    const elapsed = Number.isFinite(h.elapsedMinutes) ? h.elapsedMinutes : 0;
    // A job already past its standard time still holds its slot; it is counted as about to finish (0), never
    // negative. The rolling median absorbs a kind that routinely overruns.
    return { ...h, kind, remainingMinutes: round1(Math.max(std[kind] - elapsed, 0)) };
  });
  const waitingRows = waiting.map((w) => ({ ...w, kind: normalizeKind(w.kind), expectedMinutes: std[normalizeKind(w.kind)] }));
  const heldRemainingMinutes = round1(heldRows.reduce((s, h) => s + h.remainingMinutes, 0));
  const waitingMinutes = round1(waitingRows.reduce((s, w) => s + w.expectedMinutes, 0));
  const pendingMinutes = round1(pending.reduce((s, p) => s + (Number(p.demandMinutes) || 0), 0));
  // The per-lane split (PR #2707 operator decision): heavy demand queues on the heavy slots only; short demand —
  // short holders / waiters and every pending dispatch (a dispatch's checks are short) — on fast + free heavy.
  const isHeavy = (r) => queueLaneOf(r.kind) === 'slow';
  const sum = (rows, f) => rows.reduce((acc, r) => acc + f(r), 0);
  const heavyBacklogMinutes = round1(sum(heldRows.filter(isHeavy), (h) => h.remainingMinutes) + sum(waitingRows.filter(isHeavy), (w) => w.expectedMinutes));
  const shortBacklogMinutes = round1(sum(heldRows.filter((r) => !isHeavy(r)), (h) => h.remainingMinutes)
    + sum(waitingRows.filter((r) => !isHeavy(r)), (w) => w.expectedMinutes) + pendingMinutes);
  return {
    heldRemainingMinutes, waitingMinutes, pendingMinutes,
    backlogMinutes: round1(heldRemainingMinutes + waitingMinutes + pendingMinutes),
    heavyBacklogMinutes, shortBacklogMinutes,
    heldHeavyCount: heldRows.filter(isHeavy).length, waitingHeavyCount: waitingRows.filter(isHeavy).length,
    held: heldRows, waiting: waitingRows,
  };
}

/** The single-pool formula: (backlog + extra demand) ÷ slots, in minutes. `slots` below 1 is treated as 1. Used
 *  only for a baseline without the per-lane split (see {@link createQueueBudget}); {@link laneProjection} is the
 *  real one. */
export function projectedWaitMinutes({ backlogMinutes = 0, extraMinutes = 0, slots = 1 } = {}) {
  const n = Number.isFinite(slots) && slots >= 1 ? slots : 1;
  return round1((backlogMinutes + extraMinutes) / n);
}

/**
 * THE PER-LANE FORMULA (PR #2707 operator decision). Pure.
 *   heavy wait = heavy backlog ÷ heavy slots;
 *   free heavy slots = heavy slots − heavy jobs holding − heavy jobs waiting (floored at 0);
 *   short wait = (short backlog + extra) ÷ (fast slots + free heavy slots). With no short capacity at all (no fast
 *   slot and every heavy slot spoken for) a short job waits for the heavy lane to clear first.
 * @returns {{heavyWaitMinutes:number, shortWaitMinutes:number, shortCapacity:number, freeHeavySlots:number}}
 */
export function laneProjection({
  heavySlots = 1, fastSlots = 0, heavyBacklogMinutes = 0, shortBacklogMinutes = 0,
  heldHeavyCount = 0, waitingHeavyCount = 0, extraShortMinutes = 0,
} = {}) {
  const heavy = Number.isFinite(heavySlots) && heavySlots >= 1 ? heavySlots : 1;
  const fast = Number.isFinite(fastSlots) && fastSlots > 0 ? fastSlots : 0;
  const heavyWaitMinutes = round1(heavyBacklogMinutes / heavy);
  const freeHeavySlots = Math.max(0, heavy - heldHeavyCount - waitingHeavyCount);
  const shortCapacity = fast + freeHeavySlots;
  const short = shortBacklogMinutes + extraShortMinutes;
  const shortWaitMinutes = shortCapacity > 0 ? round1(short / shortCapacity) : round1(heavyWaitMinutes + short / heavy);
  return { heavyWaitMinutes, shortWaitMinutes, shortCapacity, freeHeavySlots };
}

/** Does this baseline carry the per-lane split {@link laneProjection} needs? */
function hasLaneSplit(b) {
  return !!b && Number.isFinite(b.heavySlots) && Number.isFinite(b.heavyBacklogMinutes) && Number.isFinite(b.shortBacklogMinutes);
}

/**
 * A running ADMISSION BUDGET over one queue baseline — one per tick / per daemon pass, so several dispatches in
 * quick succession each see the demand of the ones admitted before them (the whole point: the 4th of 4 quick
 * dispatches is the one that gets stopped, not none of them). Pure (a closure over plain numbers).
 *
 * An absent / bypassed / malformed baseline admits everything (`active:false`) — the gate FAILS OPEN, the same
 * posture #4076's load gate takes on a missing sample: a read outage must never wedge dispatch.
 * A baseline with the per-lane split (`heavySlots`, `fastSlots`, `heavyBacklogMinutes`, `shortBacklogMinutes`,
 * `heldHeavyCount`, `waitingHeavyCount` — what `heavy-admission.mjs queue-status` prints) is costed with
 * {@link laneProjection}: a dispatch's demand is short work, so it sees the SHORT-lane wait. A bare
 * `{slots, backlogMinutes}` baseline is costed as one pool ({@link projectedWaitMinutes}).
 * @param {object|null} baseline
 * @param {{extraMinutes?:number}} [o]  demand already known to be on its way (e.g. the tick's own fresh guards)
 */
export function createQueueBudget(baseline, { extraMinutes = 0 } = {}) {
  const split = !!baseline && !baseline.bypassed && hasLaneSplit(baseline);
  const active = split || (!!baseline && !baseline.bypassed && Number.isFinite(baseline.slots) && Number.isFinite(baseline.backlogMinutes));
  const maxWait = Number.isFinite(baseline?.maxWaitMinutes) ? baseline.maxWaitMinutes : DEFAULT_QUEUE_MAX_WAIT_MINUTES;
  let added = Number.isFinite(extraMinutes) ? extraMinutes : 0;
  const decisions = [];
  /** Projected wait (minutes) a dispatch of `demandMinutes` would see if started right now. */
  const projectFor = (demandMinutes = 0) => {
    if (!active) return null;
    if (split) return laneProjection({ ...baseline, extraShortMinutes: added + demandMinutes }).shortWaitMinutes;
    return projectedWaitMinutes({ backlogMinutes: baseline.backlogMinutes, extraMinutes: added + demandMinutes, slots: baseline.slots });
  };
  return {
    active,
    maxWaitMinutes: maxWait,
    projectFor,
    /**
     * Admit-or-hold one dispatch. Admitting adds its demand to the budget for every later call.
     * @param {string} kind  dispatch kind (`build` / `fix` / `ci-heal` / `review` / …)
     * @param {{size?:number|null, id?:*}} [o]
     */
    tryAdmit(kind, { size = null, id = null } = {}) {
      const demandMinutes = dispatchDemandMinutes(kind, {
        size, standardMinutes: baseline?.standardMinutes, dispatchMinutes: baseline?.dispatchMinutes, prepareAdmission: baseline?.prepareAdmission ?? 'charge',
      });
      const exempt = EXEMPT_DISPATCH_KINDS.includes(kind) || (PREPARE_DISPATCH_KINDS.includes(kind) && baseline?.prepareAdmission === 'exempt');
      if (!active || exempt) {
        const d = { id, kind, admit: true, exempt, demandMinutes, projectedMinutes: projectFor(demandMinutes), maxWaitMinutes: maxWait };
        decisions.push(d);
        return d;
      }
      const projectedMinutes = projectFor(demandMinutes);
      const admit = projectedMinutes <= maxWait;
      if (admit) added += demandMinutes;
      const d = { id, kind, admit, exempt: false, demandMinutes, projectedMinutes, maxWaitMinutes: maxWait };
      decisions.push(d);
      return d;
    },
    decisions: () => decisions.slice(),
    addedMinutes: () => added,
  };
}

/**
 * How many FAST-lane slots exist, ADDED ON TOP of the heavy cap (PR #2707 operator decision). Pure over `env`:
 * `WE_HEAVY_ADMISSION_FAST_SLOTS` (≥ 0), default {@link DEFAULT_FAST_SLOTS}. Independent of the cap — the fast
 * slots never reduce the number of heavy slots.
 */
export function resolveFastSlots(env = {}) {
  const raw = env?.[FAST_SLOTS_ENV];
  return raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Math.floor(Number(raw))) : DEFAULT_FAST_SLOTS;
}

/**
 * The slot indices a job of `kind` may try, in order. Heavy slots are `0 … cap-1`; the fast slots come after them,
 * `cap … cap+fast-1`. A short job tries the fast slots first, then any heavy slot; a full suite (or any other
 * heavy job) tries only the heavy slots.
 * @returns {number[]}
 */
export function slotOrderFor(kind, cap, fastSlots) {
  const c = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1;
  const f = Number.isFinite(fastSlots) && fastSlots > 0 ? Math.floor(fastSlots) : 0;
  const heavy = Array.from({ length: c }, (_, i) => i);
  const fast = Array.from({ length: f }, (_, i) => c + i);
  return queueLaneOf(normalizeKind(kind)) === 'fast' ? [...fast, ...heavy] : heavy;
}
