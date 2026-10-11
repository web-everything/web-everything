/**
 * @file scripts/operations/run-record.mjs
 * @description THE RUN RECORD — the pure half of the run store (#3032, under epic #3029).
 *
 * WHAT A RUN RECORD IS. `{ id, op, input, cursor, findings, verdict, effects }` — the machine's working
 * state for ONE execution of one declared operation — plus `pending` (what the run is waiting on) and `v`
 * (the schema version). It is what lets a run **cross surfaces**: the state lives on the record, not in the
 * caller, so a run started on the command line can be finished in the console, or in a process that never
 * saw the first half (see `__tests__/run-crosses-processes.test.mjs`).
 *
 * THE RUN RECORD IS **NOT** THE VERDICT LEDGER. The ledger (#3007, still **open** — not built here) is
 * append-only JSONL keyed by PR + diff content-hash, single-writer via the drain lease, and is the durable
 * **merge authority**. The run record is none of those: it has a cursor, it is session-local, and it dies
 * when the run is done. They sit on opposite sides of
 * [#state-lives-where-its-nature-dictates](../../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates)
 * — clause 1 (transient intent → session-local sidecar) versus clause 2 (durable readiness → committed
 * upstream). The relationship is **producer → store**: a run's ledger-shaped effect WRITES to the ledger
 * through a sink that neither this file nor {@link ./effect-executor.mjs} owns.
 *
 * WHY THIS IS A SEPARATE FILE FROM {@link ./run-store.mjs}. It is the same pure-core / io-shell discipline
 * `we:scripts/conveyor/queue-store.mjs` (#2613) uses, just split across two files instead of two halves of
 * one. The split is deliberate: it makes the engine's purity **mechanically provable** — `engine.mjs`,
 * `registry.mjs`, `step-kinds.mjs` and this file import NOTHING from `node:`, and a test asserts exactly
 * that over the whole graph. Keeping the fs shell in the same module would have put `node:fs` in the
 * engine's import graph and reduced "the engine touches no disk" to a claim in a comment.
 *
 * PURE. No fs, no clock, no process, no randomness, no network.
 */

import { JOB_OP_PREFIX, newJobBlock, validateJobBlock } from './job-record.mjs';

/** Schema version stamped on every record. A reader refuses a version it does not know. */
export const RUN_RECORD_VERSION = 1;

/**
 * The lifecycle of one declared effect inside a run record. See {@link ./effect-executor.mjs}.
 *
 * `in-flight` (#3073) is NOT a synonym for `pending`, and conflating them is the defect it was added to fix.
 * `pending` means *attempted, outcome UNKNOWN* — the process died mid-sink — and a replay REFUSES it rather
 * than risk a double-apply. `in-flight` means *started ON PURPOSE, outcome arrives later* — a dispatched build,
 * a spawned session — and a replay must RESUME it. One status cannot carry both without the replay guard being
 * wrong half the time.
 */
export const EFFECT_STATUSES = Object.freeze(['declared', 'pending', 'in-flight', 'applied', 'failed']);

/** Ids are used as filenames, so the character set is closed — no separators, no traversal, no surprises. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Is this string something an observer could actually poll?
 *
 * AN ALLOWLIST, because two denylists in a row were wrong. `.trim()` missed a zero-width space; the fix for
 * that was a denylist of the four code points the reviewer had named, which called itself "has a visible
 * character" and let sixteen more through — NUL, DEL, a combining acute, a lone surrogate, bidi overrides, a
 * variation selector. Enumerating what is unusable loses to naming what is usable; the same lesson the `gh`
 * deny-list and the hand-rolled CommonMark parser each taught here.
 *
 * So: at least one ASCII alphanumeric. A handle is an identifier minted by tooling — a session id, a build
 * id — and every one of them has a letter or a digit. This is deliberately narrower than "visible", because
 * "visible" is not decidable (a Hangul filler is a LETTER by Unicode and renders as blank) and because the
 * two errors are not symmetric: accepting garbage parks a run forever telling the operator to poll nonsense,
 * while refusing a legitimate handle fails loudly at dispatch with a message naming the problem.
 */
