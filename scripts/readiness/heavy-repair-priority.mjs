/**
 * @file scripts/readiness/heavy-repair-priority.mjs
 * @description The red-main repair class of the heavy-admission queue (main-fix-queue-priority): which waiter is a
 *   red-main repair (P0) and so takes the next free slot ahead of every other waiter.
 *
 *   Kept OUT of `./heavy-queue-projection.mjs` on purpose. That module is imported by the read-only `heavy-queue`
 *   operation's declaring module, and `http-adapter.test.mjs` pins that such a module's whole static import graph
 *   reaches nothing but relative specifiers. Bounded pattern matching needs `node:vm` (a wall-clock timeout V8 enforces
 *   inside regexp backtracking), so it lives here; only the admission IO shell (`./heavy-admission.mjs`) imports it.
 */
import vm from 'node:vm';
import { deliveryPriority, PRIORITY_CLASSES } from '../lib/delivery-priority.mjs';

/** The standard repair patterns, matched against a waiter's lane purpose, session and holder slug:
 *  `main-fix-<sha>` (`main-ci-red-core.mjs#ownerSessionSlug`, and its `-lane-N-<id>` holder slug),
 *  `main-fix-combine-<pr>`, and `revert-red-<sha|pr>`. Anchored on a sha / PR number so an ordinary lane that merely
 *  starts with `main-fix-` or `revert-red-` (e.g. `main-fix-queue-priority`, `revert-red-check`) stays normal. */
export const DEFAULT_REPAIR_PATTERNS = Object.freeze([
  '^main-fix-[0-9a-f]{7,40}(?:-lane-\\d+-[0-9a-f]+)?$',
  '^main-fix-combine-\\d+(?:-lane-\\d+-[0-9a-f]+)?$',
  '^revert-red-(?:[0-9a-f]{7,40}|\\d+)(?:-lane-\\d+-[0-9a-f]+)?$',
]);
export const ADMISSION_PRIORITY_MODES = Object.freeze(['enforce', 'off']);
const IDENTITY_FIELDS = ['purpose', 'session', 'holder', 'envSession'];

/** Resource bounds on operator-set repair patterns. They run on the admission path BEFORE the queue and ceiling checks,
 *  so one catastrophic pattern would stall the caller for good (a synchronous RegExp cannot be interrupted from JS):
 *  a pattern is length-capped and must not nest a repeat inside a repeat, an identity value longer than a slug is
 *  never matched, and every match runs under a hard wall-clock bound ({@link repairPatternMatches}). */
export const MAX_REPAIR_PATTERN_LENGTH = 200;
export const MAX_REPAIR_MATCH_VALUE_LENGTH = 256;
export const REPAIR_MATCH_TIMEOUT_MS = 50;
/** At most this many patterns; matching across every pattern x field has this budget, starting after validation. */
export const MAX_REPAIR_PATTERNS = 16;
export const REPAIR_CLASSIFY_BUDGET_MS = 150;

/** True when `src` repeats a group that already contains a repeat (`(a+)+`, `([a-z]+)*`, `(?:a{1,5}){2,}`) — the
 *  exponential-backtracking shape — or uses a backreference. A conservative scan, not a regex parser; the hard time
 *  bound in {@link repairPatternMatches} covers what it cannot see (overlapping alternation such as `(a|aa)+`). Pure. */
function hasUnsafeRepeat(src) {
  const n = src.length;
  const groups = [false]; // per open group: does it contain a repeat?
  let prevGroupRepeats = false; // the atom just closed is a group that contains a repeat
  let i = 0;
  while (i < n) {
    const c = src[i];
    let repeat = false;
    let step = 1;
    let closedRepeats = false;
    if (c === '\\') {
      if (/[1-9k]/.test(src[i + 1] ?? '')) return true; // backreference
      step = 2;
    } else if (c === '[') {
      let j = i + 1;
      while (j < n && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
      step = j + 1 - i;
    } else if (c === '(') groups.push(false);
    else if (c === ')') { if (groups.length > 1) closedRepeats = groups.pop(); if (closedRepeats) groups[groups.length - 1] = true; }
    else if (c === '*' || c === '+') repeat = true;
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i, i + 24));
      if (m) { step = m[0].length; repeat = m[2] ? (m[3] === '' || Number(m[3]) > 1) : Number(m[1]) > 1; }
    }
    if (repeat) {
      if (prevGroupRepeats) return true;
      groups[groups.length - 1] = true;
    }
    prevGroupRepeats = c === ')' && closedRepeats;
    i += step;
  }
  return false;
}

/**
 * Operator selections must be provably contained in the built-in repair language: exact built-in expressions,
 * or fully anchored literal slugs that themselves match a built-in family. No general regex containment is
 * attempted. Empty arrays disable matching; one invalid entry rejects the entire layer. Resource and unsafe
 * repeat checks remain independent bounds if this grammar is extended later. Pure.
 */
