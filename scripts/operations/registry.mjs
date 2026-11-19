/**
 * @file scripts/operations/registry.mjs
 * @description THE DECLARATION SHAPE + THE REGISTRY of the operation engine (#3032, under epic #3029).
 *
 * ONE DECLARATION, DERIVED CALLERS. Per the statute
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * (#3031), a delivery-loop operation is declared once — input schema + ordered named steps — and every
 * caller is generated from it. This file owns the declaration and refuses a malformed one; the adapters
 * that read it are #3035 (command line) and #3036 (HTTP). **Nothing is declared onto this registry in this
 * slice** — #3032 is the machine, #3035 is the first declaration.
 *
 * THE SHAPE, LITERALLY `op(name, { input, ...steps })`:
 *
 * ```js
 * export const reviewPr = op('review-pr', {
 *   input:       { pr: 'number', aim: { type: 'string', required: false },
 *                  reason: { type: 'string', required: false, atConfirm: true } },
 *   verdictFrom: 'panel',                                   // optional: which step's finding IS the verdict
 *   ownedBy:     'we:skills-src/review/SKILL.md',           // optional: the skill that owns the rest of the run
 *   diff:    compute({ reads: ['input.pr'],       fn: (v) => … }),
 *   panel:   judge({   reads: ['findings.diff'],  request: (v) => ({ mandate, input, shape }) }),
 *   humanOk: confirm({ reads: ['verdict'], asks: 'Accept this verdict?', of: 'operator',
 *                      options: ['accept', 'changes'] }),
 *   record:  effect({  reads: ['verdict', 'input.reason'],
 *                      effects: (v) => [{ type: 'ledger.append', payload: v }] }),
 * });
 * ```
 *
 * RETRACTED — this example used to show `reason: { type: 'string', required: false }`, an ORDINARY optional
 * input. That was wrong, and it was the shape PR #1569 shipped and PR #1572 had to undo: an ordinary input can
 * only ride the initial call, and a reason for overriding the juror is only knowable AFTER the juror returns.
 * The `atConfirm: true` marker above is what makes it suppliable at the moment it is decided — see
 * {@link normalizeInputSchema}.
 *
 * Step ORDER is the object's key order — JavaScript preserves insertion order for string keys, so the
 * declaration reads top-to-bottom as the run executes. {@link RESERVED_DECLARATION_KEYS} lists the only
 * non-step keys; every other key is a step.
 *
 * REFUSED AT REGISTRATION, NEVER AT RUN TIME. A fifth kind, a hand-rolled step lookalike, a read of a
 * later step's finding, a read of an undeclared input field, a `verdictFrom` naming nothing — all of these
 * throw out of `op()`. The statute's *"a fifth kind is a signal to change the model"* is therefore a gate
 * a run can never reach, not advice in a comment.
 *
 * PURE. No fs, no clock, no process, no network. Leaf apart from {@link ./step-kinds.mjs}.
 */

import { STEP_KINDS, isStep } from './step-kinds.mjs';

/** Keys of a declaration body that are NOT steps. Everything else must be a step. */
export const RESERVED_DECLARATION_KEYS = Object.freeze(['input', 'verdictFrom', 'declaresOver', 'ownedBy']);