export function isPollableHandle(handle) {
  return typeof handle === 'string' && /[A-Za-z0-9]/.test(handle);
}

/** @param {*} v @returns {boolean} */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Is `id` usable as a run id (and therefore as a filename)? */
export function isValidRunId(id) {
  return typeof id === 'string' && RUN_ID_RE.test(id) && id !== '.' && id !== '..';
}

/**
 * A fresh run record. The id is INJECTED (the io shell's `newRunId` mints one) and the input is expected to
 * have been validated against the declaration already — `startRun` in {@link ./engine.mjs} does both.
 *
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.op - the declared operation's name.
 * @param {object} [spec.input]
 * @returns {object} a new run record.
 */
export function newRunRecord({ id, op, input = {} } = {}) {
  if (!isValidRunId(id)) throw new TypeError(`operations: invalid run id ${JSON.stringify(id)}`);
  if (typeof op !== 'string' || !op.trim()) throw new TypeError('operations: a run record needs an operation name');
  if (!isPlainObject(input)) throw new TypeError('operations: a run record `input` must be an object');
  return {
    v: RUN_RECORD_VERSION,
    id,
    op: op.trim(),
    input: { ...input },
    cursor: 0,
    findings: {},
    verdict: null,
    effects: [],
    telemetry: [],
    stepTimings: [],
    pending: null,
  };
}

/**
 * A fresh, queued JOB record (#4125): a run record with `op: job:<kind>` and a `job` block. See
 * {@link ./job-record.mjs} for the block's fields.
 *
 * @param {{id: string, kind: string, input?: object, codeMode?: string, maxAttempts?: number, codeSha?: string|null}} spec
 * @returns {object}
 */
export function newJobRunRecord({ id, kind, input = {}, codeMode, maxAttempts, codeSha } = {}) {
  const job = newJobBlock({ kind, codeMode, maxAttempts, codeSha });
  return { ...newRunRecord({ id, op: `${JOB_OP_PREFIX}${kind}`, input }), job };
}

/**
 * THE METERED FIELDS of one juror spawn, and NOTHING ELSE. See {@link normalizeJudgeTelemetry}.
 * `usage` is handled separately (it is an object of counters, not a scalar).
 */
const TELEMETRY_NUMBERS = Object.freeze(['costUsd', 'durationMs', 'wallMs', 'numTurns', 'loadedContextTokens', 'exitCode', 'attempts']);
const TELEMETRY_STRINGS = Object.freeze(['sessionId', 'stopReason', 'lens', 'model', 'effort', 'transcriptFile', 'requestedModel', 'servedModel', 'servedBackend', 'modelEvidence', 'quotaState', 'quotaResetsAt', 'fallbackDecision', 'signal', 'stderrTail', 'failure']);
/**
 * Held item 223 — WHY A SEAT FAILED, not only what it cost. `exitCode`, `signal`, `attempts`, `failure` and a
 * `stderrTail` come from `we:scripts/lib/judge-spawn.mjs#JudgeUnparseableError`'s telemetry. Before they were on this
 * list, 15 of 119 review runs on 2026-10-10 died on "the juror did not emit parseable JSON on stdout" and no record
 * could say whether the juror was killed, crashed or printed nothing. `stderrTail` is bounded here as well as at the
 * source, because this row is written on every `advance`.
 */
const TELEMETRY_STRING_MAX = Object.freeze({ stderrTail: 1000 });
/**
 * THE FLAGS, recorded only when TRUE. A `timedOut: false` on every row is noise; the fact being recorded is
 * the exception, and its absence is the ordinary case (#3203). Without it a juror that hit the wall and a
 * juror that crashed produced identical records, which is what taught a reader to retry rather than look.
 */
const TELEMETRY_FLAGS = Object.freeze(['timedOut']);

