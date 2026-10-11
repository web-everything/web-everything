/**
 * @file scripts/operations/cli-adapter.mjs
 * @description THE COMMAND-LINE ADAPTER, DERIVED FROM A DECLARATION (#3035, under epic #3029).
 *
 * ONE DECLARATION, DERIVED CALLERS — this is the first derived caller. Per the statute
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * clause 1, *"a hand-written route or argv parser for an operation that could be declared is a defect, not a
 * style choice"*. So NOTHING in this file knows about reviewing a PR. It knows about **declarations**: it
 * derives the flag list, the usage text and the input validation from `declaration.input`, and it drives the
 * run loop over `declaration.steps`. Declaring a second operation buys its command line for free; #3036 does
 * the same thing for HTTP over the same declaration.
 *
 * WHAT "DERIVED" MEANS HERE, PRECISELY: no code generation, no build step. The caller is derived at RUN time
 * from the frozen declaration — which is strictly stronger than generated source, because generated source can
 * drift from its input and this cannot.
 *
 * ── THE FOUR SUSPENDS, AND WHO RESOLVES EACH ────────────────────────────────────────────────────────────────
 *
 *   | status             | this adapter                                                                        |
 *   |--------------------|-------------------------------------------------------------------------------------|
 *   | `running`          | `advance` again — no io                                                             |
 *   | `awaiting-judge`   | spawns ONE juror PER SUSPEND (`judgeSpawn`, #3028), resumes with its answer + cost  |
 *   | `awaiting-confirm` | **STOPS AND EXITS.** The question is printed; the run id is printed. Nothing else.   |
 *   | `awaiting-effect`  | applies the declared effects through the executor, then `advance` again              |
 *
 * TWO NOTES ON THE JUDGE ROW, because both used to read wrong. **"ONE juror" is per SUSPEND, not per RUN** — an
 * operation declaring N `judge` steps suspends N times and seats N jurors (`review-pr` declares two since
 * #3319). And the juror is **tool-free only by DEFAULT**: a request carrying a non-empty `allowedTools` gets a
 * tool-bearing juror, which is what `review-pr` passes (`REVIEW_JUROR_TOOLS`). Reading this row as "one
 * tool-free juror, once, per run" is wrong on all three counts for the operation most likely to be read here.
 *
 * THE CONFIRM STOP IS THE POINT. `we:skills-src/review/SKILL.md` used to carry it as prose — *"This is a stop
 * point … Do not auto-proceed"* — a rule the model had to hold. Here it is arithmetic: an `--answer` is REFUSED
 * unless it arrives on a `--resume=<id>` of a run that is actually suspended at a `confirm` step. **You cannot
 * answer a question that has not been asked**, and no amount of eagerness in the caller changes that.
 *
 * IDEMPOTENT REPLAY REPLACES "RE-RUN THE SAME COMMAND". A `--resume` on a run whose effects half-landed
 * re-enters the executor, which skips every `applied` entry and refuses to guess at an indeterminate
 * non-idempotent one. The skill's *"a non-zero exit means re-run the same command; it is safe"* stops being a
 * promise and becomes the mechanism.
 *
 * IMPURE: it spawns jurors, applies effects and writes run records — through INJECTED handles, so the whole
 * loop is testable with no subprocess at all. The PURE halves (`buildCliSpec`, `parseOperationArgv`) touch
 * nothing.
 */

import { resolveOperationRoute } from '../lib/dispatch-routing-policy-io.mjs';
import { pickAgyEvidence } from '../lib/antigravity-run-evidence.mjs';
import { describeSubmit, extractSubmitResult } from './open-pr.mjs';
import { advance, runStatus, startRun } from './engine.mjs';
import { applyPendingEffects, inFlightEntries } from './effect-executor.mjs';
import { normalizeJudgeTelemetry, totalJudgeSpend, withStepFinish, withStepStart } from './run-record.mjs';
import { planJudgeBatch, runJudgeBatch, sameJudgeRequest } from './parallel-judges.mjs';
import { isReadOnlyOperation, validateInput } from './registry.mjs';
import { assertNoForbiddenArgv, EFFORT_LEVELS, judgeSpawn } from '../lib/judge-spawn.mjs';
// #xqa9ttq — `requireAllProperties` comes from `codex-judge-spawn.mjs`, NOT `../lib/jury-core.mjs`, and that
// is deliberate: `jury-core.mjs` imports `review-escalation.mjs`, which needs the `markdown-it` npm package,
// and this file is imported at module-load time by lightweight CLI entry points (`we:scripts/backlog.mjs`
// among them) that the repo's own ephemeral-clone test harness runs from a tree with NO `node_modules` at all
// (`we:scripts/__tests__/number-stranded-locus.test.mjs` and friends, #2273/#2274). An earlier draft imported
// `requireAllProperties` from `jury-core.mjs` here and broke all three of those tests with
// `ERR_MODULE_NOT_FOUND: markdown-it` — a real, live-caught regression, not a hypothetical one; see
// `codex-judge-spawn.mjs`'s own header for the full account. Do not re-introduce that edge.
import { codexJudgeSpawn, requireAllProperties } from '../lib/codex-judge-spawn.mjs';
// #3383 probation — the ratified Codex model pin (`#x8wbivt`), a leaf constant with no jury/markdown-it edge
// (same safety property `codex-judge-spawn.mjs`'s own header discusses for this file). Needed so the
// advisory judge seat's `{provider, model}` identity is a STAMPABLE fact rather than whatever `codex exec`
// resolves implicitly — the same hole `#3635` (unmerged, `lane/3635-pin-codex-model-every-call-site`) names
// for this exact call site. Fixed minimally HERE (default only, an explicit `request.model` still wins)
// rather than pulled in wholesale from that branch, since our need is narrowly "the identity this probation
// registry keys on must be real", not the fuller multi-call-site consolidation #3635 owns.
import { CODEX_MODEL, CODEX_EFFORT_MAP } from '../codex-direct-task.mjs';
// #3383 — THE FIFTH SEAT'S PROVIDER (Google's Antigravity CLI, `agy`), mirroring the Codex import immediately
// above: a leaf constant with no jury/markdown-it edge, imported so `resolveJudgeProvider`'s `'antigravity'`
// branch pins a REAL `{provider, model}` identity (`ANTIGRAVITY_MODEL`) rather than whatever `agy` resolves as
// its own undocumented default (#3633 probe 9: the default model's effort tier is not even exposed). See
// `antigravity-judge-spawn.mjs`'s own header for why this module is a safe, tool-free leaf import — it is
// already the standalone primitive proven live against the real CLI (`63102bde8`), just not wired until now.
import { antigravityJudgeSpawn, ANTIGRAVITY_MODEL } from '../lib/antigravity-judge-spawn.mjs';

/** Flags the adapter owns. A declaration may not name an input field that collides with one. */
export const CONTROL_FLAGS = Object.freeze(['help', 'json', 'resume', 'answer', 'run-id', 'cwd', 'model', 'provider']);

/**
 * #xqa9ttq — the named `JudgeProvider` implementations `--provider` may select. `'claude'` (the existing
 * `judgeSpawn`) is the default everywhere this is omitted — this card is ADDITIVE, never a default flip.
 * A single source of truth so the CLI parse, `createDefaultJudge`'s resolution, and any future caller agree
 * on the exact same spelling set — the same reason `EFFORT_LEVELS` is one exported array rather than a string
 * re-typed at each call site.
 *
 * #3383 — `'antigravity'` ADDED here, mirroring exactly how `'codex'` was added: additive, never reordering
 * the existing two names and never changing the default (still `'claude'`).
 */
export const JUDGE_PROVIDER_NAMES = Object.freeze(['claude', 'codex', 'antigravity']);

/**
 * The control flags that mean something ONLY to a declaration with a `judge` step — the JUROR flags.
 *
 * THE GAP THEY CLOSE (#3151). `--cwd` is the juror's own lane, and a TOOL-BEARING juror cannot spawn without
 * one: `assertLaneCwd` (`we:scripts/lib/judge-spawn.mjs`) REFUSES the spawn rather than inheriting the driver's
 * directory, which is the isolation property, not a bug. But until this flag existed the only way to supply
 * that lane was `JUDGE_LANE_CWD` in the environment — a side channel no `--help` output mentioned, which
 * dispatch prompts threaded by hand and which at least three independent reviewers on 2026-08-17 each
 * rediscovered by reading those prompts instead of the tool. Every one of them fell back to a fully manual
 * review. A derived caller that silently requires an undocumented env var is precisely the hand-wiring gap
 * epic #3029 exists to eliminate, so the lane is now a FLAG: derived, documented in the usage text the
 * declaration generates, and validated before a run record exists.
 *
 * `--model` is the same divergence one field over: a dispatch prompt written with `--model=sonnet` failed
 * outright, because the juror's model was reachable from nowhere on the command line. It is a CONTROL flag and
 * deliberately NOT an input field — which is what keeps #3028's property exactly as strong as it was. Nothing
 * in the run's INPUT can reach the juror's argv (see `JUDGE_MODEL` in `we:scripts/operations/review-pr.mjs`);
 * an operator override arrives on a different path and is checked by {@link assertSafeJudgeRequest}, the same
 * guard every declaration-built request passes, before it can become a flag position.
 *
 * ADVERTISED AND ACCEPTED ONLY WHERE A JUROR EXISTS ({@link declaresJudgeStep}) — derived from the step kinds
 * exactly as the resume line already is. An operation whose every step is `compute` has no juror to point at a
 * lane and no model to pick, so accepting the flag there would be a silent no-op: the same "the flag did
 * nothing and nothing said so" failure this card is about, in the opposite direction.
 *
 * THE NAME IS `--cwd`, DELIBERATELY, AND #3137 MUST NOT REUSE IT. `--cwd` is the spelling the reviewers who hit
 * the refusal reached for from memory, and the card asked for it by name, so it is the one that closes the
 * discovery loop. But it is a GENERIC name for a JUROR-ONLY meaning, and the open #3137 wants a second cwd —
 * one for the `read` step, so a cross-repo review stops silently degrading to an empty diff. That flag must be
 * named for what it points at (`--read-cwd` / `--subject-cwd`), never as a rename or a widening of this one:
 * the two mean different directories and conflating them would hand a juror the repo under review. The help
 * text says which this is, in the negative, for the operator who types it from memory anyway.
 *
 * WHAT MAKES THE SHARED SPELLING SAFE, rather than merely documented: the two are RUNTIME-DISTINGUISHABLE in
 * opposite directions. `assertLaneCwd` → `laneRootOf` refuses any path that is not `<ws>/.lanes/<pool>/lane-N`,
 * so an operator who points THIS flag at a clone of the repo under review gets an explicit "not a lane clone"
 * refusal — never a silent pass on the wrong tree. #3137's flag will have the mirror-image requirement (a real
 * checkout, which is not a lane). A misdirected value therefore fails loudly on either side, which is why the
 * ambiguity stays a documentation matter and not a correctness one (PR review r2 withdrew the rename on this).
 */
export const JUROR_FLAGS = Object.freeze(['cwd', 'model', 'provider']);

/**
 * The control flags that only mean something to a declaration that can SUSPEND — a run that cannot stop cannot
 * be resumed, and has no question to answer. Listed for the same reason {@link JUROR_FLAGS} is: the
 * unknown-flag message must name the flags that actually apply here, and no others.
 */
export const RESUME_FLAGS = Object.freeze(['resume', 'answer', 'run-id']);

/** Does this declaration declare a `judge` step? PURE — reads the step KINDS, never the operation's name. */
export function declaresJudgeStep(declaration) {
  return (declaration?.steps ?? []).some((s) => s?.step?.kind === 'judge');
}