/**
 * THE SKILL THAT OWNS THE REST OF THE RUN (#3316) — validate one `ownedBy` value. PURE.
 *
 * WHY THIS IS A FIELD AND NOT A FIFTH STEP KIND. The statute's clause 2
 * ([#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated),
 * #3031) closes the vocabulary at four kinds and says an operation that appears to need a fifth is a signal to
 * change the model. Nothing here asks for one: a pointer at prose is not a step the engine executes, it is a
 * property of the DECLARATION in exactly the sense `verdictFrom` and `declaresOver` already are — one string,
 * validated at registration, carried onto the record when the run stops.
 *
 * WHAT WENT WRONG WITHOUT IT. A session invoked `review-pr` bare, reached its `confirm` suspend, and stopped:
 * the run said WHAT was asked and OF WHOM and offered a `--resume` line, and none of that told the caller that
 * `we:skills-src/review/SKILL.md` documented both routes forward. The suspend was correct; it was a dead end
 * for anyone who had not already read the skill. A suspended run is precisely the moment the caller is standing
 * OUTSIDE a process, so that is the moment the process must be nameable.
 *
 * IT IS DECLARED, NEVER DERIVED, and that is the same split `declaresOver`'s header argues. Nothing in the
 * import graph says which skill owns a run — a skill naming an operation in prose is not ownership, and #3224's
 * scan already counts those mentions without being able to rank them. Only the author knows.
 *
 * SHAPE ONLY, here. A locus prefix (#883) is required so the value names something resolvable rather than
 * reading as advice ("the review skill"); whether the file EXISTS is derived by `we:scripts/check-standards.mjs`,
 * which can read the disk this module deliberately cannot.
 *
 * @param {*} value
 * @param {string} name - operation name, for error text.
 * @returns {string|null} the trimmed pointer, or `null` when the declaration names no skill.
 */
export function normalizeOwningSkill(value, name = '<anonymous>') {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(
      `operations: \`${name}\` — \`ownedBy\` must be a locus-prefixed path to the skill that owns the rest of `
      + `the run (e.g. "we:skills-src/review/SKILL.md"), got ${JSON.stringify(value)}`,
    );
  }
  const pointer = value.trim();
  if (!/^[a-z][a-z0-9-]*:\S+$/.test(pointer)) {
    throw new TypeError(
      `operations: \`${name}\` — \`ownedBy\` ${JSON.stringify(pointer)} is not a locus-prefixed path (#883), `
      + 'e.g. "we:skills-src/review/SKILL.md". A pointer nobody can resolve is the dead end this field exists '
      + 'to close, so it is refused at registration rather than emitted onto a suspended run.',
    );
  }
  return pointer;
}

/**
 * Parse one `declaresOver` entry — `"we:scripts/lane-pool.mjs acquire"` — into `{home, command}`. PURE.
 *
 * THE SHAPE IS `<locus-prefixed path> [subcommand]`, and the subcommand is OPTIONAL because the two cases are
 * genuinely different. `we:scripts/verify-lane.mjs` has no subcommands, so naming the file names the whole
 * invocation. `we:scripts/backlog.mjs` has a dozen, and `claim` is declared over while `list` is not — a
 * file-granular claim there would condemn every `backlog.mjs` line in every skill, which is both wrong and
 * the fastest way to get a gate switched off.
 *
 * WHAT THIS FIELD IS FOR, and the line it draws. Only the AUTHOR knows which raw invocation an operation was
 * built to replace; nothing in the import graph says it. So that intent is DECLARED here — and nothing else
 * is. Whether the home actually reaches the operation is DERIVED from the import graph by the scan, never
 * restated as a flag on the declaration, because a restated fact goes stale the moment someone removes the
 * delegation and the declaration keeps insisting it is there. Declare what cannot be derived; derive the rest.
 *
 * A `command` of `null` means THE WHOLE FILE.
 */
export function parseDeclaredHome(entry) {
  const raw = String(entry ?? '').trim();
  if (!raw) return null;
  const [home, ...rest] = raw.split(/\s+/);
  if (!/^[a-z][a-z0-9-]*:/.test(home)) return null; // #883 — a locus prefix, or it names nothing resolvable
  return { home, command: rest.length ? rest.join(' ') : null };
}

/** Field types an input schema may declare. */
export const INPUT_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'array']);