/**
 * NORMALIZE one juror spawn's telemetry into a run-record row. PURE.
 *
 * WHY A WHITELIST AND NOT A SPREAD. The row is supplied by the ADAPTER (the engine declares the juror call and
 * never makes it — see {@link ./engine.mjs}), so its contents come from outside the pure core, and the record
 * is JSON-serialized to disk AND printed verbatim by `--json`. A spread would let a caller put the juror's
 * whole argv (which carries the mandate) or an unbounded transcript into a record that is written on every
 * `advance`. This takes the listed numbers and names (what the juror cost, and why a failed one failed) and the
 * counter block, and drops everything else silently — a caller adding a field gets no error and no leak.
 *
 * `usage` is copied ONE level deep and only its numeric entries, for the same reason. A flag is copied only
 * when true — see {@link TELEMETRY_FLAGS}.
 *
 * @param {{step?: string, stepIndex?: number, telemetry?: object}} o
 * @returns {object} a frozen row: `{ step, stepIndex, …scalars, usage }`.
 */
export function normalizeJudgeTelemetry({ step = '', stepIndex = null, telemetry = {} } = {}) {
  const src = isPlainObject(telemetry) ? telemetry : {};
  const row = { step: String(step), stepIndex: Number.isInteger(stepIndex) ? stepIndex : null };
  for (const k of TELEMETRY_NUMBERS) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k])) row[k] = src[k];
  }
  for (const k of TELEMETRY_STRINGS) {
    if (typeof src[k] === 'string' && src[k]) row[k] = TELEMETRY_STRING_MAX[k] ? src[k].slice(-TELEMETRY_STRING_MAX[k]) : src[k];
  }
  for (const k of TELEMETRY_FLAGS) {
    if (src[k] === true) row[k] = true;
  }
  const usage = {};
  if (isPlainObject(src.usage)) {
    for (const [k, v] of Object.entries(src.usage)) {
      if (typeof v === 'number' && Number.isFinite(v)) usage[k] = v;
    }
  }
  row.usage = Object.freeze(usage);
  return Object.freeze(row);
}

/**
 * WHAT THIS RUN SPENT, summed over every juror it spawned. PURE.
 *
 * The answer to "what did that juror cost?" after a live run — unanswerable after #3035's FIRST live run
 * (PR #1146), because the adapter discarded everything `judgeSpawn` returned except the answer.
 *
 * @param {object} run
 * @returns {{jurors: number, costUsd: number, wallMs: number, durationMs: number}}
 */
export function totalJudgeSpend(run) {
  const rows = Array.isArray(run?.telemetry) ? run.telemetry : [];
  const sum = (k) => rows.reduce((n, r) => n + (typeof r?.[k] === 'number' ? r[k] : 0), 0);
  return { jurors: rows.length, costUsd: sum('costUsd'), wallMs: sum('wallMs'), durationMs: sum('durationMs') };
}

/**
 * EXTRACT TOKEN COUNTERS from a telemetry row's `usage` block (#3521). PURE.
 *
 * Reads both CLI-native counters (`cache_read_input_tokens`, `cache_creation_input_tokens`,
 * `input_tokens`) and short-form variants (`cache_read`, `cache_creation`, `input`).
 * Non-numeric entries degrade to 0.
 *
 * @param {object} [usage]
 * @returns {{cacheRead: number, cacheCreation: number, input: number, loaded: number}}
 */
export function extractUsageCounters(usage = {}) {
  const readVal = usage?.cache_read_input_tokens ?? usage?.cache_read;
  const writeVal = usage?.cache_creation_input_tokens ?? usage?.cache_creation;
  const inputVal = usage?.input_tokens ?? usage?.input;
  const cacheRead = typeof readVal === 'number' && Number.isFinite(readVal) && readVal >= 0 ? readVal : 0;
  const cacheCreation = typeof writeVal === 'number' && Number.isFinite(writeVal) && writeVal >= 0 ? writeVal : 0;
  const input = typeof inputVal === 'number' && Number.isFinite(inputVal) && inputVal >= 0 ? inputVal : 0;
  const loaded = cacheRead + cacheCreation + input;
  return { cacheRead, cacheCreation, input, loaded };
}