/**
 * The declaration's CONFIRM-TIME input fields — those marked `atConfirm` in its schema. PURE.
 *
 * These are real declared inputs (a step may read them; `projectReads` hands them over), and they are the only
 * fields whose flag rides a `--resume` instead of the opening call. See `atConfirm` in
 * {@link ../registry.mjs normalizeInputSchema} for why the distinction exists at all.
 *
 * DERIVED PER DECLARATION, never a hard-coded name. `--reason` was briefly a member of {@link CONTROL_FLAGS},
 * which made every operation in the registry advertise and accept it — including the ones with no confirm step
 * and no field to put it in, where it would have been a flag that silently did nothing. The whole point of
 * reading it off the schema is that an operation accepts the confirm-time flags it actually declares, and no
 * others. RETRACTED: `CONTROL_FLAGS` above used to end `…, 'model', 'reason']`. That was wrong twice over — it
 * over-advertised the flag everywhere, and (because the collision check below refuses an input field named
 * after a control flag) it made the declaration that needs `reason` unable to declare it.
 *
 * @param {object} declaration
 * @returns {string[]} field names, in declaration order.
 */
export function confirmTimeFields(declaration) {
  return Object.entries(declaration?.input ?? {}).filter(([, spec]) => spec?.atConfirm).map(([name]) => name);
}

/**
 * Which control flags THIS declaration actually accepts. PURE.
 *
 * `CONTROL_FLAGS` is the union across all operations and is NOT the per-operation answer: `--cwd`/`--model`
 * are refused where there is no `judge` step, and `--resume`/`--answer`/`--run-id` where the run cannot
 * suspend. The unknown-flag refusal below already filters exactly this way; this lifts that filter out so a
 * SECOND caller can ask the same question instead of re-deriving it (#2644).
 *
 * THE SECOND CALLER IS THE #3253 GATE, and it needed this (PR #1526 round 3). Judging every call site against
 * the flat union made the gate accept `--cwd` on `scaffold` — a command the real CLI refuses. That is a false
 * NEGATIVE rather than a false positive, so milder than this gate's other bugs, but a validator that
 * green-lights a command the CLI rejects is not doing the one job it claims to do.
 */
export function acceptedControlFlags(declaration) {
  const judged = declaresJudgeStep(declaration);
  const resumable = !isReadOnlyOperation(declaration);
  return CONTROL_FLAGS.filter((f) => {
    if (JUROR_FLAGS.includes(f)) return judged;
    if (RESUME_FLAGS.includes(f)) return resumable;
    return true;
  });
}

/**
 * What `--help` says about the juror flags, for a declaration that has a `judge` step.
 *
 * IT NAMES THE REFUSAL IT PREVENTS, verbatim enough to be searchable: an operator who has already hit
 * `refusing to spawn a TOOL-BEARING juror` must be able to find the answer by running `--help` and matching the
 * words. That round trip — error text to flag — is the whole fix; a help line that only said "the juror's
 * working directory" would have left every reviewer exactly where #3151 found them.
 */
export const JUROR_FLAG_HELP = Object.freeze([
  'juror flags (this operation has a `judge` step):',
  '  --cwd=<lane>      the lane clone the juror runs in. REQUIRED when the declaration asks for a TOOL-BEARING',
  '                    juror, which refuses to spawn without one ("refusing to spawn a TOOL-BEARING juror —',
  '                    no `cwd` was supplied"). It must be a lane clone of its OWN — not the primary checkout,',
  '                    and not the lane you are driving from; acquire one with `scripts/lane-pool.mjs acquire`.',
  '                    Falls back to $JUDGE_LANE_CWD when the flag is omitted.',
  '                    NOT the checkout the subject is read FROM: the `read` step still runs against this',
  '                    repo, so pointing this at a clone of another repo does not make a cross-repo review',
  '                    work (that gap is its own open item, #3137). This flag only says where the juror runs.',
  '  --model=<alias>   override the juror model the declaration asks for (e.g. `sonnet`, `opus`). Omit to use',
  '                    the declared one. This is a control flag, not run input: it is never recorded as input',
  '                    and never reaches the mandate.',
  `  --provider=<name> which JudgeProvider implementation runs the juror — one of ${JUDGE_PROVIDER_NAMES.join('|')}.`,
  '                    Omit for the default (`claude`, today\'s `judgeSpawn`) — this is OPT-IN, never automatic',
  '                    (#xqa9ttq). `codex` seats a Codex CLI juror; it is TOOL-FREE ONLY today, so combining it',
  '                    with a declaration that requests a tool-bearing juror is refused, not silently degraded.',
]);

/**
 * DERIVE the command line from a declaration. PURE.
 * @param {object} declaration
 * @returns {{name: string, fields: Array<object>, usage: string}}
 */
export function buildCliSpec(declaration) {
  const fields = Object.entries(declaration.input).map(([name, spec]) => ({
    name, type: spec.type, required: spec.required, default: spec.default, enum: spec.enum ?? null,
    atConfirm: !!spec.atConfirm,
  }));
  const collision = fields.find((f) => CONTROL_FLAGS.includes(f.name));
  if (collision) {
    throw new Error(
      `operations: \`${declaration.name}\` declares an input field \`${collision.name}\` that collides with the `
      + `adapter's own control flag — rename it (control flags: ${CONTROL_FLAGS.join(', ')}).`,
    );
  }
  // A field with a declared value set PRINTS THE SET, not its type: `--lens=<string>` tells the operator
  // nothing they can act on, and the four valid lenses were already declared — the help just never read them.
  // The default is shown alongside, so "what happens if I omit it" is answered in the same line.
  const placeholder = (f) => (f.enum ? f.enum.map(String).join('|') : `<${f.type}>`);
  // A CONFIRM-TIME FIELD IS NOT PRINTED ON THE OPENING LINE, for the same reason `--cwd` is not printed where
  // there is no juror: the adapter REFUSES it there, so advertising it would document a refusal. It is printed
  // on the resume line instead, which is the call it actually rides.
  const optional = (f) => `[--${f.name}=${placeholder(f)}${f.default !== undefined ? `, default ${f.default}` : ''}]`;
  const flagText = fields
    .filter((f) => !f.atConfirm)
    .map((f) => (f.required ? `--${f.name}=${placeholder(f)}` : optional(f)))
    .join(' ');
  const confirmFlagText = fields.filter((f) => f.atConfirm).map((f) => ` ${optional(f)}`).join('');
  const steps = declaration.steps.map((s) => `${s.name}(${s.step.kind})`).join(' → ');
  // THE RESUME LINE IS DERIVED TOO. A declaration whose every step is `compute` can never suspend, so there is
  // no run to resume and no question to answer — printing the line anyway documents a flag combination the
  // adapter would refuse. `isReadOnlyOperation` reads the step kinds; nothing here knows which operation it is.
  const resumable = !isReadOnlyOperation(declaration);
  // THE JUROR FLAGS ARE DERIVED THE SAME WAY (#3151). A declaration with no `judge` step has no juror, so
  // printing `--cwd` for it would document a flag the adapter refuses; a declaration WITH one requires the lane
  // whenever its request is tool-bearing, and that requirement was previously stated NOWHERE in this output —
  // the whole defect. `judged` decides both the usage line and `parseOperationArgv`'s refusal, from one fact.
  const judged = declaresJudgeStep(declaration);
  return {
    name: declaration.name,
    fields,
    usage: [
      `usage: run.mjs ${declaration.name} ${flagText} [--json]${judged ? ' [--cwd=<lane>] [--model=<alias>]' : ''}`,
      ...(resumable ? [`       run.mjs ${declaration.name} --resume=<run-id> [--answer=<option>]${confirmFlagText} [--json]${judged ? ' [--cwd=<lane>] [--model=<alias>]' : ''}`] : []),
      '',
      `steps: ${steps}`,
      // #3316 — BEFORE THE RUN, not only after it suspends. The measured failure was an operation invoked
      // BARE by a caller who did not know a skill owned it; the suspend-time pointer rescues them one stop
      // late, and this is the same fact at the moment they are reading the usage. Derived from the same
      // declared field, so the two surfaces cannot disagree.
      ...(declaration.ownedBy ? ['', `owned by: ${declaration.ownedBy} — the skill that owns the rest of a run of this operation.`] : []),
      ...(judged ? ['', ...JUROR_FLAG_HELP] : []),
      ...(resumable ? [] : ['', 'read-only: every step is `compute` — this operation completes in one call, suspends at nothing and records no run.']),
    ].join('\n'),
  };
}

/**
 * Coerce one string token to a declared input type. Returns `undefined` when it does not fit.
 *
 * EXPORTED because a query parameter and a `--flag=value` are the same problem — a string that has to become
 * a declared type — and #3036's HTTP adapter must not grow a second answer to it. The `undefined` sentinel
 * (rather than a thrown error) is what lets each caller name the offending token in its own transport's
 * spelling while the coercion itself stays one implementation.
 */
export function coerceInputValue(type, raw) {
  if (type === 'string') return raw;
  if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
  if (type === 'boolean') {
    if (raw === '' || raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return undefined;
  }
  try { const v = JSON.parse(raw); return (type === 'array') === Array.isArray(v) && typeof v === 'object' ? v : undefined; }
  catch { return undefined; }
}

/**
 * DOES THIS ARGV CARRY `--json`? A tiny, standalone slice of the SAME rule `parseOperationArgv` uses for the
 * `json` control flag below (a bare `--json` or a `--json=…` token), but usable BEFORE a declaration exists —
 * `we:scripts/operations/run.mjs` and `we:scripts/operations/review-loop-cli.mjs` both need to know whether an
 * invocation asked for `--json` while they are still BUILDING the sinks that `resolveOperation` hands back
 * (`createReviewPrSinks`'s `json` option, `we:scripts/operations/review-pr-io.mjs`), which is before the
 * declaration those sinks bind to is even resolved — so `parseOperationArgv`'s full pass, which needs the
 * declaration for its `spec.fields` lookups, cannot run yet. PURE, and intentionally narrower than a full
 * parse: it answers exactly one question and refuses nothing, because refusing a malformed flag here would be
 * a SECOND place that call ever gets rejected — `parseOperationArgv` already owns that.
 *
 * @param {string[]} [argv]
 * @returns {boolean}
 */
export function hasJsonFlag(argv = []) {
  return argv.some((token) => {
    if (typeof token !== 'string' || !token.startsWith('--')) return false;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    return name === 'json';
  });
}

/**
 * WHAT `--cwd` ON THIS ARGV NAMES, or `null`. The EXACT sibling of {@link hasJsonFlag} above — same "usable
 * before a declaration exists" reason, same deliberate narrowness (it answers one question and refuses
 * nothing; `parseOperationArgv` still owns rejection).
 *
 * WHY IT HAD TO EXIST (live-caught 2026-09-12 against PR #2122, which merged ON the defect). `--cwd` reached
 * ONLY the judge factory (`we:scripts/operations/run.mjs#createCliJudgeFactory`, via `parsed.control.cwd`),
 * never the READER — `OPERATIONS[review-pr]` built `createReviewPrReader()` with no arguments, so the diff was
 * always taken from `REPO_ROOT` whatever lane the caller named. In a single-branch lane clone with no
 * remote-tracking ref for the PR's head branch that resolved to `degraded: true, degradedReason:
 * 'ref-unresolved'` and a ZERO-LENGTH diff, and every seat "reviewed" nothing. The reader is built inside
 * `resolveOperation`, which runs BEFORE `parseOperationArgv` (it is what supplies the declaration that parse
 * needs), so the value has to be read off raw argv here exactly as `--json` is.
 *
 * BOTH SPELLINGS, `--cwd <value>` included: `parseOperationArgv` accepts the space-separated form for control
 * flags, so a reader that only understood `--cwd=<value>` would silently fall back to `REPO_ROOT` for the very
 * invocation shape that DID name a lane.
 *
 * @param {string[]} [argv]
 * @returns {string|null}
 */
export function cwdFlagValue(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name !== 'cwd') continue;
    const value = eq === -1 ? argv[i + 1] : token.slice(eq + 1);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) return null;
    return value.trim();
  }
  return null;
}

