/**
 * @file scripts/lib/fixer-escalation-policy.mjs
 * @description THE FIXER-ESCALATION LADDER for a finding the operator already ruled `block` that keeps coming back
 *   (`we:scripts/lib/ruling-ledger.mjs`). Live 2026-10-04, PR #3833: the regular fixer (Sonnet) twice failed to
 *   address the operator's block rulings and the orchestrator handed it to an Opus agent by hand. The hand-over is
 *   now the second rung of a configured ladder, not a manual step.
 *
 * CONFIG EXTENDS THE PLATFORM DEFAULT. {@link DEFAULT_FIXER_ESCALATION} is the platform default; a local override
 * (`~/workspace/.operations/fixer-escalation.json`, outside every checkout so a daemon rebuild never loses it) is
 * merged ON TOP of it by rung id: change a rung's fields, disable a rung, or add one. An invalid override is
 * reported and ignored (the default stands), never half-applied.
 *
 * RUNG = a miss count (`at`: how many heads the finding has come back on after the ruling) and an action:
 *   - `dispatch`: send it to a fixer. `taskType` names the routing-policy route that picks the MODEL
 *     (`we:scripts/lib/dispatch-routing-policy.json` → `operations["fix:<taskType>"]`; a null taskType is the
 *     ordinary `fix` route). The model is therefore decided by the existing per-operation routing policy, never
 *     hand-set per PR. `provider` is the provider the rung needs; a rung whose route resolves to another provider
 *     (the critical-work gate keeps `fix` on Claude) or whose provider has no wired fix launcher is UNAVAILABLE
 *     and the ladder moves on to the next rung. `instruction: 'test-first'` tells the fixer to write a failing test
 *     for each finding before touching code.
 *   - `needs-you`: stop. A person (or, later, an arbiter) settles the fixer-versus-reviewer disagreement.
 * PURE.
 */

export const TEST_FIRST_INSTRUCTION = 'test-first';
const ACTIONS = ['dispatch', 'needs-you'];
const PROVIDERS = ['claude', 'codex'];

/** Platform default. Miss 1 resends to the same fixer; miss 2 goes to a stronger model, test first; miss 3 goes
 *  cross-provider if that is available; after that the operator decides. */
export const DEFAULT_FIXER_ESCALATION = Object.freeze({
  version: 1,
  rungs: Object.freeze([
    Object.freeze({ id: 'resend', at: 1, action: 'dispatch', taskType: null, provider: 'claude', instruction: null,
      label: 'resent to the same fixer with the ruling attached' }),
    Object.freeze({ id: 'stronger-model', at: 2, action: 'dispatch', taskType: 'ruling-escalation-stronger', provider: 'claude',
      instruction: TEST_FIRST_INSTRUCTION, label: 're-dispatched to a stronger model, failing test first' }),
    Object.freeze({ id: 'cross-provider', at: 3, action: 'dispatch', taskType: 'ruling-escalation-cross-provider', provider: 'codex',
      instruction: TEST_FIRST_INSTRUCTION, label: 'handed to a cross-provider fixer, failing test first' }),
    Object.freeze({ id: 'human', at: 4, action: 'needs-you', taskType: null, provider: null, instruction: null,
      label: 'escalated to the operator (fixer and reviewer disagree; an arbiter comes later)' }),
  ]),
});