/** @param {*} v @returns {boolean} */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalize an input schema — `{ pr: 'number' }` and `{ pr: { type: 'number', required: true } }` are the
 * same thing. Shorthand fields are REQUIRED; optionality is opt-in, so a caller cannot omit a field by
 * accident. Returns a frozen map of `{ type, required, default, enum }`.
 *
 * `enum` — A CLOSED SET, DECLARED ONCE. Under the statute's "declared once, callers generated", the set of
 * values a field accepts is part of what the operation IS, so declaring it buys three things from one line:
 * `validateInput` refuses anything outside it, the command line PRINTS it in `--help` instead of `<string>`,
 * and #3036's HTTP adapter gets the same for free. Before this, `review-pr` knew its four lenses (it re-exports
 * `PANEL_LENSES` from `we:scripts/lib/jury-core.mjs` expressly "so an adapter can list it in --help"), and the
 * adapter still printed `[--lens=<string>]` — the intent was there and the wiring was not, because the adapter
 * derives every flag from THIS schema and the schema had nowhere to put it. It generalises: any field with a
 * fixed vocabulary (a verdict target, a mode, a repo class) declares one here rather than validating by hand
 * inside its first step, where the refusal arrives after the run record already exists.
 *
 * Only `string` and `number` may carry one — a closed set of objects/arrays is a schema, not an enum, and
 * pretending otherwise would invite deep-equality membership tests the CLI's `--flag=value` parse cannot serve.
 *
 * `atConfirm` — WHEN THE FIELD IS SUPPLIED, not what it holds (#3035). An ordinary input field may ride exactly
 * one call: the one that STARTS the run. That is the right rule for everything that describes the SUBJECT (which
 * PR, which lens, which aim) — all of it is known before a step has run. It is the wrong rule for a value that
 * qualifies a DECISION, because the decision does not exist until the run has suspended and asked for it. The
 * field this marker was built for is `review-pr`'s `reason`: it says why an operator is overriding the juror, and
 * nobody can know an override is needed until `judge` has returned. Shipped as an ordinary input (PR #1569) the
 * flag was reachable ONLY before the fact it describes existed — `--resume` refuses input flags, correctly, since
 * the run record already holds them — so the guard that reads it could never be satisfied on the one path that
 * binds it.
 *
 * WHAT THE MARKER BUYS, and why it is here rather than in the adapter. The field stays a declared input, so a
 * step may name it in `reads` and `projectReads` will hand it over — that is the whole point, and it is exactly
 * what an adapter-only "control flag" could not give (the second bug PR #1572 fixed: the flag parsed, merged onto
 * the run record, and was then stripped by `projectReads` because the declaration did not name it). What changes
 * is WHEN it may be supplied: {@link validateInput} refuses it at start, and the CLI adapter accepts it only
 * alongside a `--answer`, merging it onto the run record there.
 *
 * It therefore cannot be `required` (nothing supplies it at the moment `required` is checked) and cannot carry a
 * `default` (a default is written at start, which would silently satisfy the very guard the field exists to feed
 * — a reasonless override wearing a canned reason). Both are refused below.
 *
 * @param {object|undefined} schema
 * @param {string} name - operation name, for error text.
 * @returns {Readonly<Record<string, {type: string, required: boolean, default: *, enum: (readonly *[]|null),
 *                                    atConfirm: boolean}>>}
 */
export function normalizeInputSchema(schema, name = '<anonymous>') {
  if (schema == null) return Object.freeze({});
  if (!isPlainObject(schema)) {
    throw new TypeError(`operations: \`${name}\` — \`input\` must be an object mapping field → type`);
  }
  const out = {};
  for (const [field, spec] of Object.entries(schema)) {
    const s = typeof spec === 'string' ? { type: spec } : spec;
    if (!isPlainObject(s)) {
      throw new TypeError(`operations: \`${name}\` — input field \`${field}\` must be a type string or a spec object`);
    }
    if (!INPUT_TYPES.includes(s.type)) {
      throw new TypeError(
        `operations: \`${name}\` — input field \`${field}\` has type ${JSON.stringify(s.type)}; must be one of ${INPUT_TYPES.join('|')}`,
      );
    }
    const required = s.required === undefined ? true : !!s.required;
    if (required && s.default !== undefined) {
      throw new TypeError(`operations: \`${name}\` — input field \`${field}\` is required and cannot also carry a \`default\``);
    }
    if (s.atConfirm !== undefined && typeof s.atConfirm !== 'boolean') {
      throw new TypeError(`operations: \`${name}\` — input field \`${field}\`'s \`atConfirm\` must be a boolean`);
    }
    const atConfirm = s.atConfirm === true;
    if (atConfirm && required) {
      throw new TypeError(
        `operations: \`${name}\` — input field \`${field}\` is \`atConfirm\` and cannot also be \`required\`: `
        + 'nothing can supply it at the moment `required` is checked, so every run would die on its own schema.',
      );
    }
    if (atConfirm && s.default !== undefined) {
      throw new TypeError(
        `operations: \`${name}\` — input field \`${field}\` is \`atConfirm\` and cannot carry a \`default\`: the `
        + 'default would be written at START, so a step that reads the field to check whether the operator said '
        + 'anything would read the canned answer instead of nothing.',
      );
    }
    if (s.repeatable !== undefined && (typeof s.repeatable !== 'boolean' || s.repeatable && (s.type !== 'array' || atConfirm))) {
      throw new TypeError(`operations: ${field}: repeatable requires an ordinary array field`);
    }
    const members = normalizeEnum(s.enum, name, field, s.type);
    if (members && s.default !== undefined && !members.includes(s.default)) {
      throw new TypeError(
        `operations: \`${name}\` — input field \`${field}\` defaults to ${JSON.stringify(s.default)}, which is not `
        + `one of its own declared values (${members.join('|')}). A default the field would refuse is a run that `
        + 'dies on its own schema.',
      );
    }
    out[field] = Object.freeze({ type: s.type, required, default: s.default, enum: members, atConfirm, ...(s.repeatable ? { repeatable: true } : {}) });
  }
  return Object.freeze(out);
}

/** Types a declared `enum` is allowed on. See the note in {@link normalizeInputSchema}. */
const ENUMERABLE_TYPES = Object.freeze(['string', 'number']);

/** Validate + freeze one field's declared value set. Returns `null` when the field declares none. */
function normalizeEnum(members, name, field, type) {
  if (members === undefined || members === null) return null;
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError(`operations: \`${name}\` — input field \`${field}\`'s \`enum\` must be a non-empty array`);
  }
  if (!ENUMERABLE_TYPES.includes(type)) {
    throw new TypeError(
      `operations: \`${name}\` — input field \`${field}\` is a ${type} and cannot declare an \`enum\` `
      + `(only ${ENUMERABLE_TYPES.join('/')} may)`,
    );
  }
  for (const m of members) {
    if (typeOf(m) !== type) {
      throw new TypeError(
        `operations: \`${name}\` — input field \`${field}\` declares enum member ${JSON.stringify(m)}, `
        + `which is not a ${type}`,
      );
    }
  }
  if (new Set(members).size !== members.length) {
    throw new TypeError(`operations: \`${name}\` — input field \`${field}\`'s \`enum\` repeats a value`);
  }
  return Object.freeze([...members]);
}

/** Runtime type test matching {@link INPUT_TYPES}. */
function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Validate a run's input against a normalized schema. FAILS CLOSED in both directions: a missing required
 * field AND an **unknown** field are both errors, so a caller can never smuggle state past the declaration.
 *
 * THIS IS THE START GATE, AND ONLY THE START GATE. `startRun` is its one caller, so "may this value be here"
 * is asked exactly once, at the moment the run record is minted. That is why an `atConfirm` field (see
 * {@link normalizeInputSchema}) is REFUSED here rather than ignored: the field is legal on the record and
 * illegal at this instant, and a caller that passes it at start has mistaken a decision for a subject. The
 * adapter writes it onto the record later, at the confirm, where it belongs.
 *
 * @param {object} schema - a normalized schema from {@link normalizeInputSchema}.
 * @param {object} input
 * @returns {{ok: boolean, value: object, errors: string[]}}
 */
export function validateInput(schema, input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, value: {}, errors: ['input must be an object'] };
  }
  const value = {};
  for (const [field, spec] of Object.entries(schema)) {
    const given = Object.prototype.hasOwnProperty.call(input, field) ? input[field] : undefined;
    if (given === undefined) {
      if (spec.required) errors.push(`missing required input field \`${field}\` (${spec.type})`);
      else if (spec.default !== undefined) value[field] = spec.default;
      continue;
    }
    // A CONFIRM-TIME FIELD AT START IS A REFUSAL, not a silent pass-through. It carries a value that qualifies
    // a decision no step has reached yet, so accepting it here would record an answer to an unasked question.
    if (spec.atConfirm) {
      errors.push(
        `input field \`${field}\` is supplied at confirm time, not at start — pass it alongside the answer it `
        + 'qualifies (the CLI spells that `--resume=<run-id> --answer=<option> --'
        + `${field}=<value>\`), not on the call that starts the run.`,
      );
      continue;
    }
    const actual = typeOf(given);
    if (actual !== spec.type) {
      errors.push(`input field \`${field}\` must be a ${spec.type}, got ${actual}`);
      continue;
    }
    // A declared value set is refused HERE, before a run record exists — not inside the first step that
    // happens to look at it, where the refusal costs a run id and a written record to reject one flag.
    if (spec.enum && !spec.enum.includes(given)) {
      errors.push(
        `input field \`${field}\` must be one of ${spec.enum.map((m) => String(m)).join('|')}, got ${JSON.stringify(given)}`,
      );
      continue;
    }
    value[field] = given;
  }
  for (const field of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema, field)) {
      errors.push(`unknown input field \`${field}\` — the declaration does not accept it`);
    }
  }
  return { ok: errors.length === 0, value, errors };
}