/**
 * DERIVE CACHE HIT METRICS for a single usage block (#3521). PURE.
 *
 *   hit rate = cache_read / (cache_read + cache_creation + input)
 *   reads-per-write = cache_read / cache_creation
 *
 * Both ratios return `null` when their denominator is 0.
 *
 * @param {object} [usage]
 * @returns {{cacheRead: number, cacheCreation: number, input: number, loaded: number, hitRate: number|null, readsPerWrite: number|null}}
 */
export function deriveCacheHitMetrics(usage = {}) {
  const counters = extractUsageCounters(usage);
  const { cacheRead, cacheCreation, loaded } = counters;
  return {
    ...counters,
    hitRate: loaded > 0 ? cacheRead / loaded : null,
    readsPerWrite: cacheCreation > 0 ? cacheRead / cacheCreation : null,
  };
}

/**
 * DERIVE THE INVOCATION ROLE from a telemetry row and optional enclosing run record (#3521). PURE.
 *
 * Precedence: `row.role` → `row.lens` → `row.step` → `run.op` → `'unknown'`.
 *
 * @param {object} [row] - telemetry row.
 * @param {object} [run] - enclosing run record.
 * @returns {string} role identifier.
 */
export function extractInvocationRole(row, run = null) {
  if (typeof row?.role === 'string' && row.role.trim()) return row.role.trim();
  if (typeof row?.lens === 'string' && row.lens.trim()) return row.lens.trim();
  if (typeof row?.step === 'string' && row.step.trim()) return row.step.trim();
  if (typeof run?.op === 'string' && run.op.trim()) return run.op.trim();
  return 'unknown';
}

/**
 * AGGREGATE CACHE METRICS PER ROLE across one or more run records (#3521). PURE.
 *
 * Groups telemetry rows by role, summing cache read, cache creation, fresh input, and loaded context tokens.
 *
 * SURFACES ZERO HIT RATE ACROSS REPEATED SAME-ROLE INVOCATIONS (#3521 Done-when #2):
 * A role with 2 or more zero-cache-read invocations across all aggregated runs has `zeroHitAlert: true`.
 * Runs with 2 or more zero-cache-read invocations are recorded in `zeroHitRuns`.
 * This prevents zero hit rates on repeated invocations from being silently averaged away into
 * a misleadingly non-zero aggregate across runs, even when spread across multiple separate run records.
 *
 * @param {object|object[]} runs - one or more run records.
 * @returns {Array<{role: string, invocations: number, cacheReadTokens: number, cacheCreationTokens: number, inputTokens: number, loadedContextTokens: number, hitRate: number|null, readsPerWrite: number|null, zeroHitInvocations: number, zeroHitAlert: boolean, zeroHitRuns: Array<{runId: string, invocations: number}>}>}
 */
