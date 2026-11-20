/**
 * @file scripts/lib/lane-concurrency.mjs
 * @description THE LANE-DISPATCH CONCURRENCY CEILING (#xupukxa) — a single conservative, hardware-blind cap on
 *   how many lanes/claude sessions may be dispatched at once, shared by
 *   `we:scripts/readiness/dispatch-plan.mjs` (build launches) and `we:scripts/conveyor/tick-core.mjs`
 *   (prepare-scope, prepare-decision, fix, and ci-heal spawns), so the two independent lane-consuming
 *   decisions never sum past one ceiling. ONE resolver + ONE trim function, imported by both, so the cap can
 *   never drift between the two call sites.
 *
 * WHY THIS IS A SEPARATE, NEW ADMISSION POINT FROM `we:scripts/readiness/heavy-admission.mjs` (#3461/#3456).
 *   `heavy-admission.mjs` caps concurrent HEAVY COMMANDS (`verify-lane`/`check:standards`/the visual-capture
 *   pass) that run INSIDE an already-dispatched lane — it never gates whether a lane is dispatched at all.
 *   Confirmed live 2026-09-07: freeing one lane cascaded `dispatch-plan.mjs` + `tick-core.mjs` into launching
 *   42 concurrent lanes in ONE tick (19 builds + 23 prepare-scope), each its own `claude -p` process, with zero
 *   shared budget between the two — driving the host's 1-minute load average to 34.95 on the primary
 *   host. Neither module had, or has via heavy-admission, any concept of "how many lanes total may run
 *   right now" — this module is that missing ceiling, upstream of heavy-admission entirely.
 *
 * DELIBERATELY NOT THE FULL HARDWARE-USAGE-AWARE PROJECT (`xc1idt1`/`xhvpyxb`/`xqraqab`, staged in PR #1998,
 * not yet landed). That project is a real CPU/memory-sampling, eventually-adaptive cap on
 * `heavy-admission.mjs`'s per-command semaphore — a different layer, and its own fork (`xqraqab`) is not yet
 * prepared to Definition-of-Ready. This module is a fixed, conservative, config-knob constant instead — the
 * safe floor that is correct regardless of how that fuller, still-unprepared decision eventually resolves,
 * following the SAME env-var-configurable convention `heavy-admission.mjs` already established
 * (`WE_HEAVY_ADMISSION_CAP`).
 *
 * DEFAULT — 12. lanes.maxConcurrent resolves a valid operator override above the minimum env/file/built-in cap.
 * Integer bounds are 1..24. Invalid evidence keeps the stricter lower/built-in cap.
 *
 * The resolver rereads settings on every call; capToConcurrency remains pure.
 */

import { resolveCapacityLeaf } from './policy-cascade.mjs';

/** Built-in concurrent-lane cap. */
export const DEFAULT_MAX_CONCURRENT_LANES = 12;

/** The env var a machine overrides the default with (mirrors `WE_HEAVY_ADMISSION_CAP`). */
export const MAX_CONCURRENT_LANES_ENV = 'WE_MAX_CONCURRENT_LANES';

/**
 * Resolve the concurrent-lane cap through the bounded capacity cascade. Fractions floor conservatively;
 * invalid evidence cannot raise the lower/file bound above the built-in.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveMaxConcurrentLanes(env = process.env) {
  const e = env?.[MAX_CONCURRENT_LANES_ENV];
  return resolveCapacityLeaf('lanes.maxConcurrent', { env,
    envValue: typeof e === 'string' && e.trim() ? Number(e) : undefined }).value;
}

/**
 * Trim a list of free lane ids down to the ROOM actually left under the concurrency ceiling, given how many
 * lanes are already spoken for. Pure — used identically by `dispatch-plan.mjs` (against its `leases` count) and
 * `tick-core.mjs` (against `state.lanes` count PLUS the same tick's own already-admitted build launches, so
 * builds and prepare/fix/ci-heal spawns share one budget rather than each independently maxing out).
 * @param {Array<*>} freeLanes         the candidate free lane ids, in assignment order
 * @param {{ activeCount:number, cap:number }} budget
 * @returns {{ admitted:Array<*>, overflow:Array<*> }}  `admitted` — the front slice within budget, in the same
 *   order given; `overflow` — the rest, so a caller can hold them with its own distinct reason (never silently
 *   drop them — see `dispatch-plan.mjs`'s `capacity-cap` held reason and `tick-core.mjs`'s `capacity-cap` note).
 */
export function capToConcurrency(freeLanes, { activeCount = 0, cap = DEFAULT_MAX_CONCURRENT_LANES } = {}) {
  const room = Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(activeCount) || 0));
  const list = Array.isArray(freeLanes) ? freeLanes : [];
  return { admitted: list.slice(0, room), overflow: list.slice(room) };
}