/**
 * PARSE argv against a declaration. PURE — no process, no env. Unknown flags are REFUSED (the declaration is
 * the whole surface, and `validateInput` already fails closed in both directions; this makes the message
 * arrive before a run exists).
 *
 * @param {object} declaration
 * @param {string[]} argv
 * @returns {{ok: boolean, input: object, control: object, errors: string[]}}
 */
export function parseOperationArgv(declaration, argv = []) {
  const spec = buildCliSpec(declaration);
  const known = new Set(spec.fields.map((f) => f.name));
  const confirmTime = new Set(confirmTimeFields(declaration));
  const judged = declaresJudgeStep(declaration);
  const errors = [];
  const raw = {};
  // `confirm` holds the CONFIRM-TIME inputs. They are declared inputs, so they are NOT control flags and are
  // deliberately not siblings of `resume`/`answer` here — but they arrive on the resume call rather than the
  // opening one, so they cannot travel in `input` either, which is what `--resume` refuses.
  const control = {
    help: false, json: false, resume: '', answer: null, runId: '', cwd: '', model: '', provider: '', confirm: {},
  };

  for (const token of argv) {
    if (!token.startsWith('--')) { errors.push(`unexpected positional argument ${JSON.stringify(token)} — every input is a --flag`); continue; }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value = eq === -1 ? '' : token.slice(eq + 1);
    if (name === 'help') { control.help = true; continue; }
    if (name === 'json') { control.json = true; continue; }
    if (name === 'resume') { control.resume = value; continue; }
    if (name === 'answer') { control.answer = value; continue; }
    if (name === 'run-id') { control.runId = value; continue; }
    // ── THE CONFIRM-TIME INPUTS (#3035) ────────────────────────────────────────────────────────────────────
    // Declared inputs, coerced against their declared type exactly like any other — they differ only in WHICH
    // call carries them. Handled before the `known` branch below so they never land in `raw`, because `raw` is
    // what the `--resume carries no input` refusal counts and these are the one kind of input that may.
    if (confirmTime.has(name)) {
      const field = spec.fields.find((f) => f.name === name);
      const coerced = coerceInputValue(field.type, value);
      if (coerced === undefined) { errors.push(`--${name} must be a ${field.type}, got ${JSON.stringify(value)}`); continue; }
      control.confirm[name] = coerced;
      continue;
    }
    // ── THE JUROR FLAGS (#3151) ────────────────────────────────────────────────────────────────────────────
    // Refused where there is no juror, because a flag that silently does nothing is the failure this card is
    // about; an empty value is refused here rather than downstream, where `assertLaneCwd`'s "no `cwd` was
    // supplied" would name a cause the operator can see they DID supply.
    if (JUROR_FLAGS.includes(name)) {
      if (!judged) {
        const purpose = name === 'cwd' ? 'point at a lane' : name === 'provider' ? 'pick an implementation for' : 'pick a model for';
        errors.push(
          `--${name} needs a \`judge\` step, and \`${declaration.name}\` declares none `
          + `(${declaration.steps.map((s) => s.step.kind).join(' → ')}) — there is no juror to ${purpose}.`,
        );
        continue;
      }
      // GIVEN TWICE IS A REFUSAL, not last-wins (PR review, finding G). Every other flag here silently takes
      // the last spelling, which is a fine default for a value that only shapes output — but `--cwd` decides
      // WHERE A TOOL-BEARING AGENT MAY WRITE, and a shell loop or a copy-paste that emits it twice should not
      // resolve that quietly in favour of whichever came last.
      if (control[name]) { errors.push(`--${name} was given more than once — pass it once, or the wrong one wins silently`); continue; }
      if (!value.trim()) { errors.push(`--${name} must not be empty — pass a value or omit the flag`); continue; }
      // A VALUE SHAPED LIKE A FLAG IS REFUSED BEFORE IT IS A VALUE (#3028's footgun, at the parse seam). The
      // juror's argv builder guards this too, but a refusal that arrives before a run record exists names the
      // TOKEN the operator typed instead of a request the adapter assembled.
      if (value.trim().startsWith('-')) {
        errors.push(`--${name}=${JSON.stringify(value)} looks like a flag, not a value — refusing it before it reaches the juror's argv (#3028)`);
        continue;
      }
      // #xqa9ttq — `--provider` is a closed enum, unlike `--cwd`/`--model`'s free-form values: an unrecognised
      // name is refused HERE, at the parse seam, rather than reaching `createDefaultJudge`'s own resolution
      // and failing with a message that never mentions the command line the operator actually typed.
      if (name === 'provider' && !JUDGE_PROVIDER_NAMES.includes(value.trim())) {
        errors.push(`--provider must be one of ${JUDGE_PROVIDER_NAMES.join('|')}, got ${JSON.stringify(value.trim())}`);
        continue;
      }
      control[name] = value.trim();
      continue;
    }
    if (!known.has(name)) {
      // THE ACCEPTED LIST NAMES THE CONTROL FLAGS TOO. Listing only the declared inputs is what made
      // `unknown flag --cwd` a dead end: the message enumerated five fields, none of which was the answer, so a
      // reader concluded the operation could not take one. The list is the whole surface or it is a trap.
      // EVERY HALF OF THIS LIST IS DERIVED, not just the juror half. Naming `--resume`/`--answer`/`--run-id` on
      // a `compute`-only operation would advertise flags the usage text three lines below says cannot apply —
      // the same "listed as accepted, refused in practice" trap the juror flags are filtered for.
      // The filter now lives in `acceptedControlFlags` so the #3253 gate asks the same question rather than
      // re-deriving it — this refusal and that gate must never disagree about what is accepted.
      const accepted = [...known, ...acceptedControlFlags(declaration)];
      errors.push(`unknown flag --${name} — \`${declaration.name}\` accepts ${accepted.map((k) => `--${k}`).join(', ')}`);
      continue;
    }
    const field = spec.fields.find((f) => f.name === name);
    const coerced = coerceInputValue(field.type, value);
    if (coerced === undefined) { errors.push(`--${name} must be a ${field.type}, got ${JSON.stringify(value)}`); continue; }
    raw[name] = coerced;
  }

  // A resume carries no input — the run record already holds it. Passing both is a confusion worth refusing.
  if (control.resume && Object.keys(raw).length) {
    errors.push('a --resume carries no input: the run record already holds it. Drop the input flags.');
  }
  // A CONFIRM-TIME INPUT QUALIFIES AN ANSWER, so it is meaningless without one. Refused rather than ignored: a
  // value silently dropped is worse than one never given, because the caller believes it was recorded.
  for (const name of Object.keys(control.confirm)) {
    if (control.answer == null) errors.push(`--${name} qualifies a --answer; pass both, or neither.`);
  }
  // THE STOP-POINT PROPERTY. You cannot answer a question that has not been asked.
  if (control.answer != null && !control.resume) {
    errors.push(
      '--answer requires --resume=<run-id>. The confirm step is a SUSPEND: the operation asks, exits, and is '
      + 'resumed with the decision in a second invocation. There is no way to pre-answer it.',
    );
  }
  if (!control.resume) {
    const validated = validateInput(declaration.input, raw);
    errors.push(...validated.errors);
    return { ok: errors.length === 0, input: validated.value, control, errors };
  }
  return { ok: errors.length === 0, input: {}, control, errors };
}

/**
 * REFUSE a judge request whose option values could reach a flag position in the juror's argv.
 *
 * #3028's recorded footgun, one layer out: an option *value* shaped like a flag (`model: '--bare'`) reaches
 * `buildJudgeArgv` and lands in argv as a flag. `assertNoForbiddenArgv` catches the one banned spelling; this
 * catches the CLASS, before the spawn, for every declaration — because a declaration is allowed to build its
 * request from run input and an adapter must not assume it validated it.
 *
 * @param {object} request
 */
export function assertSafeJudgeRequest(request) {
  for (const key of ['model', 'effort']) {
    const value = request?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-')) {
      throw new Error(
        `operations: refusing to spawn a juror with \`${key}\`=${JSON.stringify(value)} — an option value shaped `
        + 'like a flag reaches the juror\'s argv as a flag (#3028). Declarations must not build judge requests '
        + 'from unvalidated input.',
      );
    }
  }
  const effortLevels = request?.providerName === 'codex' ? Object.keys(CODEX_EFFORT_MAP) : EFFORT_LEVELS;
  if (request?.effort !== undefined && !effortLevels.includes(request.effort)) {
    throw new Error(`operations: \`effort\` must be one of ${effortLevels.join('|')}, got ${JSON.stringify(request.effort)}`);
  }
  // `null` is the DECLARED "no ceiling", and it has to be spelled out HERE as well as in `judgeSpawn`. This
  // guard runs on the request BEFORE the spawn, in a file the budget change never touched, so a `budget: null`
  // that `judgeSpawn` accepts still threw right here — before a juror existed. "Remove the ceiling" would have
  // shipped as "no review runs at all". Two validations of one field is fine; two DIFFERENT rules for it is the
  // defect (review-pr correctness juror on #1472: CONFIRMED, `impactIfUnfixed: broken`, a blocker because
  // nothing downstream could recover from it).
  if (request?.budget !== undefined && request?.budget !== null
      && (typeof request.budget !== 'number' || !Number.isFinite(request.budget) || request.budget <= 0)) {
    throw new Error(`operations: \`budget\` must be a positive finite number of USD, or null for no ceiling, got ${JSON.stringify(request.budget)}`);
  }
  // A tool name reaches argv as a bare token, so the same flag-shaped-value hazard applies one field over.
  if (request?.allowedTools !== undefined) {
    if (!Array.isArray(request.allowedTools) || request.allowedTools.length === 0) {
      throw new Error('operations: `allowedTools` must be a non-empty array when present — omit it for a tool-free juror');
    }
    for (const t of request.allowedTools) {
      if (typeof t !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) {
        throw new Error(`operations: refusing a juror tool name ${JSON.stringify(t)} — a non-identifier reaches argv as a flag`);
      }
    }
  }
  assertNoForbiddenArgv([request?.model, request?.effort, ...(request?.allowedTools ?? [])].filter((t) => typeof t === 'string'));
}

/**
 * THE BRAND on a judge return that carries telemetry alongside the answer.
 *
 * A judge is injected (`driveRun({ judge })`) and the ordinary implementation returns the juror's answer
 * directly — every test in the suite does. So the adapter has to tell "this IS the answer" from "this WRAPS
 * the answer", and sniffing for a `value` key would misread any future juror shape that happens to have one.
 * A registered symbol cannot appear in JSON a juror produced, so the test is exact rather than probable.
 * `Symbol.for` (not a bare `Symbol`) so two copies of this module in one process still agree.
 */
const JUDGE_OUTCOME = Symbol.for('we.operations.judgeOutcome');

/**
 * Wrap a juror answer with the SPAWN's telemetry, for a judge that has it. `driveRun` unwraps.
 * @param {*} value - the juror's answer, exactly as it would be returned bare.
 * @param {object|null} [telemetry] - `judgeSpawn`'s metered fields (see `normalizeJudgeTelemetry`).
 */
export function judgeOutcome(value, telemetry = null) {
  return { [JUDGE_OUTCOME]: true, value, telemetry };
}

