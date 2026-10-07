/**
 * @file scripts/operations/heavy-queue.mjs
 * @description Card xb0iuxq (epic #4075, under #3383) — the declared, read-only `heavy-queue` operation: the
 *   operator's hand-built "who's holding/waiting on the heavy-admission pool right now" report, made
 *   mechanical. Mirrors `daemon-status.mjs` (#4067)'s own READ / ASSESS SPLIT: {@link
 *   ./heavy-queue-io.mjs}'s `collectHeavyQueue` does every real read (`we:scripts/readiness/heavy-admission.mjs`'s
 *   own `admissionStatus` EXPORT — never a subprocess — plus a `ps` read of each holder/waiter's live pid and a
 *   `git merge-base --is-ancestor` check per repo); everything in THIS file is a pure function over that raw
 *   snapshot.
 *
 * WHY A PID'S OWN COMMAND LINE, NOT A STORED "kind" FIELD. `heavy-admission.mjs`'s lock entries carry no `meta`
 * for its `run` wrapper or for `verify-lane.mjs`'s direct acquire (see that module's own `tryAcquireSlot`/
 * `acquireSlotBlocking` call sites) — the ONE thing every holder/waiter really has is the real pid it acquired
 * under, and that pid's OWN argv already says what it is: `verify-lane.mjs` acquires directly (owner = the
 * repo path, pid = its own process), while every other heavy command goes through `heavy-admission.mjs run --
 * <command>` (#3383's "every heavy command goes through this pool" migration — that module's own header), so
 * the wrapper's pid's argv literally IS `… heavy-admission.mjs run -- <the real command>`. Reading the LIVE
 * command is therefore more truthful than inventing a second, stored classification that could drift from what
 * actually ran.
 *
 * SELECTED vs FULL for a `verify-lane.mjs` holder is NOT a further command-line pattern — `verify-lane.mjs`'s
 * own default-gate DECISION (diff-driven `selected` vs the fail-safe `FULL`, #3372) happens INSIDE that process,
 * invisible from outside. What IS externally visible is whether that lane's own checked-out copy of
 * `verify-lane.mjs` even HAS the diff-driven default gate at all — PR #2680 (`lane/xpnhz4o-local-gate-selected-
 * tests`, merge `14a3d0dff`) is the commit that added it. A lane forked BEFORE that merge still runs the OLD,
 * unconditional `npm run test:unit && npm run check:standards` no matter what its diff looks like, so its
 * holder is classified `FULL`; a lane whose base already contains #2680 gets the benefit of the doubt and is
 * classified `selected` (the diff-driven gate's own fallback to `FULL` on a non-shrinkable diff is a real,
 * finer-grained case this operation does not further distinguish — see the report finding on card xb0iuxq for
 * why old-base lanes are common enough to matter on their own).
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { DEFAULT_STANDARD_MINUTES, createQueueBudget, DEFAULT_BUILD_SIZE, HEAVY_KINDS, classifyCommandKind } from '../readiness/heavy-queue-projection.mjs';

export const HEAVY_QUEUE_OP = 'heavy-queue';

/** The commit PR #2680 merged onto `main` — the diff-driven default-gate cutover `verify-lane.mjs`'s own
 *  header calls #3372. A repo whose HEAD descends from this commit runs the NEW default gate. */
export const SELECTED_GATE_MERGE_SHA = '14a3d0dff';

/** The SEED "standard time" per KIND (minutes) — card xkyw1x4 replaced this operation's old crude constants
 *  with the admission module's own seeds (`heavy-queue-projection.mjs#DEFAULT_STANDARD_MINUTES`, measured under
 *  load 2026-09-25). The live report uses the ROLLING typical value per kind the admission root records on every
 *  slot release (`verdict.queue.standardMinutes`); these seeds apply only when no snapshot carries one. */
export const STANDARD_MINUTES_BY_KIND = DEFAULT_STANDARD_MINUTES;

/**
 * Classify a heavy-admission holder/waiter's KIND from the LIVE command line of the pid it acquired under.
 * Pure — `command` and `isSelectedBase` are already read by the IO layer. `null`/empty `command` (the pid is
 * gone, or `ps` could not be read) classifies `other` rather than guessing.
 * @param {{command:string|null, isSelectedBase?:boolean|null}} o
 * @returns {'selected'|'FULL'|'standards'|'files'|'other'}
 */
export function classifyHeavyJobKind({ command, isSelectedBase = null, kind = null } = {}) {
  // Card xkyw1x4 — a holder / waiter written by the new admission code RECORDS its kind (slot `meta.kind`, the
  // waiting marker's `kind`); that recorded kind wins over re-deriving it from the command line.
  if (HEAVY_KINDS.includes(kind)) return kind;
  const cmd = String(command || '').trim();
  if (!cmd) return 'other';
  if (/verify-lane\.mjs/.test(cmd)) return isSelectedBase ? 'selected' : 'FULL';
  if (/check[-:]standards/.test(cmd)) return 'standards';
  if (/\bvitest\s+related\b/.test(cmd)) return 'files';
  if (/\bvitest\s+run\b/.test(cmd)) return 'FULL';
  if (/\bnpm\s+(?:run\s+)?test(?::unit)?\b/.test(cmd)) return 'FULL';
  return classifyCommandKind(cmd); // item 100 — soak / coverage / build / agent / verify, else a truly unknown `other`
}