export function aggregateRoleCacheMetrics(runs) {
  const list = Array.isArray(runs) ? runs : (runs && typeof runs === 'object' ? [runs] : []);
  const byRole = new Map();

  for (const run of list) {
    if (!run || typeof run !== 'object') continue;
    const telemetryRows = Array.isArray(run.telemetry) ? run.telemetry : [];
    const runRoleMap = new Map();

    for (const row of telemetryRows) {
      if (!row || typeof row !== 'object') continue;
      if (!row.usage || typeof row.usage !== 'object') continue;

      const u = extractUsageCounters(row.usage);
      const role = extractInvocationRole(row, run);

      let roleEntry = byRole.get(role);
      if (!roleEntry) {
        roleEntry = {
          role,
          invocations: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          inputTokens: 0,
          loadedContextTokens: 0,
          zeroHitInvocations: 0,
          zeroHitRuns: [],
        };
        byRole.set(role, roleEntry);
      }

      roleEntry.invocations += 1;
      roleEntry.cacheReadTokens += u.cacheRead;
      roleEntry.cacheCreationTokens += u.cacheCreation;
      roleEntry.inputTokens += u.input;
      roleEntry.loadedContextTokens += u.loaded;
      if (u.cacheRead === 0) {
        roleEntry.zeroHitInvocations += 1;
      }

      let runRoleStats = runRoleMap.get(role);
      if (!runRoleStats) {
        runRoleStats = { invocations: 0, cacheReadTokens: 0, runId: run.id ?? 'unknown' };
        runRoleMap.set(role, runRoleStats);
      }
      runRoleStats.invocations += 1;
      runRoleStats.cacheReadTokens += u.cacheRead;
    }

    for (const [role, stats] of runRoleMap.entries()) {
      if (stats.invocations >= 2 && stats.cacheReadTokens === 0) {
        const roleEntry = byRole.get(role);
        if (roleEntry) {
          roleEntry.zeroHitRuns.push({
            runId: stats.runId,
            invocations: stats.invocations,
          });
        }
      }
    }
  }

  const results = [];
  for (const entry of byRole.values()) {
    const hitRate = entry.loadedContextTokens > 0
      ? entry.cacheReadTokens / entry.loadedContextTokens
      : null;
    const readsPerWrite = entry.cacheCreationTokens > 0
      ? entry.cacheReadTokens / entry.cacheCreationTokens
      : null;

    const zeroHitAlert = entry.zeroHitInvocations >= 2;

    results.push({
      role: entry.role,
      invocations: entry.invocations,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      inputTokens: entry.inputTokens,
      loadedContextTokens: entry.loadedContextTokens,
      hitRate: hitRate !== null ? Number(hitRate.toFixed(4)) : null,
      readsPerWrite: readsPerWrite !== null ? Number(readsPerWrite.toFixed(2)) : null,
      zeroHitInvocations: entry.zeroHitInvocations,
      zeroHitAlert,
      zeroHitRuns: entry.zeroHitRuns,
    });
  }

  return results.sort((a, b) => a.role.localeCompare(b.role));
}


/**
 * ONE stepTimings ROW, whitelisted the way {@link normalizeJudgeTelemetry} whitelists `telemetry` (#3368).
 * `stepTimings` answers "how long did this STEP take", a different question from "what did a judge SPAWN
 * cost" — see `withTelemetry`'s refusal in `engine.mjs`, which is exactly why this is its own field with its
 * own whitelist rather than a wider `telemetry`.
 *
 * @param {{step: string, stepIndex: number, startedAt: string, finishedAt?: string, durationMs?: number}} o
 * @returns {object} a frozen row.
 */
function normalizeStepTimingRow({ step, stepIndex, startedAt, finishedAt, durationMs } = {}) {
  if (typeof step !== 'string' || !step.trim()) {
    throw new TypeError('operations: a stepTimings row needs a `step` name');
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new TypeError('operations: a stepTimings row needs a non-negative integer `stepIndex`');
  }
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) {
    throw new TypeError(`operations: a stepTimings row needs a parseable \`startedAt\` — got ${JSON.stringify(startedAt)}`);
  }
  const row = { step, stepIndex, startedAt };
  if (finishedAt !== undefined && finishedAt !== null) {
    if (typeof finishedAt !== 'string' || Number.isNaN(Date.parse(finishedAt))) {
      throw new TypeError(`operations: a stepTimings row \`finishedAt\` must be a parseable string — got ${JSON.stringify(finishedAt)}`);
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new TypeError(`operations: a finished stepTimings row needs a non-negative \`durationMs\` — got ${JSON.stringify(durationMs)}`);
    }
    row.finishedAt = finishedAt;
    row.durationMs = durationMs;
  }
  return Object.freeze(row);
}

/**
 * STAMP A STEP'S START. PURE — `at` is a clock reading the CALLER took; this function never reads a clock
 * (#3368: the engine's purity contract at `engine.mjs:45` forbids that for the engine, and this helper holds
 * the same line so the io shell stays the only place `Date.now()`/`new Date()` appears).
 *
 * IDEMPOTENT per `stepIndex` — called again for a step that already has an OPEN (unfinished) row returns
 * `run` unchanged, so a caller re-entering the same suspended step (an `awaiting-judge`/`awaiting-confirm`
 * poll, a resumed process) cannot double-stamp it.
 *
 * @param {object} run
 * @param {{step: string, stepIndex: number, at: string}} o
 * @returns {object}
 */