/** Split a judge's return into `{ value, telemetry }`. A bare answer is the answer, with no telemetry. */
export function unwrapJudgeOutcome(returned) {
  return (returned && typeof returned === 'object' && returned[JUDGE_OUTCOME] === true)
    ? { value: returned.value, telemetry: returned.telemetry ?? null }
    : { value: returned, telemetry: null };
}

/**
 * @typedef {object} JudgeProviderRequest
 * @property {string} mandate - the juror's stable system-prompt instruction.
 * @property {string} input - the material to judge, exactly as the engine's `judge` step declared it.
 * @property {object} shape - JSON Schema the answer is forced to satisfy.
 * @property {string} [model] - the model alias/name to judge with.
 * @property {string} [effort] - one of `judge-spawn.mjs`'s `EFFORT_LEVELS`.
 * @property {number|null} [budget] - a hard USD ceiling, or `null` for none.
 * @property {string} [runId] - run identity, for a deterministic actor id.
 * @property {string} [lens] - lens name, mixed into a panel's actor id alongside `runId`.
 * @property {string[]} [allowedTools] - a non-empty tool allow-list; omitted entirely for a tool-free juror.
 * @property {string} [cwd] - the juror's lane. Required by a real provider whenever `allowedTools` is set.
 */

/**
 * @typedef {object} JudgeProviderOutcome
 * @property {object} value - the juror's answer, already validated against `shape`.
 * @property {string} [sessionId] - which actor judged.
 * @property {number} [costUsd]
 * @property {number} [durationMs]
 * @property {number} [wallMs]
 * @property {number} [numTurns]
 * @property {string} [stopReason]
 * @property {object} [usage]
 * @property {number} [loadedContextTokens]
 * @property {boolean} [timedOut]
 */

/**
 * @typedef {(request: JudgeProviderRequest) => Promise<JudgeProviderOutcome>} JudgeProvider
 *
 * THE PORT (#3370, under #3369). This is the engine's `judge(request) → outcome` contract, named as a
 * stable boundary rather than left as an inferred function signature: what a provider RECEIVES
 * (`JudgeProviderRequest`, the same request shape a declaration already builds) and what it must RETURN
 * (`JudgeProviderOutcome`, the shape `parseJudgeOutcome` produces today) — independent of any CLI's argv
 * or stdout format. `judgeSpawn` (`we:scripts/lib/judge-spawn.mjs`) is ONE implementation of this port, not
 * the port itself: its Claude-specific argv construction and stdout parsing stay exactly where they are,
 * and a second implementation (#3371) satisfies this same shape without either side of `judgeSpawn`
 * changing. `createDefaultJudge` below is the only place a provider is bound to the engine.
 */

/**
 * #xqa9ttq — RESOLVE A NAMED `JudgeProvider`. The only place a provider NAME (a string an operator can type
 * on a command line) becomes a provider FUNCTION. `'claude'` is `judgeSpawn`, unchanged and untransformed —
 * this card must not alter what a Claude-backed juror is asked for. `'codex'` wraps `codexJudgeSpawn` with
 * the ONE thing `#3371`'s probe found mandatory before any real shape survives the trip: every judge shape in
 * this repo uses OPTIONAL properties, and OpenAI's strict structured-output dialect 400s on that (probe 3) —
 * so the request's `shape` is run through `requireAllProperties` (`we:scripts/lib/codex-judge-spawn.mjs`) HERE,
 * at the provider boundary, never inside `codexJudgeSpawn` itself (its own header explains why: so its unit tests can
 * exercise the untransformed contract, and so a caller with an already-strict schema is not silently
 * double-transformed) and never by mutating the shared shape constants (`REVIEW_JUDGE_SHAPE` and friends stay
 * exactly as they are for the Claude path, which is the other half of the same probe-3 finding).
 *
 * @param {string} name - one of `JUDGE_PROVIDER_NAMES`.
 * @returns {JudgeProvider}
 */
export function resolveJudgeProvider(name) {
  if (name === 'codex') {
    // `model: CODEX_MODEL` is a DEFAULT, spread first — a request that already names its own `model` (an
    // operator override) still wins, exactly like every other override in this file.
    return (request) => codexJudgeSpawn({ model: CODEX_MODEL, ...request, shape: requireAllProperties(request.shape) });
  }
  // #3383 — `'antigravity'` wraps `antigravityJudgeSpawn` the same way, `model: ANTIGRAVITY_MODEL` spread
  // first so an operator/request override still wins. NO schema transform — unlike Codex, `agy` accepts this
  // repo's OPTIONAL-property shapes untransformed (`antigravity-judge-spawn.mjs`'s own header, item 3), so
  // there is nothing analogous to `requireAllProperties` to run here.
  if (name === 'antigravity') {
    return (request) => antigravityJudgeSpawn({ model: ANTIGRAVITY_MODEL, ...request });
  }
  if (name === 'claude' || name == null) return judgeSpawn;
  throw new Error(`operations: unknown judge provider ${JSON.stringify(name)} — one of ${JUDGE_PROVIDER_NAMES.join('|')}`);
}

/**
 * #xqa9ttq - a codex request never carries a Claude model name; an EMPTY `allowedTools` array is the explicit
 * tool-free signal and is dropped so the shared guard (`assertSafeJudgeRequest`, which rejects `[]` for every
 * provider) does not refuse it. Codex-only: the claude path never calls this. Returns a shallow copy.
 */
function stripForCodex(request) {
  if (!request) return request;
  const { model: _unusedModel, allowedTools, ...rest } = request;
  if (Array.isArray(allowedTools) && allowedTools.length === 0) return rest;
  return { ...rest, ...(allowedTools !== undefined ? { allowedTools } : {}) };
}

/**
 * #3383 — THE TOOL-FREE PROVIDER NAMES: both `'codex'` and `'antigravity'` are structurally tool-free seats
 * (see each module's own header for why), so both share the SAME two guards below — the model-merge exclusion
 * and the tool-bearing refusal — rather than duplicating an `effectiveProviderName === 'codex'` check per
 * provider as they are added. A single named list so a THIRD tool-free provider, if one is ever added, extends
 * both guards by editing one array rather than two `if` conditions.
 */
export const TOOL_FREE_JUDGE_PROVIDER_NAMES = Object.freeze(['codex', 'antigravity']);

/**
 * #x5s8b47 — WHICH PROVIDER COVERS FOR WHICH, when a `gracefulOnUnavailable` judge request's own provider is
 * quota-held (see {@link createDefaultJudge}'s graceful-degradation path). `antigravity` is the only OTHER
 * tool-free judge provider this engine wires (see {@link TOOL_FREE_JUDGE_PROVIDER_NAMES}), so it is codex's
 * one fallback. No entry for antigravity itself — a lookup miss reads as "no further fallback".
 */
export const PROVIDER_QUOTA_FALLBACK = Object.freeze({ codex: 'antigravity' });

/**
 * Is `providerName` sitting out a quota hit, per the SAME shared review-seat scorecard store
 * `review-extra-seats.mjs#quotaHold` already reads for its own bonus-seat path? REUSED, not restated: this
 * calls that exact function rather than re-deriving the exhausted/gauge-percent logic a second time.
 *
 * A DYNAMIC import, deliberately, not a static one: `review-extra-seats.mjs` pulls in a heavier tree
 * (`review-dispatch.mjs`, `review-core.mjs`, and from there `markdown-it`) than this file wants at its OWN
 * module-load time — this file's own header (`requireAllProperties`'s import note) already records the
 * #2273/#2274 regression that taught that a static import of a `markdown-it`-adjacent module here breaks the
 * lightweight CLI entry points (`we:scripts/backlog.mjs` among them) that load `cli-adapter.mjs` from a tree
 * with no `node_modules` at all. A static import of `review-extra-seats.mjs` would pay that cost for EVERY
 * such caller, whether or not it ever seats a graceful judge request; the dynamic import here pays it only
 * when a request actually opts in (today, only `review-pr`'s `judgeAdvisory` seat).
 *
 * Never throws: an unreadable store, a failed import, or any other scan error reads as "no records", which
 * `quotaHold` itself already treats as usable — the same fail-open posture `review-extra-seats.mjs` takes on
 * its own read (`runExtraSeats`'s `catch` around `io.readRecords()`).
 * @param {string} providerName
 * @param {number} when - epoch ms.
 * @returns {Promise<string|null>} the hold reason, or null when usable.
 */
export async function defaultProviderQuotaHold(providerName, when) {
  try {
    const [{ quotaHold }, { readStore }] = await Promise.all([
      import('./review-extra-seats.mjs'),
      import('../conveyor/run-scorecard-store.mjs'),
    ]);
    return quotaHold(readStore().records, providerName, when);
  } catch {
    return null;
  }
}

/**
 * THE PROVIDER CALL'S OWN OPTION OBJECT — extracted from {@link createDefaultJudge} (#x5s8b47) so the
 * graceful-degradation path's fallback spawn builds it identically to the ordinary path, rather than a second,
 * driftable copy. Byte-identical to what that function built inline before this extraction; see the inline
 * comments this carries forward for why each conditional spread exists.
 * @param {object} effective
 * @param {string|null} cwd
 * @param {string} effectiveProviderName
 */
function buildProviderRequest(effective, cwd, effectiveProviderName) {
  return {
    mandate: effective.mandate,
    input: effective.input,
    shape: effective.shape,
    // #3383 mechanical-dispatcher Gap 2 root cause fix — omitted, not present-and-`undefined`, when the
    // declaration deliberately asks for no model override, so each provider's OWN default applies. See the
    // full account in this function's pre-extraction history (git blame) if this ever needs re-deriving.
    ...(effective.model !== undefined ? { model: effective.model } : {}),
    effort: effective.effort,
    budget: effective.budget,
    runId: effective.runId,
    lens: effective.lens,
    ...(effective.allowedTools ? { allowedTools: effective.allowedTools } : {}),
    // #4446 - keyed on the tool-free capability (codex AND antigravity), not on a provider-name literal.
    // #xqa9ttq (PR #2117 review, CONFIRMED) - a codex request NEVER receives the factory's lane cwd: the seat
    // is tool-free and diff-only, and `-C <lane>` would load the untrusted PR checkout's AGENTS.md into it.
    ...(cwd && !TOOL_FREE_JUDGE_PROVIDER_NAMES.includes(effectiveProviderName) ? { cwd } : {}),
  };
}

/** THE TELEMETRY HALF of a provider outcome, extracted alongside {@link buildProviderRequest} for the same
 *  reason — reused by both the ordinary and the graceful-degradation spawn paths. */
function judgeTelemetryFrom(outcome, effective) {
  return {
    costUsd: outcome.costUsd,
    durationMs: outcome.durationMs,
    wallMs: outcome.wallMs,
    numTurns: outcome.numTurns,
    stopReason: outcome.stopReason,
    sessionId: outcome.sessionId,
    loadedContextTokens: outcome.loadedContextTokens,
    usage: outcome.usage,
    transcriptFile: outcome.transcriptFile,
    timedOut: outcome.timedOut,
    model: outcome.servedModel ?? effective.model,
    ...pickAgyEvidence(outcome),
  };
}