export function validRepairPatterns(v) {
  if (!Array.isArray(v) || v.length > MAX_REPAIR_PATTERNS) return false;
  for (const p of v) {
    if (typeof p !== 'string' || p === '' || p.length > MAX_REPAIR_PATTERN_LENGTH) return false;
    try { new RegExp(p); } catch { return false; }
    if (hasUnsafeRepeat(p)) return false;
    if (!DEFAULT_REPAIR_PATTERNS.includes(p)) {
      const literal = p.slice(1, -1);
      // Explicit endpoints and forbidden-character scan avoid '$' accepting a trailing newline.
      if (p[0] !== '^' || !p.endsWith('$') || !literal || /[^a-z0-9-]/.test(literal)) return false;
      if (!DEFAULT_REPAIR_PATTERNS.some((standard) => new RegExp(standard).test(literal))) return false;
    }
  }
  return true;
}

let repairMatchSandbox = null;
/** Patterns that have blown the time bound in this process; they are skipped from then on (a poisoned pattern is
 *  treated as not matching, which is the safe direction: the waiter stays normal class P3). */
const timedOutRepairPatterns = new Set();

/**
 * Does `pattern` match `value`? Bounded: the test runs in a `node:vm` script with a wall-clock `timeout`, which V8
 * enforces inside regexp backtracking, so a pattern that gets past {@link validRepairPatterns} still cannot stall the
 * caller. A timeout, an invalid pattern or an over-long value is "no match". Pure apart from the poisoned-pattern memo.
 */
export function repairPatternMatches(pattern, value, deadlineMs = Infinity) {
  if (typeof pattern !== 'string' || typeof value !== 'string' || value.length > MAX_REPAIR_MATCH_VALUE_LENGTH) return false;
  if (timedOutRepairPatterns.has(pattern)) return false;
  const budgetMs = Math.min(REPAIR_MATCH_TIMEOUT_MS, Math.floor(deadlineMs - Date.now()));
  if (!(budgetMs >= 1)) return false; // the whole classification's time budget is spent: the rest cannot match
  repairMatchSandbox ??= { context: vm.createContext(Object.create(null)), script: new vm.Script('new RegExp(__pattern).test(__value)') };
  const { context, script } = repairMatchSandbox;
  context.__pattern = pattern;
  context.__value = value;
  try {
    return script.runInContext(context, { timeout: budgetMs }) === true;
  } catch (err) {
    // The standard patterns are never poisoned: a timeout on a loaded host must not strip a real repair of P0.
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' && budgetMs >= REPAIR_MATCH_TIMEOUT_MS && !DEFAULT_REPAIR_PATTERNS.includes(pattern)) timedOutRepairPatterns.add(pattern);
    return false;
  }
}

/**
 * The admission class of one waiter. PURE. A red-main repair — any identity field matching a repair pattern — is
 * classed by the delivery-priority rule as the owner of the open main-red episode's fix (P0); a matching
 * send-back fixer is P1, and everything else is P3 (normal). Mode `off` makes every waiter P3 (today's FCFS).
 * @param {{purpose?:string|null, session?:string|null, holder?:string|null, envSession?:string|null}} identity
 * @param {{mode:'enforce'|'off', repairPatterns:string[]}} priority
 * @param {{sendBackFixes?:Array<{session:string, pr:number, repo:string, freshness:string}>}} evidence
 * @returns {{class:string, reason:string, matched:{field:string, value:string, pattern:string}|null}}
 */
export function classifyWaiterPriority(identity, priority, { sendBackFixes = [] } = {}) {
  const normal = (reason) => ({ class: 'P3', reason, matched: null });
  if (priority?.mode !== 'enforce') return normal('priority off');
  const patterns = validRepairPatterns(priority.repairPatterns) ? priority.repairPatterns : DEFAULT_REPAIR_PATTERNS;
  const deadlineMs = Date.now() + REPAIR_CLASSIFY_BUDGET_MS;
  for (const field of IDENTITY_FIELDS) {
    const value = identity?.[field];
    if (typeof value !== 'string' || value === '') continue;
    const pattern = patterns.find((p) => repairPatternMatches(p, value, deadlineMs));
    if (pattern === undefined) continue;
    const d = deliveryPriority({ incident: { open: true, owner: true } }, { mode: 'enforce' }, 0);
    return { class: d.class, reason: `red-main repair: ${d.reasons.join('; ')}`, matched: { field, value, pattern } };
  }
  for (const field of IDENTITY_FIELDS) {
    const value = identity?.[field];
    if (typeof value !== 'string' || value.length > MAX_REPAIR_MATCH_VALUE_LENGTH) continue;
    const row = sendBackFixes.find(row => value === row.session
      || (value.startsWith(`${row.session}-lane-`) && /^\d+-[a-z0-9]+$/.test(value.slice(row.session.length + 6))));
    if (row) return { class: 'P1', reason: `send-back fix #${row.pr} (${row.repo}; ${row.freshness})`,
      matched: { field, value, pattern: row.session } };
  }
  return normal('normal');
}

/** A waiting marker's class: its recorded `priority` when it is a known class, else P3. Pure. */
export function waiterPriorityClass(marker) {
  return PRIORITY_CLASSES.includes(marker?.priority) ? marker.priority : 'P3';
}