export function withStepStart(run, { step, stepIndex, at } = {}) {
  const timings = Array.isArray(run.stepTimings) ? run.stepTimings : [];
  if (timings.some((t) => t.stepIndex === stepIndex && t.finishedAt === undefined)) return run;
  const row = normalizeStepTimingRow({ step, stepIndex, startedAt: at });
  return { ...run, stepTimings: [...timings, row] };
}

/**
 * STAMP A STEP'S FINISH, on the open row {@link withStepStart} left for it. PURE, same clock-injection
 * discipline as `withStepStart`.
 *
 * A `stepIndex` with NO open row — never started, or already finished — returns `run` UNCHANGED rather than
 * fabricating one: a run halted mid-step must show a started step with NO finish, never an invented one
 * (#3368, Done-when #1).
 *
 * @param {object} run
 * @param {{stepIndex: number, at: string}} o
 * @returns {object}
 */
export function withStepFinish(run, { stepIndex, at } = {}) {
  const timings = Array.isArray(run.stepTimings) ? run.stepTimings : [];
  const i = timings.findIndex((t) => t.stepIndex === stepIndex && t.finishedAt === undefined);
  if (i === -1) return run;
  const row = timings[i];
  const durationMs = Math.max(0, Date.parse(at) - Date.parse(row.startedAt));
  const next = normalizeStepTimingRow({ step: row.step, stepIndex: row.stepIndex, startedAt: row.startedAt, finishedAt: at, durationMs });
  return { ...run, stepTimings: [...timings.slice(0, i), next, ...timings.slice(i + 1)] };
}