/**
 * The default judge: ONE tool-free juror per `judge` step, guarded by {@link assertSafeJudgeRequest}.
 *
 * IT RETURNS WHAT THE SPAWN COST, not only what the juror said. `judgeSpawn` reports `costUsd`, `sessionId`,
 * `usage`, `durationMs` and `wallMs`; the first cut returned `outcome.value` alone, so after #3035's first live
 * run against PR #1146 "what did that juror cost?" had no answer anywhere — the numbers existed for the length
 * of one expression and were dropped. The juror also runs `--no-session-persistence` (a #3028 isolation
 * property, deliberately unchanged here), so there is no transcript to reconstruct them from either. They ride
 * back through {@link judgeOutcome} onto the run record, which is where a completed run and `--json` read them.
 *
 * @param {object} [o]
 * @param {JudgeProvider} [o.provider] - the provider port implementation, injected for tests. Defaults to
 *   `resolveProvider(providerName)`, so an operator who supplies `providerName` alone (the normal command
 *   line case) never has to also know what function that name resolves to.
 * @param {string|null} [o.providerName] - #xqa9ttq/#3383 — `'claude'` (default), `'codex'`, or `'antigravity'`,
 *   one of `JUDGE_PROVIDER_NAMES`. IGNORED once `provider` is explicitly supplied — that is what keeps every
 *   existing test that injects a stub `provider` untouched by this card. IGNORED, per call, whenever THAT
 *   call's own `request.providerName` is set — see the per-request override note below.
 * @param {string|null} [o.cwd] - the lane the juror runs in. Passed only when set, so a tool-free juror is
 *   unaffected and a tool-bearing one hits `assertLaneCwd`'s refusal when nobody supplied a lane (#3151).
 *   Never forwarded to an effectively-codex request.
 * @param {string|null} [o.model] - an operator override for the model the DECLARATION asked for. Absent by
 *   default: the declared literal is the norm, and an override is a deliberate command-line act. Never merged
 *   onto a request whose EFFECTIVE provider (request-level or factory-level) is tool-free
 *   ({@link TOOL_FREE_JUDGE_PROVIDER_NAMES}) — see below.
 * @param {(name: string) => JudgeProvider} [o.resolveProvider] - #xqa9ttq — how a per-request `providerName`
 *   (and, absent one, the factory's own `providerName`) becomes a provider FUNCTION. Defaults to the real
 *   {@link resolveJudgeProvider}; injectable so a test can substitute BOTH providers at once without touching
 *   the `codex-judge-spawn.mjs` module boundary — the seam `judge-provider-selection.test.mjs` already uses at
 *   the `resolveJudgeProvider` layer, extended here to the per-request path.
 * @param {(providerName: string, when: number) => Promise<string|null>} [o.checkProviderHold] - #x5s8b47 —
 *   ONLY consulted for a request carrying `gracefulOnUnavailable: true`. Defaults to the real
 *   {@link defaultProviderQuotaHold}; injectable so a test drives the graceful path with no real scorecard
 *   store on disk.
 * @param {() => number} [o.now] - #x5s8b47 — mints the instant the graceful path checks quota-hold against.
 *   Injected, never `Date.now()` read ad hoc, mirroring `driveRun`'s own `clock` seam.
 * @param {(line: string) => void} [o.logGracefulOutcome] - #x5s8b47 — where a skip or a caught crash is
 *   logged. Defaults to a bare stderr write; injectable so a test can assert on it without capturing real
 *   process streams.
 */
export function createDefaultJudge({
  provider, providerName: factoryProviderName, cwd: factoryCwd, model, operation = 'judge', resolveProvider = resolveJudgeProvider,
  checkProviderHold = defaultProviderQuotaHold,
  now = () => Date.now(),
  logGracefulOutcome = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* best effort */ } },
  // Card 84 — the seat runner a `seatProvider` request goes to. Injectable so a test drives THIS wrapper (not the
  // runner alone) with no agy; the default is a dynamic import (see the call site).
  seatRunner = async (...args) => (await import('./review-seat-runner.mjs')).runSeatWithProvider(...args),
} = {}) {
  const providerName = factoryProviderName ?? 'claude';
  // `opts.cwd` — a seat given a lane of its OWN by a concurrent batch (`./parallel-judges.mjs`) runs there instead of
  // in the factory's lane. Absent, the factory's `cwd` applies exactly as before.
  const judge = async (request, opts = null) => {
    const cwd = opts?.cwd || factoryCwd;
    // #xqa9ttq — A REQUEST MAY PIN ITS OWN PROVIDER (`request.providerName`), overriding this factory's. This
    // is what lets ONE run seat a tool-free Codex juror (`review-pr`'s opt-in `judgeAdvisory` seat) while its
    // OTHER judge steps stay on the factory's own provider (`claude` by default, or whatever `--provider`
    // chose) — a single `--provider` for the WHOLE run cannot do this: `review-pr`'s two existing seats set
    // `allowedTools` unconditionally, and Codex structurally refuses a tool-bearing request (the guard below),
    // so `--provider=codex` against a real run fails at the first tool-bearing seat — confirmed live against a
    // real run before this seam existed.
    if (request?.providerName !== undefined && !JUDGE_PROVIDER_NAMES.includes(request.providerName)) {
      throw new Error(
        `operations: unknown judge provider ${JSON.stringify(request.providerName)} on a judge request — one of `
        + `${JUDGE_PROVIDER_NAMES.join('|')}`,
      );
    }
    // An explicit pin (request-level provider, factory provider/providerName, or factory model) outranks the policy default.
    const pinned = request?.providerName !== undefined || factoryProviderName !== undefined || provider !== undefined || model !== undefined;
    const configured = pinned ? null : resolveOperationRoute({ operation: operation === 'judge' ? 'judge' : `judge:${operation}`, taskType: request?.mandate?.lens ?? request?.lens, available: JUDGE_PROVIDER_NAMES });
    const effectiveProviderName = configured?.provider ?? request?.providerName ?? providerName;
    // #xqa9ttq (PR #2115 review, CONFIRMED) - `allowedTools: []` is the explicit "no tools" signal
    // `assertNoCodexToolAllowlist` documents as tool-free. `assertSafeJudgeRequest` is shared with claude and
    // rejects [], so the empty array is dropped for an effectively-codex request ONLY, before the guard runs;
    // claude keeps refusing it.
    const declared = effectiveProviderName === 'codex' ? stripForCodex(request) : request;
    // THE OVERRIDE IS MERGED BEFORE THE GUARD RUNS, NEVER AFTER (#3151). `assertSafeJudgeRequest` is what stops
    // a flag-shaped `model` reaching argv, so asserting the declaration's request and then substituting the
    // operator's value would check one string and spawn another — the guard would be decorative. The CLI
    // adapter's parse refuses a `-`-leading value too; this is the seam that binds every caller of this
    // factory, including one that builds it by hand.
    //
    // #xqa9ttq/#3383 — NEVER MERGED ONTO AN EFFECTIVELY TOOL-FREE REQUEST (`codex` OR `antigravity`). `model`
    // here is a Claude model name (the declaration's `JUDGE_MODEL` literal, or whatever the operator typed for
    // the seat(s) they are steering with `--model`); a request whose effective provider is tool-free (via
    // `request.providerName` or this factory's own) would otherwise carry that Claude model name onto the
    // other CLI's own model flag verbatim.
    const effective = configured ? { ...declared, providerName: configured.provider, model: configured.model, effort: configured.effort } : (model && !TOOL_FREE_JUDGE_PROVIDER_NAMES.includes(effectiveProviderName)) ? { ...declared, model } : declared;
    assertSafeJudgeRequest(effective);
    // #xqa9ttq/#3383 — TOOL-FREE ONLY, ENFORCED HERE TOO, not only inside each provider's own spawn module. A
    // caller that injects its own `provider` function bypasses `resolveProvider` entirely, so this check is the
    // one place that catches "tool-free provider + tool-bearing request" regardless of HOW that provider got
    // here — the same belt-and-braces reasoning `assertNoForbiddenArgv`'s "reachable through judgeSpawn too"
    // note already uses. Reads `effectiveProviderName` (request-level override included), not the factory's
    // own `providerName` alone — otherwise a factory defaulted to `claude` with a request pinned to a tool-free
    // provider would sail past this.
    if (TOOL_FREE_JUDGE_PROVIDER_NAMES.includes(effectiveProviderName) && effective.allowedTools) {
      throw new Error(
        `operations: refusing \`--provider=${effectiveProviderName}\` with a TOOL-BEARING judge request — the `
        + `${effectiveProviderName} provider is seated as a TOOL-FREE panelist only (#3581/#3383). Use the `
        + 'default `claude` provider for a tool-bearing role.',
      );
    }
    // #x5s8b47 — THE GRACEFUL-DEGRADATION PATH. A request opts in with `gracefulOnUnavailable: true` (today,
    // only `review-pr`'s `judgeAdvisory` seat — see its own `buildReviewAdvisoryJudgeRequest`) to say: this
    // seat is ADVISORY (its per-lens verdict cannot, by construction, block the panel — see that seat's own
    // docblock), so its provider being unavailable is a SKIP, never a run failure. Two failure modes this
    // closes, both measured live against PRs #2865/#2867/#2873/#2874/#2875 (card x5s8b47): (a) Codex
    // quota-exhausted — the spawn was never even attempted before this fix, so it failed every time and
    // crashed the whole `review-loop-cli` process; and (b) the spawn throwing for any OTHER reason, mid-call.
    // NEITHER may propagate past this function for a graceful request: both become a recorded, zero-finding,
    // non-blocking judge answer instead. `reduce`'s own silent-juror refusal (`review-pr.mjs`) requires a
    // non-empty `summary`, which the skip answer below always carries, so a skip reads to every downstream
    // consumer as an ordinary — if uninformative — juror answer, never as `unrun`.
    if (effective.gracefulOnUnavailable === true) {
      const at = now();
      const primaryHold = await checkProviderHold(effectiveProviderName, at);
      let spawnProviderName = effectiveProviderName;
      let holdReason = primaryHold;
      if (primaryHold) {
        let fallbackName = configured ? null : PROVIDER_QUOTA_FALLBACK[effectiveProviderName];
        if (configured) {
          for (const route of configured.fallback) {
            if (!await checkProviderHold(route.provider, at)) { fallbackName = route.provider; break; }
          }
        }
        const fallbackHold = fallbackName ? await checkProviderHold(fallbackName, at) : null;
        if (fallbackName && !fallbackHold) {
          // The fallback is usable: spend IT instead of skipping outright. `effective` needs no rebuilding —
          // it already carries no `model`/`allowedTools` for a tool-free seat (see the guards above), which is
          // exactly what the fallback provider needs too.
          spawnProviderName = fallbackName;
          holdReason = null;
        } else {
          holdReason = fallbackName
            ? `${primaryHold}; fallback \`${fallbackName}\` unavailable too (${fallbackHold})`
            : `${primaryHold} (no fallback provider configured for \`${effectiveProviderName}\`)`;
        }
      }
      const skipOutcome = (reason, extra = {}) => judgeOutcome({
        summary: `skipped: ${reason}`,
        findings: [],
        skipped: { provider: effectiveProviderName, reason, ...extra },
      });
      if (holdReason) {
        logGracefulOutcome(`judge seat skipped — ${effectiveProviderName} unavailable: ${holdReason}`);
        return skipOutcome(holdReason);
      }
      const spawnProvider = spawnProviderName === effectiveProviderName
        ? (configured ? resolveProvider(effectiveProviderName) : request?.providerName !== undefined ? resolveProvider(request.providerName) : (provider ?? resolveProvider(providerName)))
        : resolveProvider(spawnProviderName);
      try {
        const actual = configured && spawnProviderName !== effectiveProviderName ? { ...effective, ...configured.fallback.find(route => route.provider === spawnProviderName), providerName: spawnProviderName } : effective;
        const outcome = await spawnProvider(buildProviderRequest(actual, cwd, spawnProviderName));
        // NOT a spread of `outcome` — see the ordinary path's own note just below.
        return judgeOutcome(outcome.value, judgeTelemetryFrom(outcome, actual));
      } catch (e) {
        const reason = `spawn failed — ${String(e?.message ?? e).slice(0, 500)}`;
        logGracefulOutcome(`judge seat crashed, recorded as skipped — ${spawnProviderName}: ${reason}`);
        return e?.telemetry
          ? judgeOutcome({ summary: `skipped: ${reason}`, findings: [], skipped: { provider: spawnProviderName, reason } }, judgeTelemetryFrom(e.telemetry, effective))
          : skipOutcome(reason, { provider: spawnProviderName, crashed: true });
      }
    }

    // #xqa9ttq — RESOLUTION ORDER. A REQUEST-level `providerName` always resolves via `resolveProvider` (the
    // real one by default) — it names a concrete provider the request itself insists on, so an unrelated
    // `provider` stub injected at the FACTORY level (there for a DIFFERENT seat's test) must not silently
    // intercept it. Absent a request-level override, behaviour is BYTE-IDENTICAL to before this card: the
    // factory's own injected `provider` wins over its own `providerName`.
    const resolvedProvider = configured ? resolveProvider(effectiveProviderName) : request?.providerName !== undefined
      ? resolveProvider(request.providerName)
      : (provider ?? resolveProvider(providerName));
    // #3383 mechanical-dispatcher Gap 2 root cause fix — see `buildProviderRequest`'s own comment for the full
    // account of why `model`/`cwd` are conditionally spread rather than always present.
    const outcome = await resolvedProvider(buildProviderRequest(effective, cwd, effectiveProviderName));
    // NOT a spread of `outcome`: it also carries `argv` (which embeds the whole mandate) and the answer itself.
    // The record keeps the meter, never the material. `normalizeJudgeTelemetry` whitelists again on arrival.
    return judgeOutcome(outcome.value, judgeTelemetryFrom(outcome, effective));
  };
  // Card 84 — a request carrying a `seatProvider` directive (`review.seatProvider.<lens>` = agy | shadow, or the
  // advisory agy seat) runs through the seat runner, which calls `judge` above for every Claude juror it needs.
  // A DYNAMIC import, like `defaultProviderQuotaHold`'s: this file is loaded by lightweight CLIs that never seat one.
  return async (request, opts = null) => {
    if (request?.seatProvider == null) return judge(request, opts);
    const laneCwd = opts?.cwd || factoryCwd;
    return seatRunner(request, { claudeJudge: (r) => judge(r, opts), unwrap: unwrapJudgeOutcome, wrap: judgeOutcome, cwd: laneCwd ?? null });
  };
}