/**
 * Build + validate an operation declaration. THE REFUSAL POINT: everything structural about an operation is
 * checked here, before any run exists.
 *
 * @param {string} name - the operation's stable id (kebab-case by convention; any non-empty string works).
 * @param {object} body - `{ input?, verdictFrom?, ...steps }`.
 * @returns {Readonly<{name: string, input: object, verdictFrom: (string|null),
 *                     steps: ReadonlyArray<{name: string, index: number, step: object}>,
 *                     stepNames: readonly string[]}>}
 */
export function op(name, body) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('operations: `op(name, …)` needs a non-empty operation name');
  }
  if (!isPlainObject(body)) {
    throw new TypeError(`operations: \`${name}\` — the declaration body must be an object { input, ...steps }`);
  }

  const input = normalizeInputSchema(body.input, name);
  const inputFields = new Set(Object.keys(input));

  const steps = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(body)) {
    if (RESERVED_DECLARATION_KEYS.includes(key)) continue;
    if (!isStep(value)) {
      // THE CLOSED-VOCABULARY REFUSAL. A fifth kind, a plain object with a made-up `kind`, or a stray
      // config key all land here — at registration, never at run time.
      const got = isPlainObject(value) && typeof value.kind === 'string' ? `kind ${JSON.stringify(value.kind)}` : typeof value;
      throw new TypeError(
        `operations: \`${name}\` — key \`${key}\` is not a step (${got}). The vocabulary is closed at ` +
        `${STEP_KINDS.join('|')}; the only non-step keys are ${RESERVED_DECLARATION_KEYS.join('|')}. ` +
        'An operation that appears to need a fifth kind is a signal to change the model, not to extend the ' +
        'vocabulary (#operations-declared-once-callers-generated, #3031).',
      );
    }
    if (seen.has(key)) throw new TypeError(`operations: \`${name}\` — duplicate step name \`${key}\``);
    seen.add(key);
    steps.push({ name: key, index: steps.length, step: value });
  }

  if (steps.length === 0) {
    throw new TypeError(`operations: \`${name}\` — an operation needs at least one step`);
  }

  // Reads are checked against what EXISTS AT THAT POINT IN THE RUN: an earlier step's finding, a declared
  // input field, or the verdict. A forward reference is a declaration bug and dies here.
  const earlier = new Set();
  for (const { name: stepName, step } of steps) {
    for (const path of step.reads) {
      const [root, leaf] = path.split('.');
      if (root === 'input') {
        if (leaf !== undefined && !inputFields.has(leaf)) {
          throw new TypeError(`operations: \`${name}\`.\`${stepName}\` reads \`${path}\` but the input schema has no field \`${leaf}\``);
        }
      } else if (root === 'findings') {
        if (leaf === undefined) {
          throw new TypeError(`operations: \`${name}\`.\`${stepName}\` reads bare \`findings\` — name the step, e.g. \`findings.diff\``);
        }
        if (!earlier.has(leaf)) {
          throw new TypeError(
            `operations: \`${name}\`.\`${stepName}\` reads \`${path}\`, but \`${leaf}\` is ` +
            (seen.has(leaf) ? 'declared LATER in the run — a step cannot read a finding that does not exist yet' : 'not a declared step'),
          );
        }
      } else if (root === 'verdict' && path !== 'verdict') {
        throw new TypeError(`operations: \`${name}\`.\`${stepName}\` reads \`${path}\` — \`verdict\` takes no sub-path`);
      }
    }
    earlier.add(stepName);
  }

  let verdictFrom = null;
  if (body.verdictFrom != null) {
    if (typeof body.verdictFrom !== 'string' || !seen.has(body.verdictFrom)) {
      throw new TypeError(
        `operations: \`${name}\` — \`verdictFrom\` must name a declared step, got ${JSON.stringify(body.verdictFrom)}`,
      );
    }
    verdictFrom = body.verdictFrom;
  }

  // #3224 — the raw invocations this operation was built to replace. REFUSED AT REGISTRATION if malformed,
  // for the same reason everything else here is: a `declaresOver` entry that silently parses to nothing
  // produces a scan that silently checks nothing, which is the failure mode the gate exists to close.
  let declaresOver = Object.freeze([]);
  if (body.declaresOver != null) {
    if (!Array.isArray(body.declaresOver)) {
      throw new TypeError(`operations: \`${name}\` — \`declaresOver\` must be an array of "<locus:path> [subcommand]" strings`);
    }
    declaresOver = Object.freeze(body.declaresOver.map((entry) => {
      const parsed = parseDeclaredHome(entry);
      if (!parsed) {
        throw new TypeError(
          `operations: \`${name}\` — \`declaresOver\` entry ${JSON.stringify(entry)} is not a locus-prefixed `
          + 'path (#883), e.g. "we:scripts/lane-pool.mjs acquire". An unparseable entry would declare over nothing.',
        );
      }
      return Object.freeze(parsed);
    }));
  }

  // #3316 — the skill that owns the rest of this run, or `null`. OPTIONAL, and it must stay optional: making
  // it required would redden every one of the twelve declarations that legitimately owns no skill, which is
  // how a field meant to help a stuck caller becomes a field authors fill in with the nearest plausible path.
  const ownedBy = normalizeOwningSkill(body.ownedBy, name);

  return Object.freeze({
    name: name.trim(),
    input,
    verdictFrom,
    declaresOver,
    ownedBy,
    steps: Object.freeze(steps.map((s) => Object.freeze(s))),
    stepNames: Object.freeze(steps.map((s) => s.name)),
  });
}