/** Minutes between two ISO timestamps (or `null` when either is unparseable), rounded to one decimal. */
function minutesBetween(fromIso, nowMs) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return Math.round(((nowMs - t) / 60_000) * 10) / 10;
}

/**
 * Assess ONE raw held/waiting entry (see {@link ./heavy-queue-io.mjs#collectHeavyQueue} for the input shape) —
 * pure classification + minutes math over an already-read snapshot.
 * @param {object} raw
 * @param {{state:'RUN'|'WAIT', observedAt:string}} ctx
 */
export function assessHeavyQueueRow(raw, { state, observedAt }) {
  const nowMs = Date.parse(observedAt);
  const kind = classifyHeavyJobKind({ command: raw.command, isSelectedBase: raw.isSelectedBase, kind: raw.kind ?? null });
  const who = (raw.lease && (raw.lease.purpose || raw.lease.session)) || null;
  const since = state === 'RUN' ? raw.heartbeatAt : raw.requestedAt;
  return {
    state, lane: raw.lane ?? null, who, kind, minutes: minutesBetween(since, nowMs),
    repo: raw.repo ?? null, owner: raw.owner ?? null, pid: raw.pid ?? null, command: raw.command ?? null,
    since, ...(state === 'WAIT' ? { live: raw.live !== false } : {}),
  };
}

/**
 * Project a rough wait (minutes) for a BRAND NEW job arriving right now — `0` whenever a slot is already free.
 * Otherwise a small list-scheduling SIMULATION over the `cap` "machines" (slots): seed one machine per RUNNING
 * holder with its own remaining time (its kind's standard minutes minus how long it has already run, floored
 * at 0); then walk every currently WAITING job in FCFS order (by `since` — the same arrival order the #3383
 * fairness fix this same card ships enforces for real) and assign each to whichever machine frees SOONEST,
 * extending that machine's free-time by the waiting job's OWN standard duration (once admitted, it occupies
 * that slot for its full run). The new arrival's projected wait is whichever machine frees soonest AFTER every
 * existing waiter has been placed — mirroring the FCFS queue it would actually join, never ahead of a single
 * waiter.
 *
 * FIXED (#2692 independent review, two independent confirmations): the first cut only ever looked at the
 * CURRENT holders' own remaining times and picked the one at the waiting-count's ordinal position — correct
 * only while waiters never outnumber the machines. Once waiting jobs reach or exceed `cap`, that undercounts
 * badly: with cap=1, a holder 1 minute from done, and three waiting `standards` jobs (8 minutes each), the old
 * code reported ~1 minute (the holder's own remaining time) instead of ~25 (1 + 8 + 8 + 8, everyone queued
 * behind the one machine) — completely ignoring every waiting job's OWN execution time. This simulation is
 * exactly the queue a new arrival actually joins. Deliberately crude on ONE remaining axis — the PER-KIND
 * DURATIONS themselves — see {@link STANDARD_MINUTES_BY_KIND}'s own doc for why that is a future admission-card
 * refinement, not this one's.
 *
 * A waiter marked `live: false` (crashed or stale — `heavy-admission.mjs#isRankableWaiter`, the SAME rule the
 * FCFS ranking skips) is shown in the report but never placed on a machine: a dead `other` marker would
 * otherwise add a phantom 20-minute wave each (PR #2692 fix-round self-review).
 * @param {{rows:Array<object>, freeCount:number}} o
 */
export function projectedWaitMinutesForNewJob({ rows, freeCount, standardMinutes = STANDARD_MINUTES_BY_KIND }) {
  if (freeCount > 0) return 0;
  const holders = rows.filter((r) => r.state === 'RUN');
  if (holders.length === 0) return 0;
  const std = { ...STANDARD_MINUTES_BY_KIND, ...(standardMinutes || {}) };
  const machineFreeAt = holders
    .map((h) => Math.max((std[h.kind] ?? std.other) - (h.minutes ?? 0), 0));
  const waiting = rows
    .filter((r) => r.state === 'WAIT' && r.live !== false)
    .sort((a, b) => (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0)); // FCFS arrival order
  for (const w of waiting) {
    let soonest = 0;
    for (let i = 1; i < machineFreeAt.length; i++) if (machineFreeAt[i] < machineFreeAt[soonest]) soonest = i;
    machineFreeAt[soonest] += std[w.kind] ?? std.other;
  }
  return Math.round(Math.min(...machineFreeAt) * 10) / 10;
}

/**
 * Assess the whole snapshot. Adds the cap/held/waiting summary + the projected-wait estimate the report
 * headlines.
 * @param {object} read  {@link ./heavy-queue-io.mjs#collectHeavyQueue}'s return shape
 */