/**
 * The nearest `confirm`-kind step BELOW `stepIndex` that already holds a finding — i.e. an answer a caller
 * already gave, and that `driveRun` is about to re-encounter on a `--resume`. `null` when the refusing step
 * is the first, or nothing below it is a `confirm` with a recorded finding. PURE — reads only the
 * declaration's step list and the run's own findings.
 *
 * @param {object} declaration
 * @param {object} run
 * @param {number} stepIndex - the refusing step's index (`declaration.steps[stepIndex]`).
 * @returns {{step: string, value: *}|null}
 */
function findPriorConfirm(declaration, run, stepIndex) {
  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    const entry = declaration.steps[i];
    if (entry.step.kind === 'confirm' && Object.prototype.hasOwnProperty.call(run.findings ?? {}, entry.name)) {
      return { step: entry.name, value: run.findings[entry.name] };
    }
  }
  return null;
}

/**
 * MOVE AN OPEN STEP-TIMING ROW'S START to when the step really started (`review.parallelSeats`). PURE. A seat run in
 * a concurrent batch started when the batch launched it, which is earlier than when the engine reaches it to commit
 * its answer. No open row for `stepIndex` → `run` unchanged, the same no-fabrication rule as `withStepFinish`.
 * @param {object} run
 * @param {number} stepIndex
 * @param {string} at - ISO instant.
 * @returns {object}
 */
export function restampStepStart(run, stepIndex, at) {
  const timings = Array.isArray(run.stepTimings) ? run.stepTimings : [];
  const i = timings.findIndex((t) => t.stepIndex === stepIndex && t.finishedAt === undefined);
  if (i === -1 || Number.isNaN(Date.parse(at))) return run;
  const row = Object.freeze({ step: timings[i].step, stepIndex: timings[i].stepIndex, startedAt: at });
  return { ...run, stepTimings: [...timings.slice(0, i), row, ...timings.slice(i + 1)] };
}

/**
 * STAMP A STEP'S FINISH, only if the `advance` call just moved the cursor past it. PURE-over-its-inputs
 * except for the `clock()` read, which is the one io this whole file threads through instead of hiding
 * (#3368). A step that is still suspended (an effect still `in-flight`, a confirm/judge with no answer yet)
 * leaves `run.cursor` unchanged, so this is a no-op — exactly the "started, not finished" state Done-when #1
 * asks for.
 *
 * @param {object} run - the run AFTER the `advance` call that may have resolved `stepIndex`.
 * @param {number} stepIndex - the step's index BEFORE that `advance` call.
 * @param {() => number} clock
 * @returns {object}
 */
function stampFinish(run, stepIndex, clock) {
  return run.cursor > stepIndex ? withStepFinish(run, { stepIndex, at: new Date(clock()).toISOString() }) : run;
}

/**
 * DRIVE A RUN to its next stop. The whole adapter, in one loop.
 *
 * @param {object} o
 * @param {object} o.run - the run record to drive.
 * @param {object} o.registry
 * @param {{read: Function, write: Function}} o.store
 * @param {Record<string, Function>} o.sinks
 * @param {(request: object) => Promise<object>} o.judge
 * @param {{value: *}|null} [o.resume] - the confirm answer, when one arrived.
 * @param {number} [o.maxTurns]
 * @param {() => number} [o.clock] - mints the instant a step starts/finishes, as epoch ms (#3368). INJECTED so
 *   the engine (and this file) stay testable with deterministic timings — never `Date.now()` read ad hoc. See
 *   `stampStart`/`stampFinish` below and `we:scripts/operations/run-record.mjs#withStepStart`.
 * @returns {Promise<{run: object, stopped: string, error: (Error|null), applied: string[], step?: string,
 *   priorConfirm?: ({step: string, value: *}|null), inFlight?: string[]}>}
 *   `stopped` is one of `'complete'`, `'confirm'`, `'stuck'`, `'effect-halted'`, `'effect-in-flight'` or
 *   `'step-refused'` — the last one is a declaration fn (a `compute`, `judge`, `confirm` or `effect` step)
 *   throwing deterministically once its answer is already committed to the record (#3063). `step` and
 *   `priorConfirm` ride only on `step-refused`, because that is the one stop `renderOutcome` cannot describe
 *   from `{run, stopped, error, applied}` alone — see the file header and #3063 for why.
 */
export async function driveRun({
  run, registry, store, sinks, judge, resume = null, maxTurns = 64, autoConfirm = null, attemptedBy = 'unknown', clock = () => Date.now(),
  // `review.parallelSeats` — see `./parallel-judges.mjs`. OFF by default so every caller that does not ask keeps the
  // sequential drive; the review callers pass the resolved setting. `seatLanes` gives a further tool-bearing seat a
  // lane of its own (absent: it waits for the primary lane). `log` reports seat starts/ends (stderr by default).
  parallelJudges = false, seatLanes = null, log = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* best effort */ } },
} = {}) {
  let current = run;
  let pendingResume = resume;
  const applied = [];
  // Answers a concurrent batch already produced, keyed by step name, consumed as the engine reaches each seat.
  const prefilled = new Map();
  // A seat that ran (and cost something) but whose answer can never be committed — an earlier seat failed, or its
  // request changed — still has its spend recorded, so the run's cost is the cost of every spawn that happened.
  const recordSpentSeats = (rec) => {
    let next = rec;
    for (const seat of prefilled.values()) {
      const telemetry = seat.ok ? unwrapJudgeOutcome(seat.value).telemetry : seat.error?.telemetry;
      if (!telemetry) continue;
      next = { ...next, telemetry: [...(next.telemetry ?? []), normalizeJudgeTelemetry({ step: seat.step, stepIndex: seat.stepIndex, telemetry: { ...telemetry, lens: seat.request?.lens, model: telemetry.servedModel || telemetry.model || seat.request?.model, effort: seat.request?.effort } })] };
    }
    prefilled.clear();
    return next;
  };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const status = runStatus(current, { registry });

    if (status === 'complete') return { run: current, stopped: 'complete', error: null, applied };

    if (status === 'awaiting-confirm') {
      // AN UNATTENDED ANSWER, WHEN AND ONLY WHEN THE DECLARATION SAID AN AGENT MAY GIVE ONE. The policy is
      // INJECTED rather than decided here: this adapter must not know which actor names a declaration uses, and
      // a confirm addressed to a HUMAN must keep stopping — that is the whole point of the step.
      //
      // The seam matters more than the convenience. A caller that wants an unattended loop supplies a policy;
      // a caller that does not gets today's behaviour unchanged, because `autoConfirm` defaults to null. The
      // policy returns `null` to decline, which is how it refuses a human-addressed confirm.
      if (pendingResume == null && typeof autoConfirm === 'function') {
        const auto = autoConfirm(current.pending, current);
        if (auto != null) { pendingResume = auto; }
      }
      // THE STOP. With no answer in hand the adapter returns; the caller prints the question and exits.
      if (pendingResume == null) return { run: current, stopped: 'confirm', error: null, applied };
      const stepIndex = current.cursor;
      current = advance(current, { registry, resume: pendingResume });
      current = stampFinish(current, stepIndex, clock);
      pendingResume = null;
      store.write(current);
      continue;
    }

    if (status === 'awaiting-judge') {
      // THE SPAWN, in the caller, between two `advance` calls — the declaration declared it and did not act.
      // Its cost rides back on the resume; `advance` stamps the row with the request's own lens/model/effort.
      const stepIndex = current.cursor;
      const stepName = current.pending.step;
      // `review.parallelSeats` — start this seat AND every following independent seat together (`./parallel-judges.mjs`).
      // Their answers wait in `prefilled` and are committed below one at a time, in declared order, through the SAME
      // resume as a sequential spawn, so the record differs only in its step timings (which show the real overlap).
      if (parallelJudges && !prefilled.has(stepName)) {
        const batch = planJudgeBatch(current, { registry });
        if (batch.length > 1) {
          log(`parallel seats: run ${current.id} starting ${batch.length} seats together (${batch.map((s) => s.step).join(', ')})`);
          for (const seat of await runJudgeBatch({ batch, judge, clock, seatLanes, log })) prefilled.set(seat.step, seat);
        }
      }
      const pre = prefilled.get(stepName);
      prefilled.delete(stepName);
      let returned;
      let finishedAt = null;
      if (pre && sameJudgeRequest(pre.request, current.pending.request)) {
        // The seat really started when the batch launched it, not when the engine reached it.
        current = restampStepStart(current, stepIndex, new Date(pre.startedAt).toISOString());
        finishedAt = new Date(pre.finishedAt).toISOString();
        if (!pre.ok) {
          const e = pre.error;
          if (e?.telemetry) {
            current = { ...current, telemetry: [...(current.telemetry ?? []), normalizeJudgeTelemetry({ step: stepName, stepIndex, telemetry: { ...e.telemetry, model: e.telemetry.servedModel, lens: current.pending.request?.lens } })] };
          }
          current = recordSpentSeats(current);
          store.write(current);
          throw e;
        }
        returned = pre.value;
      } else {
        if (pre) {
          // Never committed: the request the engine asked for now is not the one the batch answered. Spend recorded,
          // answer discarded, seat spawned again — the safe fallback (see `./parallel-judges.mjs`).
          prefilled.set(stepName, pre);
          current = recordSpentSeats(current);
        }
        try { returned = await judge(current.pending.request); } catch (e) {
          if (e?.telemetry) {
            current = { ...current, telemetry: [...(current.telemetry ?? []), normalizeJudgeTelemetry({ step: current.pending.step, stepIndex, telemetry: { ...e.telemetry, model: e.telemetry.servedModel, lens: current.pending.request?.lens } })] };
            store.write(current);
          }
          throw e;
        }
      }
      const { value, telemetry } = unwrapJudgeOutcome(returned);
      current = advance(current, {
        registry,
        resume: { step: current.pending.step, value, ...(telemetry ? { telemetry } : {}) },
      });
      current = finishedAt
        ? (current.cursor > stepIndex ? withStepFinish(current, { stepIndex, at: finishedAt }) : current)
        : stampFinish(current, stepIndex, clock);
      store.write(current);
      continue;
    }

    if (status === 'awaiting-effect') {
      // THREADED FROM THE ENTRY POINT, which is the only thing that knows. `driveRun` itself cannot tell a
      // person from a network client — it has both callers — so it must be told rather than assume.
      const stepIndex = current.cursor;
      const outcome = await applyPendingEffects(current, { sinks, store, attemptedBy });
      current = outcome.run;
      applied.push(...outcome.applied);
      if (outcome.error) return { run: current, stopped: 'effect-halted', error: outcome.error, applied };
      // PARKED ON A DISPATCH (#3073). An in-flight halt is a SUCCESSFUL stop, not an error: the sink started
      // work that outlives this process, so `error` is null and the halt reports itself through `inFlight`.
      // Without this branch the loop falls through to `advance`, which returns the run UNCHANGED (in-flight
      // counts as unapplied, by design), so the driver spins to `maxTurns` and throws a runaway-loop error —
      // the CLI exits 1 and the HTTP adapter 500s on the one operation the epic exists to reach. It is also
      // (#3368) why THIS step's timing gets no finish here: the dispatch outlives this process, and only
      // `wake.mjs`'s resolve path — the thing that later learns the dispatch is done — may stamp one.
      if (outcome.inFlight && outcome.inFlight.length) {
        return { run: current, stopped: 'effect-in-flight', error: null, applied, inFlight: outcome.inFlight };
      }
      current = advance(current, { registry });
      current = stampFinish(current, stepIndex, clock);
      store.write(current);
      continue;
    }

    // running — THE ONE `advance` CALL THAT EXECUTES A DECLARATION FN (#3063). A `compute` fn, a `judge`
    // `request`, a `confirm` `asks`/`of` or an `effect` `effects` can all throw here, deterministically, once
    // an earlier answer is already committed to the record — see the file header. The `try` is drawn around
    // THIS call only: the other three `advance` calls in this loop (`awaiting-confirm` resume, `awaiting-judge`
    // resume, the post-apply `awaiting-effect` resolve) run `resolvePending`, which executes no declaration fn
    // at all — what THEY throw is a caller error (a malformed resume, an answer outside the closed option set),
    // and folding those into `step-refused` would tell an operator who mistyped `--answer` to start a fresh
    // run, re-spawning the juror this story exists to stop paying for twice. Do not widen this catch.
    const declaration = registry.get(current.op);
    const stepIndex = current.cursor;
    // STAMP THE START before the declaration fn runs (#3368) — a step that throws below still shows as
    // started, and a step that suspends (judge/confirm/effect) carries this stamp into its `pending` record,
    // which is exactly the "halted mid-step" case Done-when #1 asks for: started, and no finish until one of
    // the branches above (or `wake.mjs`, for a dispatch) actually stamps it.
    current = withStepStart(current, { step: declaration.steps[stepIndex]?.name, stepIndex, at: new Date(clock()).toISOString() });
    let next;
    try {
      next = advance(current, { registry });
    } catch (e) {
      store.write(current); // persist the start stamp even though the step refused — started, never finished.
      return {
        run: current,
        stopped: 'step-refused',
        error: e,
        applied,
        step: declaration.steps[stepIndex]?.name,
        priorConfirm: findPriorConfirm(declaration, current, stepIndex),
      };
    }
    // Persisted deliberately (PR #1693 review, finding 3): the start stamp above is real — the declaration
    // fn genuinely began — `advance` just made no progress past it, so recording it is consistent with
    // every other halt this file persists, not a side effect specific to `stuck`.
    if (next === current) { store.write(current); return { run: current, stopped: 'stuck', error: null, applied }; }
    current = stampFinish(next, stepIndex, clock);
    store.write(current);
  }

  throw new Error(`operations: run ${current.id} did not settle within ${maxTurns} turns — refusing to loop further.`);
}