const fail = (m) => { throw new TypeError(`fixer-escalation policy: ${m}`); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate a complete ladder; returns it ordered by `at`. */
export function validateFixerEscalation(policy) {
  if (!object(policy) || policy.version !== 1) fail('version must be 1');
  if (!Array.isArray(policy.rungs) || !policy.rungs.length) fail('rungs must be a non-empty array');
  const ids = new Set();
  const rungs = policy.rungs.map((r, i) => {
    if (!object(r)) fail(`rungs[${i}] must be an object`);
    if (typeof r.id !== 'string' || !/^[\w-]+$/.test(r.id) || ids.has(r.id)) fail(`rungs[${i}].id must be a distinct word`);
    ids.add(r.id);
    if (!Number.isInteger(r.at) || r.at < 1) fail(`${r.id}.at must be a positive integer (the miss count that reaches this rung)`);
    if (!ACTIONS.includes(r.action)) fail(`${r.id}.action must be ${ACTIONS.join('|')}`);
    if (r.taskType != null && !/^[\w-]+$/.test(r.taskType)) fail(`${r.id}.taskType must be a routing-policy task type`);
    if (r.provider != null && !PROVIDERS.includes(r.provider)) fail(`${r.id}.provider must be ${PROVIDERS.join('|')}`);
    if (r.instruction != null && r.instruction !== TEST_FIRST_INSTRUCTION) fail(`${r.id}.instruction must be null or ${TEST_FIRST_INSTRUCTION}`);
    if (r.action === 'dispatch' && !r.provider) fail(`${r.id}: a dispatch rung needs a provider`);
    return { taskType: null, provider: null, instruction: null, label: r.id, ...r };
  });
  rungs.sort((a, b) => a.at - b.at);
  if (new Set(rungs.map((r) => r.at)).size !== rungs.length) fail('two rungs share the same `at`');
  if (rungs.at(-1).action !== 'needs-you') fail('the last rung must be needs-you: the ladder always ends at a person');
  return Object.freeze({ version: 1, rungs: Object.freeze(rungs.map((r) => Object.freeze(r))) });
}

/**
 * Merge a local override over the default, by rung id. `override.rungs` is an object keyed by id (partial rung
 * fields are merged into the default rung of that id; an unknown id adds a rung and must be complete);
 * `override.disable` lists ids to drop. Never throws: returns `{ policy, error }` with the default on any problem.
 */
export function resolveFixerEscalation(override, base = DEFAULT_FIXER_ESCALATION) {
  if (override == null) return { policy: validateFixerEscalation(base), error: null };
  try {
    if (!object(override)) fail('override must be an object');
    const known = ['rungs', 'disable'];
    for (const k of Object.keys(override)) if (!known.includes(k)) fail(`override.${k} is unknown (use ${known.join(' | ')})`);
    const byId = new Map(base.rungs.map((r) => [r.id, { ...r }]));
    for (const [id, patch] of Object.entries(override.rungs ?? {})) {
      if (!object(patch)) fail(`override.rungs.${id} must be an object`);
      byId.set(id, { ...(byId.get(id) ?? {}), ...patch, id });
    }
    for (const id of override.disable ?? []) byId.delete(id);
    return { policy: validateFixerEscalation({ version: 1, rungs: [...byId.values()] }), error: null };
  } catch (e) {
    return { policy: validateFixerEscalation(base), error: String(e.message ?? e) };
  }
}

/**
 * The rung a finding that has come back `misses` times belongs on: the highest rung with `at <= misses`. A rung
 * that is not `available` (see `available(rung)`) is skipped FORWARD, never back: an unavailable cross-provider
 * rung hands the finding to the operator rather than re-trying a weaker fixer.
 * @param {{rungs: Array<object>}} policy
 * @param {number} misses
 * @param {{available?: (rung: object) => boolean}} [o]
 * @returns {object|null} null when no rung is reached yet (misses < 1)
 */
export function pickRung(policy, misses, { available = () => true } = {}) {
  const rungs = policy.rungs;
  let i = -1;
  rungs.forEach((r, n) => { if (r.at <= misses) i = n; });
  if (i < 0) return null;
  while (i < rungs.length - 1 && rungs[i].action === 'dispatch' && !available(rungs[i])) i++;
  return rungs[i];
}

/** The lowest miss count at which a person is asked, given which rungs are available. */
export function humanAtMisses(policy, { available = () => true } = {}) {
  for (let m = 1; m <= policy.rungs.at(-1).at; m++) if (pickRung(policy, m, { available })?.action === 'needs-you') return m;
  return policy.rungs.at(-1).at;
}