/**
 * IS EVERY STEP OF THIS DECLARATION A `compute`? That is the whole test, and the name is the strongest thing
 * that can honestly be said about the answer.
 *
 * WHAT IS DERIVED FROM THE CLOSED VOCABULARY, and is therefore structural: a `compute`-only declaration cannot
 * SUSPEND (no `judge`, no `confirm`, so no stop point exists), and it cannot produce an EFFECT DESCRIPTOR for
 * {@link ./effect-executor.mjs} to apply (no `effect` step). Both follow from the four kinds and neither is a
 * per-operation promise. That is why #3035's command line drops the `--resume` line for such an operation and
 * why #3036's HTTP adapter derives a GET-only, run-record-free route table from it.
 *
 * WHAT IS **NOT** DERIVED, AND MUST NOT BE READ INTO THE NAME: this says nothing about what a `compute` step's
 * fn does. Nothing here — not `op()`, not this predicate — inspects a step fn's body or its closure. A
 * `compute` fn that closes over `writeFileSync` passes every check in this file, and the HTTP adapter will then
 * serve it on a `GET`. The `compute` contract in {@link ./step-kinds.mjs} ("a pure function plus its declared
 * reads") is a contract the DECLARATION AUTHOR keeps; the engine enforces only the reads.
 *
 * The repo narrows that gap for its own declarations with a static import-graph assertion — a module that
 * declares a read-only operation must reach nothing that can act, so its step fns hold no writer in lexical
 * scope. See `__tests__/http-adapter.test.mjs`, which also states exactly what that check does not cover.
 *
 * @param {object} declaration - a frozen declaration from {@link op}.
 * @returns {boolean} true when every declared step's kind is `compute`.
 */