/**
 * Structural validation of a run record. Used by every reader and by `advance`, so a malformed record can
 * never be stepped.
 *
 * @param {*} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRunRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { ok: false, errors: ['run record must be an object'] };
  if (record.v !== RUN_RECORD_VERSION) {
    errors.push(`unsupported run record version ${JSON.stringify(record.v)} (this build reads v${RUN_RECORD_VERSION})`);
  }
  if (!isValidRunId(record.id)) errors.push(`invalid run id ${JSON.stringify(record.id)}`);
  if (typeof record.op !== 'string' || !record.op.trim()) errors.push('missing operation name');
  if (!isPlainObject(record.input)) errors.push('`input` must be an object');
  if (!Number.isInteger(record.cursor) || record.cursor < 0) errors.push('`cursor` must be a non-negative integer');
  if (!isPlainObject(record.findings)) errors.push('`findings` must be an object');
  if (!Array.isArray(record.effects)) {
    errors.push('`effects` must be an array');
  } else {
    record.effects.forEach((e, i) => {
      if (!isPlainObject(e)) { errors.push(`effects[${i}] must be an object`); return; }
      if (typeof e.key !== 'string' || !e.key) errors.push(`effects[${i}] has no key`);
      if (typeof e.type !== 'string' || !e.type) errors.push(`effects[${i}] has no type`);
      if (!Number.isInteger(e.stepIndex) || e.stepIndex < 0) errors.push(`effects[${i}] has an invalid stepIndex`);
      if (!Number.isInteger(e.index) || e.index < 0) errors.push(`effects[${i}] has an invalid index`);
      if (!EFFECT_STATUSES.includes(e.status)) {
        errors.push(`effects[${i}] has status ${JSON.stringify(e.status)}; expected one of ${EFFECT_STATUSES.join('|')}`);
      }
      // THE FIELDS `in-flight` DEPENDS ON (#3073; PR #1180 review, finding 4). Adding the status to the enum
      // without checking its payload lets a hand-built or truncated record claim a state the executor's rules
      // are keyed on. `handle` decides refuse-vs-resume on replay and `expectedBy` decides running-vs-overdue,
      // so a malformed one is not a cosmetic defect — it is a wrong answer to both questions.
      //
      // `handle` may be null (a dispatch that lost it before reporting) but never a non-string, and never
      // blank. `''` is falsy, so it would read as "no handle" while looking like one — but the WORSE case is
      // whitespace, which is TRUTHY: it passed the first cut of this check, was bucketed `running`, and the
      // driver parked forever telling the operator to poll a blank handle (PR #1180 review, finding 3).
      // `inFlight()` trims, so the validator was looser than the constructor it backstops. `expectedBy`
      // is optional and, when present, must actually parse; an unparseable date makes every entry read as
      // never-overdue, which is the failure that hides a stalled job.
      if (e.status === 'in-flight') {
        if (!(e.handle === null || e.handle === undefined || (typeof e.handle === 'string' && isPollableHandle(e.handle)))) {
          errors.push(`effects[${i}] is in-flight with an invalid handle ${JSON.stringify(e.handle)} — a string or null`);
        }
        if (e.expectedBy != null && !(typeof e.expectedBy === 'string' && !Number.isNaN(Date.parse(e.expectedBy)))) {
          errors.push(`effects[${i}] is in-flight with an unparseable expectedBy ${JSON.stringify(e.expectedBy)}`);
        }
        if (e.startedAt != null && !(typeof e.startedAt === 'string' && !Number.isNaN(Date.parse(e.startedAt)))) {
          errors.push(`effects[${i}] is in-flight with an unparseable startedAt ${JSON.stringify(e.startedAt)}`);
        }
      }
    });
    const keys = new Set();
    for (const e of record.effects) {
      if (isPlainObject(e) && typeof e.key === 'string') {
        if (keys.has(e.key)) errors.push(`duplicate effect key ${JSON.stringify(e.key)} — the idempotency key must be unique within a run`);
        keys.add(e.key);
      }
    }
  }
  // TOLERATED WHEN ABSENT, and deliberately not a version bump: `telemetry` was added after v1 shipped, and a
  // record written by the previous build simply has no key. Refusing those would wedge a run mid-flight (the
  // records are session-local, but a `--resume` across the upgrade is exactly the case the store exists for)
  // for a field nothing decides on. Present-but-wrong-shape IS refused — that is a live caller's bug.
  if (record.telemetry !== undefined) {
    if (!Array.isArray(record.telemetry)) errors.push('`telemetry` must be an array when present');
    else record.telemetry.forEach((t, i) => { if (!isPlainObject(t)) errors.push(`telemetry[${i}] must be an object`); });
  }
  // SAME TOLERANCE, SAME REASON, DISTINCT FIELD (#3368) — `stepTimings` postdates v1 exactly like `telemetry`
  // did, and the two must not be conflated: one is juror spend, the other is step wall-clock.
  if (record.stepTimings !== undefined) {
    if (!Array.isArray(record.stepTimings)) {
      errors.push('`stepTimings` must be an array when present');
    } else {
      record.stepTimings.forEach((t, i) => {
        if (!isPlainObject(t)) { errors.push(`stepTimings[${i}] must be an object`); return; }
        if (typeof t.step !== 'string' || !t.step) errors.push(`stepTimings[${i}] has no step name`);
        if (!Number.isInteger(t.stepIndex) || t.stepIndex < 0) errors.push(`stepTimings[${i}] has an invalid stepIndex`);
        if (typeof t.startedAt !== 'string' || Number.isNaN(Date.parse(t.startedAt))) {
          errors.push(`stepTimings[${i}] has an unparseable startedAt ${JSON.stringify(t.startedAt)}`);
        }
        if (t.finishedAt !== undefined) {
          if (typeof t.finishedAt !== 'string' || Number.isNaN(Date.parse(t.finishedAt))) {
            errors.push(`stepTimings[${i}] has an unparseable finishedAt ${JSON.stringify(t.finishedAt)}`);
          }
          if (typeof t.durationMs !== 'number' || !Number.isFinite(t.durationMs) || t.durationMs < 0) {
            errors.push(`stepTimings[${i}] has an invalid durationMs ${JSON.stringify(t.durationMs)}`);
          }
        }
      });
    }
  }
  // SAVED SEAT ANSWERS (held item 223) — the answers of juror seats that ran beside a seat that failed, kept so a
  // resume commits them instead of paying for them again (`we:scripts/operations/cli-adapter.mjs#driveRun`).
  // Tolerated when absent; each entry must name its step, since that is what a resume matches it by.
  if (record.prefilledSeats !== undefined) {
    if (!Array.isArray(record.prefilledSeats)) {
      errors.push('`prefilledSeats` must be an array when present');
    } else {
      record.prefilledSeats.forEach((p, i) => {
        if (!isPlainObject(p)) { errors.push(`prefilledSeats[${i}] must be an object`); return; }
        if (typeof p.step !== 'string' || !p.step) errors.push(`prefilledSeats[${i}] has no step name`);
        if (!Number.isInteger(p.stepIndex) || p.stepIndex < 0) errors.push(`prefilledSeats[${i}] has an invalid stepIndex`);
      });
    }
  }
  // THE JOB BLOCK (#4125, statute #daemon-jobs) — a job is a run record with `op: job:<kind>` and a `job`
  // block. Tolerated when absent (every non-job run); validated when present, and required on a `job:` op so
  // a record claiming to be a job can never be read without the fields reattach decides on.
  if (record.job !== undefined || (typeof record.op === 'string' && record.op.startsWith(JOB_OP_PREFIX))) {
    for (const e of validateJobBlock(record.job)) errors.push(e);
  }
  if (record.pending !== null && !isPlainObject(record.pending)) {
    errors.push('`pending` must be null or an object');
  } else if (isPlainObject(record.pending)) {
    if (typeof record.pending.kind !== 'string') errors.push('`pending.kind` must be a string');
    if (typeof record.pending.step !== 'string') errors.push('`pending.step` must be the step name');
    if (!Number.isInteger(record.pending.stepIndex)) errors.push('`pending.stepIndex` must be an integer');
  }
  return { ok: errors.length === 0, errors };
}

/** {@link validateRunRecord} as an assertion. Throws carrying EVERY error, not just the first. */
export function assertRunRecord(record, context = 'run record') {
  const { ok, errors } = validateRunRecord(record);
  if (!ok) throw new Error(`operations: ${context} is invalid — ${errors.join('; ')}`);
  return record;
}