/**
 * THE WHOLE COMMAND LINE for one declaration: parse, start-or-resume, drive, render. Returns the exit code and
 * the lines to print rather than writing them, so a test asserts on values instead of scraping stdout.
 *
 * @param {object} o
 * @param {object} o.declaration
 * @param {string[]} o.argv
 * @param {object} o.registry
 * @param {object} o.store
 * @param {Record<string, Function>} o.sinks
 * @param {Function} [o.judge] - a ready-made judge. Used as-is; the juror flags cannot reach it.
 * @param {(o: {cwd: (string|null), model: (string|null), provider: (string|null)}) => Function} [o.makeJudge] - a judge FACTORY, taking
 *   the parsed juror flags. Preferred over `judge` for a real command line: `--cwd`/`--model` are parsed HERE,
 *   so a caller that pre-builds its judge has no way to honour them (#3151). Falls back to `judge` when absent,
 *   which is why every existing test that injects a canned judge is untouched.
 * @param {() => string} o.newRunId
 * @returns {Promise<{code: number, lines: string[], run: (object|null), stopped: string}>}
 */
export async function runOperationCli({ declaration, argv, registry, store, sinks, judge, makeJudge, newRunId, callLog } = {}) {
  const spec = buildCliSpec(declaration);
  const parsed = parseOperationArgv(declaration, argv);

  if (parsed.control.help) return { code: 0, lines: [spec.usage], run: null, stopped: 'help' };
  if (!parsed.ok) {
    return { code: 2, lines: [...parsed.errors.map((e) => `error: ${e}`), '', spec.usage], run: null, stopped: 'refused' };
  }

  // THE JUDGE IS BUILT AFTER THE PARSE, from the flags the parse produced. Building it before (which `run.mjs`
  // used to do) is what made the juror's lane an environment-only input: there was no later seam at which a
  // `--cwd` could have been honoured, so the flag could not have existed (#3151).
  const activeJudge = typeof makeJudge === 'function'
    ? makeJudge({ cwd: parsed.control.cwd || null, model: parsed.control.model || null, provider: parsed.control.provider || null })
    : judge;

  let run;
  if (parsed.control.resume) {
    run = store.read(parsed.control.resume);
    if (!run) return { code: 2, lines: [`error: no run record for ${JSON.stringify(parsed.control.resume)}`], run: null, stopped: 'refused' };
    if (run.op !== declaration.name) {
      return { code: 2, lines: [`error: run ${run.id} is a \`${run.op}\` run, not \`${declaration.name}\``], run: null, stopped: 'refused' };
    }
  } else {
    run = startRun({ op: declaration.name, id: parsed.control.runId || newRunId(), input: parsed.input, registry });
    store.write(run);
  }

  let resume = null;
  if (parsed.control.answer != null) {
    const status = runStatus(run, { registry });
    if (status !== 'awaiting-confirm') {
      return {
        code: 2,
        lines: [
          `error: run ${run.id} is \`${status}\`, not awaiting a decision — refusing an --answer for a question `
          + 'that has not been asked. Re-run without --answer to drive it to its next stop.',
        ],
        run,
        stopped: 'refused',
      };
    }
    resume = { step: run.pending.step, value: parsed.control.answer };

    // THE CONFIRM-TIME INPUTS, merged onto the run record here — at the confirm, which is the whole point.
    //
    // WHY THEY CANNOT RIDE THE OPENING CALL (the bug this fixes, found reviewing PR #1569). `reason` qualifies
    // an operator's OVERRIDE of the juror, and the only moment anyone can know an override is needed is AFTER
    // `judge` has returned — which is after the initial `--pr=` call, the only call an ordinary input flag may
    // ride. `--resume` refuses input flags by design, so the field was reachable exclusively before the fact it
    // describes existed. A guard whose reason can only be supplied blind is not a guard; the operator's
    // choices were to re-run the whole review and pay a second juror, or bounce with no reason at all.
    //
    // THEY STAY DECLARED INPUTS, and that is the second half of the fix (PR #1572 round 5). The first attempt
    // made `reason` an adapter-only control flag and merged it here just the same — and it STILL did not work,
    // because `projectReads` builds a step's `view.input` from the leaves the step NAMES in `reads`, and a step
    // may only name a field the schema declares. An undeclared value on the record is a value no step can see.
    // So it is merged into `run.input` under a name the declaration carries (`atConfirm`), which is what lets
    // `record` name `input.reason` in its `reads` and actually receive it.
    for (const [field, value] of Object.entries(parsed.control.confirm)) {
      run = { ...run, input: { ...run.input, [field]: value } };
    }
    if (Object.keys(parsed.control.confirm).length) store.write(run);
  }

  // The command line genuinely is a person at a terminal.
  const outcome = await driveRun({ run, registry, store, sinks, judge: activeJudge, resume, attemptedBy: 'human' });
  // #3451 — ONE call-log line per CLI invocation, once the drive actually settled (never on a pre-drive
  // refusal like --help, a bad argv, or a stale --resume — those never reached `driveRun` at all).
  // `callLog` is INJECTED, exactly like `store`: a caller that does not need it (most tests) passes
  // nothing and this stays a no-op; `run.mjs` wires the real file-backed store for actual CLI use.
  // BEST-EFFORT (review finding): a telemetry write must never crash a call that otherwise settled
  // cleanly — a bad `verdict` shape or a disk fault here is not the caller's problem.
  try {
    callLog?.append({
      operation: declaration.name,
      callerKind: 'cli',
      source: { stopped: outcome.stopped, error: outcome.error, pending: outcome.run.pending, verdict: outcome.run.verdict },
    });
  } catch { /* best-effort call-visibility signal; never fails the call it describes */ }
  return { ...renderOutcome({ outcome, json: parsed.control.json, declaration }), run: outcome.run, stopped: outcome.stopped };
}

/**
 * WHAT THE RUN'S JURORS COST, as operator-facing lines. PURE; `[]` when the run spawned none (so a stub-judged
 * run and a pre-telemetry record both render exactly as they did before).
 *
 * PRINTED AT EVERY STOP, INCLUDING THE CONFIRM. The confirm suspend is where it matters most: the juror has
 * already run and been paid for, and the operator is about to decide whether to spend more. A cost figure that
 * only appeared on `complete` would arrive after the decision it informs.
 */
export function renderSpendLines(run) {
  const rows = Array.isArray(run?.telemetry) ? run.telemetry : [];
  if (!rows.length) return [];
  const total = totalJudgeSpend(run);
  const per = rows.map((r) => {
    const bits = [
      `$${(r.costUsd ?? 0).toFixed(4)}`,
      `${((r.wallMs ?? r.durationMs ?? 0) / 1000).toFixed(1)}s`,
      r.model ? `model ${r.model}` : '',
      typeof r.loadedContextTokens === 'number' ? `${r.loadedContextTokens} ctx tokens` : '',
      r.sessionId ? `session ${r.sessionId}` : '',
    ].filter(Boolean);
    return `  ${r.step}${r.lens ? ` (${r.lens})` : ''}: ${bits.join(' · ')}`;
  });
  return [
    `judge spend: $${total.costUsd.toFixed(4)} over ${total.jurors} juror(s), ${(total.wallMs / 1000).toFixed(1)}s wall`,
    ...per,
  ];
}