export function assessHeavyQueue(read) {
  if (!read || !Array.isArray(read.held) || !Array.isArray(read.waiting)) {
    throw new TypeError('heavy-queue: unreadable snapshot has no held/waiting arrays');
  }
  const observedAt = read.observedAt;
  const rows = [
    ...read.held.map((r) => assessHeavyQueueRow(r, { state: 'RUN', observedAt })),
    ...read.waiting.map((r) => assessHeavyQueueRow(r, { state: 'WAIT', observedAt })),
  ];
  const queue = read.queue && typeof read.queue === 'object' ? read.queue : null;
  const projected = projectedWaitMinutesForNewJob({ rows, freeCount: read.freeCount, standardMinutes: queue?.standardMinutes });
  const admission = assessQueueAdmission(queue);
  const slotsLabel = read.fastSlots ? `${read.cap} heavy + ${read.fastSlots} fast` : `${read.cap}`;
  const headline = `${read.heldCount} of ${slotsLabel} held, ${rows.filter((r) => r.state === 'WAIT').length} waiting`
    + (read.freeCount > 0 ? ` — ${read.freeCount} free` : ` — projected wait for a new job: ~${projected}m`)
    + (admission ? ` — ${admission.headline}` : '');
  return {
    observedAt, cap: read.cap, fastSlots: read.fastSlots ?? 0, heldCount: read.heldCount, freeCount: read.freeCount,
    waitingCount: rows.filter((r) => r.state === 'WAIT').length,
    projectedWaitMinutesForNewJob: projected, rows, headline,
    queueAdmission: admission,
  };
}

/**
 * Card xkyw1x4 — "PROJECTED WAIT IF YOU START NOW": the dispatch-admission view of the queue baseline
 * (`heavy-admission.mjs#resolveQueueBaseline`). For each dispatch kind, what the projected queue wait would be
 * if one more session of that kind started right now, and whether the `queue-cap` gate would admit or hold it —
 * the SAME `createQueueBudget` the tick and the fix / CI-heal daemons admit with, never a second estimator.
 * `null` when no baseline was read; `{bypassed}` when the gate is switched off.
 * @param {object|null} queue
 */
export function assessQueueAdmission(queue) {
  if (!queue) return null;
  if (queue.bypassed) return { bypassed: queue.bypassed, headline: `queue admission bypassed (${queue.bypassed})` };
  const byKind = {};
  for (const [label, kind, size] of [['review', 'review', null], ['fix', 'fix', null], ['ci-heal', 'ci-heal', null], [`build (size ${DEFAULT_BUILD_SIZE})`, 'build', DEFAULT_BUILD_SIZE], ['build (size 8)', 'build', 8]]) {
    const d = createQueueBudget(queue).tryAdmit(kind, { size });
    byKind[label] = { demandMinutes: d.demandMinutes, projectedMinutes: d.projectedMinutes, admit: d.admit, exempt: d.exempt };
  }
  const fix = byKind.fix;
  return {
    projectedWaitMinutes: queue.projectedWaitMinutes,
    fullSuiteWaitMinutes: queue.heavyWaitMinutes ?? null,
    maxWaitMinutes: queue.maxWaitMinutes,
    slots: queue.slots, heavySlots: queue.heavySlots ?? null, fastSlots: queue.fastSlots,
    shortCapacity: queue.shortCapacity ?? null, freeHeavySlots: queue.freeHeavySlots ?? null,
    heavyBacklogMinutes: queue.heavyBacklogMinutes ?? null, shortBacklogMinutes: queue.shortBacklogMinutes ?? null,
    backlogMinutes: queue.backlogMinutes,
    heldRemainingMinutes: queue.heldRemainingMinutes, waitingMinutes: queue.waitingMinutes, pendingMinutes: queue.pendingMinutes,
    pending: queue.pending ?? [],
    standardMinutes: queue.standardMinutes, standardSource: queue.standardSource,
    byKind,
    headline: `projected wait if you start now: ~${queue.projectedWaitMinutes}m of ${queue.maxWaitMinutes}m max`
      + ` (a fix → ~${fix.projectedMinutes}m, ${fix.admit ? 'admitted' : 'HELD queue-cap'})`
      + (queue.heavyWaitMinutes != null ? `; a full suite → ~${queue.heavyWaitMinutes}m` : ''),
  };
}

/**
 * The declared operation. Read-only, no input required — same no-sinks reasoning as `daemon-status`/
 * `runner-activity`: every step is `compute`, so no effect exists for a sink to apply. `collect` is the
 * injected IO ({@link ./heavy-queue-io.mjs#collectHeavyQueue}), bound to the real admission pool + `ps` + `git`
 * only in `run.mjs`.
 * @param {{collect: () => object}} deps
 */
export function heavyQueueOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('heavy-queue needs a collect reader');
  return op(HEAVY_QUEUE_OP, {
    input: {},
    verdictFrom: 'assess',
    read: compute({ reads: [], fn: () => collect() }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessHeavyQueue(findings.read) }),
  });
}