/**
 * Parse run-record text. NEVER throws, and NEVER degrades a corrupt record to "absent".
 *
 * FAIL-CLOSED, AND THE ONE PLACE THIS STORE DIVERGES FROM `queue-store.mjs`. `parseQueue` is tolerant by
 * design — a corrupt clear-for-build queue degrades to `[]` so a dispatch tick is never wedged, and the
 * worst cost is a missed dispatch. A corrupt RUN record is the opposite hazard: read as absent, it would
 * restart a run whose effects may already be half-applied. So a corrupt record is reported as corrupt and
 * every reader REFUSES — the `we:scripts/lib/lane-verify.mjs` precedent (#2833: a marker that exists but
 * does not parse is refused, never read as absent and failed open) applied to run state.
 *
 * @param {string|null|undefined} text
 * @returns {{ok: true, record: object} | {ok: false, corrupt: true, reason: string}}
 */
export function parseRunRecord(text) {
  if (text == null || !String(text).trim()) {
    return { ok: false, corrupt: true, reason: 'the run record is empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, corrupt: true, reason: `the run record is not parseable JSON (${e.message})` };
  }
  const { ok, errors } = validateRunRecord(parsed);
  if (!ok) return { ok: false, corrupt: true, reason: errors.join('; ') };
  return { ok: true, record: parsed };
}

/**
 * THE IDEMPOTENCY KEY of one declared effect.
 *
 * The statute and #3032's card both say "keyed by run + step", and the key below is that key **plus the
 * effect's ordinal within its step** — because a single `effect` step declares a LIST. #2964's defect is
 * exactly a two-effect step (post the verdict comment, then swap the label) whose first half landed and
 * whose second did not; a step-granular key cannot tell those two apart on replay, and would either
 * re-post the comment or skip the label. The ordinal is what makes the replay of a PARTIAL failure exact.
 *
 * @param {string} runId
 * @param {number} stepIndex - the effect step's position in the declaration.
 * @param {number} index - the effect's position in that step's declared list.
 * @returns {string}
 */
export function effectKey(runId, stepIndex, index) {
  return `${runId}#${stepIndex}#${index}`;
}

/** Serialize a run record to its on-disk text (pretty JSON, newline-terminated). */
export function serializeRunRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}