export function isReadOnlyOperation(declaration) {
  if (!declaration || !Array.isArray(declaration.steps) || declaration.steps.length === 0) {
    throw new TypeError('operations: isReadOnlyOperation expects a declaration built by `op(name, …)`');
  }
  return declaration.steps.every((s) => s.step.kind === 'compute');
}

/**
 * A registry of declared operations. `createRegistry()` returns an isolated one (what tests and adapters
 * should use); {@link defaultRegistry} is the process-wide one that {@link defineOperation} writes to.
 *
 * Lookups FAIL CLOSED: `get` on an unknown name throws rather than returning undefined, because the caller
 * downstream of it is about to run something.
 */
export function createRegistry() {
  /** @type {Map<string, object>} */
  const byName = new Map();
  return {
    /** Register a declaration built by {@link op}. Re-registering the SAME frozen declaration is a no-op;
     *  registering a DIFFERENT one under a taken name is refused (two wirings for one operation is the
     *  exact defect the statute forbids). */
    register(declaration) {
      if (!declaration || typeof declaration !== 'object' || typeof declaration.name !== 'string' || !Array.isArray(declaration.steps)) {
        throw new TypeError('operations: registry.register expects a declaration built by `op(name, …)`');
      }
      const existing = byName.get(declaration.name);
      if (existing && existing !== declaration) {
        throw new Error(`operations: \`${declaration.name}\` is already registered with a different declaration`);
      }
      byName.set(declaration.name, declaration);
      return declaration;
    },
    /** @returns {object} the declaration. THROWS on an unknown name — never `undefined`. */
    get(name) {
      const found = byName.get(String(name ?? ''));
      if (!found) {
        const known = [...byName.keys()].sort();
        throw new Error(
          `operations: no operation named ${JSON.stringify(name)} is registered` +
          (known.length ? ` (known: ${known.join(', ')})` : ' (the registry is empty)'),
        );
      }
      return found;
    },
    has(name) { return byName.has(String(name ?? '')); },
    names() { return [...byName.keys()].sort(); },
    clear() { byName.clear(); },
  };
}

/** The process-wide registry. Adapters resolve an operation name through this one. */
export const defaultRegistry = createRegistry();

/** Declare an operation AND register it in {@link defaultRegistry}. `op()` alone stays side-effect free. */
export function defineOperation(name, body) {
  return defaultRegistry.register(op(name, body));
}