/**
 * THE MACHINE-READABLE OUTCOME of a run, as one object. PURE.
 *
 * EXPORTED because it is the envelope, not the command line's private rendering: `--json` prints exactly this,
 * and #3036's HTTP adapter returns exactly this (plus its own `persisted` flag). One declaration describing an
 * operation and then two callers describing its OUTCOME two different ways would be the same defect one layer
 * down — a console reading the HTTP route and a terminal reading `--json` must not have to parse two shapes.
 *
 * @param {{run: object, stopped: string, error?: (Error|null), applied?: string[], inFlight?: string[],
 *          ownedBy?: (string|null)}} outcome
 * @returns {object}
 */
export function outcomePayload({ run, stopped, error = null, applied = [], ownedBy = null, step = null }) {
  // #3316 — THE SKILL THAT OWNS THE REST OF THE RUN, for the headless caller. The engine stamps it onto
  // `pending`, so a suspend carries it on the record itself and every route that echoes the record gets it
  // free. That is not enough on its own: a `step-refused` stop clears `pending`, and a refusal is exactly the
  // moment the pointer is most needed. So the declaration is the second source, and the record wins when both
  // are present because the record is what a run was actually suspended with.
  //
  // OMITTED, NOT `null`, when nothing is declared — same reason as {@link ../engine.mjs pendingOn}: every
  // operation that owns no skill emits the byte-identical payload it emitted before this field existed.
  const owner = run.pending?.ownedBy ?? ownedBy ?? null;
  return {
    runId: run.id, op: run.op, stopped, applied,
    // WHICH STEP refused — carried on a `step-refused` stop so a headless caller (the build daemon) can name it
    // instead of reporting "no verdict". Omitted on every other stop, so their payloads stay byte-identical.
    ...(stopped === 'step-refused' && step ? { step: String(step) } : {}),
    ...(owner ? { ownedBy: owner } : {}),
    // #3073 — WHICH effects are still going, so a consumer does not have to re-scan `run.effects` to find out
    // why a parked run is parked.
    //
    // DERIVED FROM THE RECORD, never passed in (PR #1180 review, finding 1). The first cut took it as a
    // parameter, so `GET …/runs/<id>` — which builds this payload with no drive behind it — reported `[]` for
    // a parked run. On that route `[]` stopped meaning "nothing is in flight", and since the payload carries
    // no `effects` either, there was no way to recover a parked run's handle over HTTP at all. Reading the
    // record answers the same on every route.
    inFlight: run.effects.filter((e) => e.status === 'in-flight').map((e) => e.key),
    pending: run.pending, verdict: run.verdict, findings: run.findings,
    // The meter, and its total pre-summed — a consumer must not have to re-derive "what did this cost".
    telemetry: run.telemetry ?? [], spend: totalJudgeSpend(run),
    ...(error ? { error: String(error.message ?? error) } : {}),
  };
}

/**
 * The command line that starts THIS run again from its own recorded input. PURE.
 *
 * `buildCliSpec` derives every flag straight from `declaration.input`'s keys and refuses one that collides
 * with a control flag (`:59-65`), so `run.input`'s own keys can never render an ambiguous line — field names
 * map 1:1 to flags. Exported so `step-refused`'s restart line is asserted directly, not scraped from prose.
 *
 * IT MUST ROUND-TRIP THROUGH {@link parseOperationArgv}, and once it did not (PR #1572 round 5, finding 2).
 * `run.input` holds the CONFIRM-TIME fields too, merged there at the resume, and echoing every key blindly
 * emitted a line carrying `--reason=…` with no `--answer` — which this adapter's own parser then refuses. A
 * recovery command the tool rejects when you paste it back is worse than no recovery line: the operator is
 * refused twice and the second refusal looks like their typo. So the flag list is built from the DECLARATION,
 * and confirm-time fields are dropped: a restart starts a NEW run, which has not yet reached the confirm those
 * values qualify, so they could not be passed on this line even in principle.
 *
 * @param {object} run
 * @param {object} [declaration] - the run's declaration. Omitted, every input key is echoed (the old
 *   behaviour, still correct for a declaration with no confirm-time field).
 * @returns {string}
 */
export function restartCommand(run, declaration = null) {
  const skip = new Set(declaration ? confirmTimeFields(declaration) : []);
  const flags = Object.entries(run.input ?? {})
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => `--${key}=${value}`);
  return [`node scripts/operations/run.mjs`, run.op, ...flags].join(' ');
}

const RUN_SUMMARIES = {
  'open-pr': (payload) => describeSubmit(extractSubmitResult(payload)),
};

/** Applied effects whose recorded result refused or failed, including on a finished-run resume. PURE. */
export function refusedEffects(run) {
  return run.effects.filter((e) => e.status === 'applied'
    && (e.result?.outcome === 'refused' || e.result?.outcome === 'failed'));
}

/** Turn a `driveRun` outcome into exit code + lines. PURE. */
export function renderOutcome({ outcome, json = false, declaration = null }) {
  const { run, stopped, error, applied } = outcome;
  // #3316 — the declaration is the fallback source for the pointer, and the ONLY one on a `step-refused` stop,
  // where `pending` has already been cleared.
  const ownedBy = run.pending?.ownedBy ?? declaration?.ownedBy ?? null;
  if (json) {
    return {
      // A dispatch park is a SUCCESSFUL stop, exactly like a confirm suspend — the run did what was asked.
      code: stopped === 'complete' || stopped === 'confirm' || stopped === 'effect-in-flight' ? 0 : 1,
      lines: [JSON.stringify(outcomePayload({ ...outcome, ownedBy }), null, 2)],
    };
  }

  const spend = renderSpendLines(run);
  // The one line a caller who has NOT read the skill needs, printed at every stop that leaves them holding a
  // run they cannot finish from what is on screen. Placed last on purpose: it is where the eye lands, and it
  // is the pointer out of the dead end rather than one more fact about the run.
  const ownerLines = ownedBy ? ['', `the rest of this run is owned by ${ownedBy} — read it before deciding.`] : [];

  if (stopped === 'confirm') {
    const p = run.pending;
    return {
      code: 0,
      lines: [
        `run ${run.id} — SUSPENDED at \`${p.step}\`, awaiting a decision from: ${p.of}`,
        '',
        // The material the decision is made ON, not just the question — otherwise the caller has to go and
        // fetch it, which is the restating-the-flow the skill is being freed from.
        ...(run.verdict != null ? ['verdict:', JSON.stringify(run.verdict, null, 2), ''] : []),
        ...(spend.length ? [...spend, ''] : []),
        p.asks,
        '',
        ...(p.options ? [`options: ${p.options.join(' | ')}`, ''] : []),
        `resume with: node scripts/operations/run.mjs ${run.op} --resume=${run.id} --answer=<option>`,
        ...ownerLines,
      ],
    };
  }
  if (stopped === 'complete') {
    const summary = Object.hasOwn(RUN_SUMMARIES, run.op)
      ? RUN_SUMMARIES[run.op]({ findings: run.findings, stopped }) : null;
    const refused = refusedEffects(run);
    if (refused.length) {
      return {
        code: 1,
        lines: [
          `run ${run.id} — complete, but ${refused.length} effect(s) were REFUSED/FAILED — nothing they asked for happened.`,
          ...refused.flatMap(({ type, step, result }) => [
            `  ${type} (step ${step}): ${result.outcome} — ${result.reason}`,
            ...(result.detail != null ? [`    detail: ${result.detail}`] : []),
            ...(result.pr != null ? [`    pr: ${result.pr}${result.url ? ` ${result.url}` : ''}`] : []),
          ]),
          // Keep the existing operation-specific refusal summary (#4386) for its consumers.
          ...(summary?.failed ? [summary.line] : []),
          ...spend,
          ...ownerLines,
        ],
      };
    }
    if (summary) return { code: summary.failed ? 1 : 0, lines: [`run ${run.id} — ${summary.line}`, ...spend] };
    return { code: 0, lines: [`run ${run.id} — complete. ${applied.length} effect(s) applied.`, ...spend] };
  }
  // PARKED, NOT FAILED (#3073). Exit 0 — the run did exactly what it was asked to: it started work that
  // outlives this process, and stopped. Exiting 1 would tell every caller a successful dispatch is an error.
  // The lines name the handle, because that is what an observer polls, and the deadline, because "still
  // running" and "probably dead" need opposite responses.
  if (stopped === 'effect-in-flight') {
    const { running, overdue, unknown } = inFlightEntries(run);
    const describe = (e) => `  ${e.key} (${e.type}) — handle ${e.handle ?? '(none)'}`
      + `${e.expectedBy ? `, expected by ${e.expectedBy}` : ', no deadline'}`;
    return {
      code: 0,
      lines: [
        `run ${run.id} — PARKED at \`${run.pending?.step}\`: work is in flight and its outcome arrives later.`,
        ...(running.length ? ['in flight:', ...running.map(describe)] : []),
        ...(overdue.length ? ['OVERDUE — past its own expectedBy:', ...overdue.map(describe)] : []),
        ...(unknown.length ? ['UNKNOWN — dispatched but no handle, so it cannot be observed:', ...unknown.map(describe)] : []),
        // FROM THE RECORD, not from this drive (PR #1180 review, finding 4). `applied` counts what THIS
        // drive applied, and the re-drive is the path the next line steers the operator onto — so on the
        // drive they actually run, a drive-local count says "0 effect(s) landed" about a record holding one.
        `${run.effects.filter((e) => e.status === 'applied').length} effect(s) have landed and are recorded as applied.`,
        `resume with: node scripts/operations/run.mjs ${run.op} --resume=${run.id} — it reports the same park `
        + 'until the work reports back, and never re-dispatches.',
        ...spend,
        ...ownerLines,
      ],
    };
  }
  if (stopped === 'effect-halted') {
    return {
      code: 1,
      lines: [
        `run ${run.id} — HALTED applying \`${run.pending?.step}\`: ${String(error?.message ?? error)}`,
        `${applied.length} effect(s) landed and are recorded as applied; a --resume=${run.id} continues from there `
        + 'and never re-applies them.',
        ...spend,
        ...ownerLines,
      ],
    };
  }
  // A DECLARATION FN REFUSED, DETERMINISTICALLY, ONCE ITS INPUT WAS ALREADY COMMITTED (#3063). `outcome.step`
  // names the refusing step — NOT `run.pending?.step`, which is `null` here (the confirm that led here already
  // cleared it). The prior-`confirm` lines are gated on `outcome.priorConfirm`: this stop never claims a
  // decision was made when the refusal is the FIRST step's own doing. The restart line is unconditional —
  // it is the one thing true on every path, deterministic or not.
  if (stopped === 'step-refused') {
    const priorConfirm = outcome.priorConfirm ?? null;
    return {
      code: 1,
      lines: [
        `run ${run.id} — REFUSED at \`${outcome.step}\`: ${String(error?.message ?? error)}`,
        ...(priorConfirm ? [
          `the answer recorded at \`${priorConfirm.step}\` is \`${priorConfirm.value}\`; it is committed, and a `
          + '--resume replays this same step with it.',
          'if this refusal is deterministic the run cannot reach another answer — start a fresh one:',
        ] : []),
        `  ${restartCommand(run, declaration)}`,
        ...spend,
        ...ownerLines,
      ],
    };
  }
  return { code: 1, lines: [`run ${run.id} — ${stopped}.`, ...spend, ...ownerLines] };
}
